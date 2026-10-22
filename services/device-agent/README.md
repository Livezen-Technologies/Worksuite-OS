# worksuite-device-agent

Root-owned OS implementation of the WorkSuite Device Agent (SRS §9.3, §14.3) over the existing
`desktop/v1/devices/*` endpoints: `register` (enrollment, key pair TPM-backed when available),
`heartbeat` (inventory, OS/shell/kernel versions, update status, observed policy state) and
`commands/{id}/ack`, plus `desktop/v1/policies`, `os/inventory` and `os/diagnostics`.

## Layout

| File | Role |
| --- | --- |
| `src/agent.ts` | Core: enroll, verify and apply signed policy, check-in, run commands with acks, wipe, offline kill timer |
| `src/commands.ts` | Envelope validation (below) |
| `src/host.ts` | Linux effects: key generation, inventory, `loginctl`, package service over `busctl`, `shutdown -r`, `cryptsetup erase` |
| `src/state.ts` | `/var/lib/worksuite-device-agent/state.json` (0600): enrollment, policy, seen command ids, unsent acks |
| `src/api.ts` | `desktop/v1` client; https only; `X-WS-Device` on every call after enrollment |
| `src/main.ts` | Daemon (check-in every 15 min, policy hourly, inventory daily, jittered) and CLI |

## Local interface

- **Enroll**: `pkexec worksuite-device-agent enroll --server https://…` with the enrollment token on stdin (never in
  argv). polkit action `lk.worksuite.device.enroll` (admin). The CLI talks to the daemon over the root-only socket
  `/run/worksuite-device-agent/control.sock`; `status` and `refresh` work the same way.
- **Read by users** (0644, no secrets beyond the device credential): `/run/worksuite-device-agent/status.json` (managed,
  organization, policy summary, last check-in, wipe capability — WSOS-MDM-007, WSOS-WIPE-007), `policy.json`
  (effective signed policy), `device-token`.
- `dbus/lk.worksuite.DeviceAgent1.xml` describes the equivalent system-bus API for a later release; it is not served.

## Policy

`desktop/v1/policies` must carry `signature: "<key_id>:<base64 Ed25519>"` over the canonical JSON of the policy without
that field, made with a key in `/usr/share/worksuite/keys/device-commands/<key_id>.pem` (the same keys sign commands).
An unsigned or tampered policy is rejected and the previous one stays in force.

## Remote commands (WSOS-MDM-003) — the complete list

`RefreshPolicy`, `InstallApprovedApplication {catalog_id}`, `RemoveApplication {catalog_id}`, `ScheduleUpdate`, `RequestLock`,
`RebootDuringWindow`, `CollectApprovedDiagnostics {bundle_profile}`, `RemoteWipe {scope: worksuite_data|full_device, approval_id}`.
`StartMalwareScan {kind: quick|full}`, `IsolateEndpoint {hours: 1–72}`, `ReleaseIsolation`, `RestoreQuarantined {quarantine_id, force?}`,
`DeleteQuarantined {quarantine_id}`, `ResolveSuspendedProcess {event_id, action: resume|terminate}` (WorkSuite Security, below).
There is no shell, exec or file-read command (WSOS-MDM-006). Anything else is rejected `UNKNOWN_COMMAND`.

`RemoteSupportRequest {session_id, mode: view|control, reason, admin_name, org_name, unattended?}` and
`RemoteSupportEnd {session_id}` (max TTL 4 h; the session ends at the request's expiry) — see Remote support below.

## Remote support consent (issue #19) — `src/remoteSupport.ts`

Requests are polled every 10 s (`desktop/v1/os/remote-support/commands`), validated like every command, then:

- **Attended (default)**: nothing is shared until the active seat0 user answers the shell's consent dialog
  (*Allow screen sharing* / *Allow remote control* / *Deny*). `remote-support.json` (0644) describes the request
  (administrator, organization, access level, reason, session id); the dialog's nonce is in `consent/<uid>`, 0400 and
  owned by the seat user, and `Decide` on `remote-support.sock` (0666) must present it. The grant never exceeds the
  request. No answer in 2 minutes = denied; nobody signed in = `no_user`.
- **While active** the shell shows an indicator. Anyone at the device may `RevokeControl` (drop to view only) or
  `End` without a nonce; ending stops every portal stream (`worksuite-screencast-stop` in the seat user's session).
- **Unattended**: only when the server marks the request eligible (org policy `remote_support.unattended` and a
  corporate-owned device) *and* this device's signed policy says `remote_support.unattended: true`. It is disclosed
  in `status.json` (`policies.remote_support_unattended`, shown in Settings) and the indicator is still shown.
- Each transition is audited locally (`remote_support_*`) and reported to
  `desktop/v1/os/remote-support/sessions/{id}/state`.

Screen and input streaming itself goes through the ScreenCast/RemoteDesktop portals in the user's session, which
keep their own per-request consent; the agent never captures the screen or injects input.

## Envelope validation — `src/commands.ts`

Order: shape → allow-list → signature present → Ed25519 signature over canonical JSON (sorted keys, signature
excluded) with a server key → device binding (`device_id` = enrolled id) → issued/expiry (5 min skew; per-command
max TTL, RemoteWipe ≤ 30 days) → args → replay (single-use id, remembered until expiry). Acceptance records the id;
each result is acked with `devices/commands/{id}/ack` as `received` → `completed|failed`, or `rejected` with the
reason. Acks that cannot be sent are queued in state and delivered first on the next check-in.

- `InstallApprovedApplication` runs only if the id (`apt:…`, `flatpak:…`, `worksuite:…`) is also in the device's
  signed `app_allowlist`; installs go through `lk.worksuite.PackageService1`.
- `RemoveApplication` (Software Management remote uninstall) takes an `apt:` or `flatpak:` id; the package service
  still refuses the critical set. Both wait for the package job's `JobFinished` (`src/packageJob.ts`), so the ack is
  `completed` only when the change really happened (else `failed` with the service's reason), then send a fresh
  inventory so the console's Software Management view is current.
- `RebootDuringWindow` needs a policy `maintenance_window` (`HH:MM-HH:MM`) and schedules `shutdown -r` at its start.
- `CollectApprovedDiagnostics` accepts the fixed profiles in `src/diagnostics.ts`, which the admin console offers
  (any other name is rejected `BAD_ARGS`). No user files and no secrets (no NetworkManager connection files; user and
  password are removed from URLs):
  - `basic`: os-release, kernel, failed units;
  - `session`: `basic` plus 24 h of `worksuite-*` unit logs;
  - `network`: `basic` plus `ip -j address`/`route` (IPv4 and IPv6), `/etc/resolv.conf`, NetworkManager device states,
    `nmcli networking connectivity check`, and a DNS lookup of the update host;
  - `update`: `basic` plus the package service's update status (state, ring, offered/installed version, last check,
    reason), `/etc/worksuite/updates.json` (host, ring, mode), the WorkSuite APT source and 24 h of
    `worksuite-package-service` logs.

## WorkSuite Security (issue #20) — `src/security.ts`, `src/securityCenter.ts`, `src/securityHost.ts`

- **Firewall**: the packaged `/etc/nftables.conf` (table `inet worksuite_filter`, inbound default-deny) is unchanged.
  The policy's `firewall_outbound_block` (IPv4/IPv6 addresses or CIDRs) becomes the agent's own table
  `inet worksuite_policy` in `/etc/worksuite/nftables.d/50-policy.nft`, loaded at once and at boot (glob include in
  `nftables.conf`). It only narrows what the default allows. `firewall_log_blocked` adds a rate-limited log rule; the
  agent reads those kernel log lines into firewall alerts (destination, port, protocol; no payload).
- **Isolation** (`IsolateEndpoint`): everything is dropped except loopback, established replies, DHCP, DNS and HTTPS to
  the management server's addresses, so check-ins and `ReleaseIsolation` still arrive. Refused (`NO_MANAGEMENT_PATH`)
  if the server name does not resolve; ends on its own after at most 72 hours (lockout safeguard). The console asks for
  the administrator's password and the device name.
- **Antivirus** (ClamAV, `clamav`/`clamav-freshclam` recommended): signature checks per day from policy via
  `/etc/worksuite/freshclam.env` (read by the packaged `clamav-freshclam.service.d/worksuite.conf`); a failed updater
  is restarted at most hourly, a stopped one too, and one without signatures yet every half hour (the image enables
  `clamav-freshclam.service` but ships no signatures; until freshclam has reached the mirror scans refuse with
  `NO_SIGNATURES` and Settings offers *Update definitions*). Scheduled scans (`av_scan_schedule`, `av_scan_hour`) start
  only when every graphical session is idle, load is low and the device is on mains power. A **quick scan** covers each
  person's Downloads, Desktop, Documents, `~/.config/autostart`, `~/.local/bin`, `~/.local/share/applications`, `/tmp`,
  `/var/tmp`, `/dev/shm` and `/etc/xdg/autostart`; a **full scan** covers `av_scan_paths` (default `/`) without `/proc`,
  `/sys`, `/dev`, `/run`, the quarantine, network and pseudo file systems (from `/proc/self/mounts`). Scans run as the
  transient unit `worksuite-av-scan.service` (`systemd-run`, `Nice=19`, idle I/O, `CPUQuota=av_cpu_quota_percent`)
  outside the agent's sandbox, one at a time; `clamscan --recursive --stdout` reports each file, which gives the
  progress (files, current path, elapsed) in `security.json`. Cancel stops the unit; what was found so far is still
  quarantined. Exit 2 fails the scan only when nothing was scanned or the engine could not load its signatures.
  Exclusions come only from policy.
- **Quarantine**: detections are moved to `/var/lib/worksuite-device-agent/quarantine/` (0700, file mode 000) with a
  root-only metadata record; nothing is uploaded. A file that cannot be moved stays listed as needing action.
- **Status**: `/run/worksuite-device-agent/security.json` (0644) for Settings › Privacy & security › WorkSuite Security,
  and the same summary in each heartbeat for Admin Center › Security Center. History older than
  `security_log_retention_days` is dropped. Every action is in the agent's audit log.
- **Scan now**: `lk.worksuite.DeviceAgent1.StartSecurityScan(kind)` behind polkit `lk.worksuite.security.scan`; it
  returns once the scan has started or fails with why it cannot (`NO_SIGNATURES`, `ANTIVIRUS_MISSING`,
  `ANTIVIRUS_DISABLED`). `CancelSecurityScan` and `UpdateSecurityDefinitions` (restarts freshclam, which checks at
  once) use the same action. #68: without definitions the reason is the updater's real state —
  `SIGNATURES_DOWNLOADING` (freshclam runs; a stopped one is started at once, at most every 2 minutes),
  `UPDATER_FAILED`, `UPDATER_MISSING` — and a failing engine probe is `ENGINE_CHECK_FAILED`. Settings shows each in
  words (any other code is shown by name), says whether automatic updates stopped, failed or are missing, and offers
  *Update definitions* whenever the updater isn't running. The image creates `/var/lib/clamav` and `/var/log/clamav`
  for the clamav user at boot (`/etc/tmpfiles.d/worksuite-clamav.conf`), without which freshclam refuses to start.

### Protection layers (issue #38) — `src/protection.ts`, `native/guard/`

- **Real-time protection** (`realtime_protection`, `realtime_prevention`, `realtime_paths`; off unless the policy turns
  it on, since clamd needs about 1 GB): `/etc/worksuite/clamd-onaccess.conf` for `worksuite-onaccess.service`
  (clamonacc on fanotify, files passed to clamd by descriptor; includes the paths and every `~/Downloads`). The agent
  follows the unit's journal: a `FOUND` line becomes an event, the file goes to quarantine and the shell notifies.
- **Protected folders and ransomware** (`protected_folders` with `~/` per user, `protected_folders_mode: block|audit`,
  `protected_folders_allow`, `ransomware_burst {count, seconds}`): `/etc/worksuite/guard.conf` for
  `worksuite-guard.service` (`native/guard/worksuite-guard.c`). Opening a file in a protected folder for writing is
  refused unless the program is a root-owned, non-writable system/app executable outside the user trees, or allowed
  by policy. A process renaming/deleting (or, if untrusted, writing) more than the burst threshold is suspended
  (SIGSTOP); Settings or the console resumes or ends it (pid + start time checked, so a reused pid is never signalled).
- **Application control** (`app_denylist`: absolute paths or SHA-256): enforced by the same helper on
  `FAN_OPEN_EXEC_PERM`, on top of `app_allowlist` for installs.
- **Web & downloads**: `dns_blocklist` and `dns_threat_feeds` → `/etc/NetworkManager/dnsmasq.d/worksuite-blocklist.conf`
  (NXDOMAIN) with `dns=dnsmasq` in `conf.d/50-worksuite-dns.conf`, then `nmcli general reload conf dns-full`. New files
  in every `~/Downloads` are scanned (clamd when it runs, else clamscan) and quarantined (`download_scan`, on by default).
- **Threat-intel feeds** (`firewall_threat_feeds`, `firewall_threat_max_entries`): https only, each feed pinned by
  `sha256` or signed (`key`: Ed25519 public key, signature at `<url>.sig`); refreshed every 6 hours, merged into the
  `threat_v4`/`threat_v6` interval sets of `inet worksuite_policy` (both directions). Private, loopback and too-wide
  ranges and the management server are never added; a failing feed keeps the last good list.
- **Quarantine**: restore re-scans a copy first and refuses a file that is still detected (only the administrator's
  signed `RestoreQuarantined` with `force` overrides), then puts it back with its owner and mode; delete removes it.
  Locally: `RestoreQuarantined`, `DeleteQuarantined`, `ResolveSuspendedProcess` behind `lk.worksuite.security.quarantine`.
- **Security patches** (`security_auto_patch: immediate|window|off`) are applied by the package service's update
  coordinator (`services/package-service/src/updates.ts`).

## Remote wipe (§14.3)

1. `received`, then `started` must reach the server before anything is destroyed (WSOS-WIPE-005). If `started`
   can't be sent, nothing is touched and the command id is released so the server's redelivery runs.
2. WorkSuite data wipe: sign all users out, remove `~/.config/worksuite`, `~/.local/state/worksuite`,
   `~/.local/share/worksuite`, `~/.cache/worksuite` and `~/WorkSuite Drive` for every user, withdraw the device
   credential, ack `completed`, unenroll locally.
3. Full device wipe: refused with `NOT_ENCRYPTED` unless `/` is on LUKS (WSOS-WIPE-003); otherwise data wipe, then
   `cryptsetup erase` on every LUKS device (all key slots, including TPM-bound ones) and header backups, then reboot.
   No `completed` from the device: the server marks it on re-enrollment.
4. Offline kill timer (WSOS-WIPE-006): with `offline_wipe_days` in policy, a WorkSuite data wipe runs once after that
   many days without a successful check-in.

Known gaps: the device key is a file in the 0700 state directory, not TPM-backed yet; keyring entries holding
refresh tokens can't be removed while a user's keyring is locked (the server revokes the device's sessions instead);
"reboot to the installer" after a full wipe relies on the boot menu, not a dedicated boot entry.

`npm test` runs the command-validation and agent tests (node:test, Node ≥ 22.18, no dependencies).

## Device credential for user services

After `devices/register`, the agent publishes the device credential at `/run/worksuite-device-agent/device-token`
(`RuntimeDirectory=worksuite-device-agent`, file mode 0644) so the user-level sync service and credentials broker can
send `X-WS-Device` (WSOS-IDN-005). It identifies the device, not a user; the private key stays in the agent's state
directory (or TPM). The file is removed on unenrollment, revocation and wipe.

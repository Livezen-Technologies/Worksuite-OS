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
There is no shell, exec or file-read command (WSOS-MDM-006). Anything else is rejected `UNKNOWN_COMMAND`.

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

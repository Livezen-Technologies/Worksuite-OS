# Break-glass local admin (`wsadmin`, WSOS-DIR-010)

`wsadmin` is the local administrator for when directory sign-in cannot be used (server down, device off the
network, directory account broken). Its password is random, known to nobody on the device, escrowed encrypted to the
organization's key on the WorkSuite server, and valid for one session. This page describes what the OS actually does
today, with code references. Anything marked **Gap** is not implemented.

Code: `services/directory/src/directory.ts` (`session()`, `rotate()`, `newPassword()`, `encryptToEscrow()`),
`services/directory/src/main.ts` (HTTP client, file store, system accounts), `packaging/debian/worksuite-directory.postinst`,
`services/directory/pam/worksuite-directory`, `services/directory/sudoers/worksuite-breakglass`,
`services/directory/systemd/worksuite-breakglass-rotate.{service,timer}`, greeter
`services/session/greeter/worksuite_greeter/login.py` (G04 section). Reference server:
`services/server/src/api.ts` (`/desktop/v1/os/break-glass*`).

## Account

- Created by postinst on first configure: a system account (UID 999 or the next free one below 1000) with a home in
  `/home/wsadmin`, shell `/bin/bash`, member of `sudo`, and **locked** (`usermod --lock`). Locked means no password
  works until a rotation has escrowed one.
- Upgrades: postinst only creates the account when it is missing, and only moves an older regular-user `wsadmin`
  (UID >= 1000, no running processes) to a system UID. It never locks, unlocks or sets the password of an existing
  account, so the password already escrowed on the server keeps working after an upgrade
  (`tests/session/breakglass-admin.test.sh`, `tests/session/breakglass-uid.test.sh`). No `dpkg --compare-versions`
  branch is needed: every step is conditional on the current state, and re-running `configure` is a no-op apart from
  `pam-auth-update --package`.
- The device agent never lets kiosk mode run as `wsadmin` (`services/device-agent/src/kiosk.ts`).

## Password generation

`newPassword()`: 24 characters from a 57-character unambiguous alphabet (no `0O1lI`), drawn from `crypto.randomBytes`
with rejection sampling (no modulo bias), about 139 bits. The password exists only in the helper's memory and is
handed to `chpasswd` on stdin; it never reaches argv, the environment, logs or disk (test: "the password never
appears in logs", and the break-glass test checks the logs for the plaintext).

## Escrow

`rotate()` (run by `worksuite-breakglass-rotate.service` as root, AppArmor profile `worksuite-directory`):

1. `GET desktop/v1/os/directory` for the directory settings; uses `escrow_public_key` (PEM, RSA). No key → step 4.
2. Encrypts the password with RSA-OAEP, SHA-256 (`encryptToEscrow()`), base64.
3. `POST desktop/v1/os/break-glass` with `{ username: "wsadmin", encrypted_secret, rotated_at }`.
4. Only after the server accepted it: `chpasswd`, `usermod --unlock`, audit event `rotated`. If anything in 1-3
   fails (offline, not enrolled, no key, HTTP error), the account is locked and the old password is never re-enabled.

Transport and authentication (`httpServer()` in `main.ts`): the server URL and device credential come from the device
agent's enrollment state (`/var/lib/worksuite-device-agent/state.json`); HTTPS only (`INSECURE_URL` otherwise), no
redirects, 10 s timeout, header `x-ws-device: <device credential>`, an `idempotency-key` per request. The secret is
confidential end to end: TLS on the wire, and the server only stores the ciphertext; only the holder of the
organization's private key can decrypt it. The reference server keeps one row per device (`break_glass` table, upsert)
and shows "escrowed" in the console (`console.ts`, `break_glass_escrowed`).

**Gap:** the escrow is posted before `chpasswd`. If `chpasswd` then fails, the server holds a password that was never
set. The helper then stops before `usermod --unlock`, so the account stays locked (no lockout of anything else),
but the escrowed value is wrong until the next successful rotation.

## Rotation

| When | How |
|---|---|
| After every use | The PAM session hook (`pam_exec ... worksuite-pam-directory session`, only for `wsadmin`, open_session only) locks the password at once, records `used`, then `systemctl start --no-block worksuite-breakglass-rotate.service`. Each escrowed password therefore works for exactly one session. |
| On a schedule | `worksuite-breakglass-rotate.timer`: 2 min after boot and every 30 days (`Persistent=true`). |
| Only on enrolled devices | `ConditionPathExists=/var/lib/worksuite-device-agent/state.json`; elsewhere the account stays locked. |
| On a server command | **Gap:** there is no "rotate break-glass" device command; an admin cannot force a rotation remotely. |
| After a reveal | **Gap:** the OS is not told when a password is revealed. Use already invalidates it, so a revealed but unused password stays valid until the next scheduled rotation (at most 30 days or the next boot). |

## Reveal (server side, out of scope here)

The OS expects:

- the server to store `encrypted_secret` per device and replace it on each `POST desktop/v1/os/break-glass`;
- decryption to happen only with the organization's escrow private key, outside the device (the matching public key is
  `escrow_public_key` in the directory settings);
- every reveal to be restricted to authorized admins and audited on the server.

**Gap:** the reference server in this repository stores the ciphertext but has no reveal endpoint or console action;
who may reveal and how is defined by the production server, not by this repo.

## Logging every use

| Record | Where | Code |
|---|---|---|
| `break-glass: wsadmin session opened; password invalidated, rotation started` | journal, `authpriv.notice`, tag `worksuite-directory` | `session()`, `journal()` |
| `break_glass.used` event `{ id, type: "used", username, at, reason? }` | `POST desktop/v1/os/break-glass/events` (device credential, idempotent; server writes it to `audit` under `device:<id>`) | `session()`, `audit()`, `flush()` |
| `break_glass.rotated` event | same endpoint | `rotate()` |
| Reason typed at the greeter (G04) | sent with the `used` event, control characters stripped, max 200 chars; read once from `/run/worksuite/break-glass/reason` and deleted | `takeBreakGlassReason()` |
| Every sudo command (user, tty, cwd, command) | journal, `authpriv` (sudo's default syslog logging, all users) | sudo defaults |
| Terminal output of every `sudo` run by `wsadmin` | `/var/log/sudo-io` (root only), replay with `sudoreplay` | `sudoers/worksuite-breakglass`: `Defaults:wsadmin log_output` |
| PAM sign-in / session lines | journal (`pam_unix`, greetd, login) | system |

Why `log_output` and not more: it is scoped to `wsadmin` only (no global sudo default changes), and records what was
done with root rights. `log_input` is not set because it would record typed passwords. No separate `logfile` is set:
the journal already has the command log, and a second file would only duplicate it.

The event transport is the directory helper's own queue, not a new one: events go to
`/var/lib/worksuite-directory/pending-events.json` (0600) first and are sent with the device agent's enrollment
credential to the server; failed sends stay queued. The device agent process itself does not carry these events.

## Offline

- **Use while offline:** the password still works (it is a local `pam_unix` hash), the session hook still locks it
  at once and queues `used`. The rotation it starts cannot escrow, so the account stays locked: no second use is
  possible until the device is back online and a rotation succeeds.
- **Queued events** are retried whenever the helper runs `session()` or `rotate()` (both call `flush()`, also on a
  failed rotation). Test: "a use while offline is queued and the next rotation delivers it before its own event".
- **Gap:** after an offline use the next retry is the next boot or the 30-day timer; there is no retry when the
  network comes back. Until then the server does not know about the use, and the account is locked.
- **Never escrowed** (new device offline, or org without `escrow_public_key`): the account stays locked. The
  other recovery path is the Recovery boot entry (`worksuite-recovery-boot`: the recovery shell runs as
  `worksuite-recovery` through PAM service `login`, admin steps go through polkit), plus reinstall keeping `/home`.

## Interactive login restriction

`pam/worksuite-directory`, `Account` section (added to `common-account` by `pam-auth-update`):

```
[success=1 default=ignore]  pam_succeed_if.so quiet user != wsadmin
requisite                   pam_succeed_if.so quiet service notin sshd:xrdp-sesman:cockpit:vnc
```

For any user but `wsadmin` the first line succeeds and skips the second: nothing changes for them. For `wsadmin` the
account phase fails for the remote-access PAM services, so it cannot sign in over SSH, RDP, Cockpit or VNC even if one
of those is installed. Local console (`login`), the WorkSuite greeter (`greetd`, which includes `login` and has the
break-glass button and reason prompt), `sudo`, `su`, polkit and the user manager (`systemd-user`) are unaffected.

Why a deny list of remote services and not an allow list of local ones: an allow list that misses one local service
(a new greeter, `systemd-user`, polkit) locks out the only recovery account, while a missed remote service only means
that remote use is still possible, and is still logged and one-time. `pam_access` with `LOCAL` was not used because
it treats any origin without a dot (an IPv6 address such as `::1`, a bare host name) as local. A restricted shell was
not used because a break-glass admin needs a full shell to repair the system.

**Gap:** there is no policy switch to allow remote break-glass use; an admin who needs it removes the rule with
`pam-auth-update`. The Recovery boot entry is not affected: it uses PAM services `login` and `polkit-1`, both allowed.

## Tests

- `services/directory/test/directory.test.ts`: escrow decrypts to the set password, one-time lock and audit, no escrow
  → locked, offline queue, reason forwarding.
- `tests/session/breakglass-admin.test.sh`: postinst idempotence and upgrade keep the password, sudoers drop-in
  (`visudo -c`), PAM account lines.
- `tests/session/breakglass-uid.test.sh`: system UID and the move from UID 1000.
- Server: `services/server/test/api.test.ts` (escrow and events endpoints).

Not verified by automated tests: a real server reveal and rotate round trip; console, greeter and recovery login on
hardware; SSH refusal through a real `sshd`.

# worksuite-user-services

User-level services packaged as `worksuite-user-services` (SRS §12.2): app catalog cache, Drive/files,
credentials broker and the sync service. The sync core is `services/sync`; this directory holds the session-bus
contract the shell uses (`dbus/lk.worksuite.Credentials1.xml`: `lk.worksuite.Credentials1` token broker and
`lk.worksuite.Sync1` status/per-record errors). The unit is `services/session/systemd/user/worksuite-sync.service`.

Rules: caller UID must equal the session UID (SRS §10.3); refresh tokens only in Secret Service; access tokens in
memory; `X-WS-Device` added to every desktop API call from the device credential, never from the user token.

## Sync service runtime (`services/sync/src/main.ts`)

- Config: `$XDG_CONFIG_HOME/worksuite/sync.json` (account, streams, module → data type), written by the credentials broker after sign-in from `desktop/v1/bootstrap` and removed on sign-out. Absent = not signed in; the service exits 0. The device credential is read per call from `/run/worksuite-device-agent/device-token` (no header on an unenrolled Personal device).
- State: `$XDG_STATE_HOME/worksuite/sync.db`. At start a failed `PRAGMA integrity_check` exports pending/failed outbox rows to `outbox-export-<time>.json`, sets the damaged file aside and starts fresh (SRS §9.2).
- Tokens: requested from the credentials broker at `$XDG_RUNTIME_DIR/worksuite/credentials.sock` (`GetAccessToken`, `force_refresh` on 401).
- Control: `$XDG_RUNTIME_DIR/worksuite/sync.sock` (0600, line-delimited JSON) with `Status`, `ListFailed`, `RetryFailed`, `SyncNow`, mirroring `lk.worksuite.Sync1`.
- Loop: push until the outbox is drained or backed off, pull each stream, then sleep until the next retry or the interval (default 60 s). Expired sign-in and revoked devices stop polling until `SyncNow`. SIGTERM finishes the in-flight cycle and closes SQLite.

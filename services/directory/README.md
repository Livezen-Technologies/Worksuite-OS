# worksuite-directory

Directory sign-in for WorkSuite OS (SRS §14.4, WSOS-DIR-002…010), built from standard parts: `pam_exec` with a
small helper (`src/main.ts`, logic in `src/directory.ts`), `pam_mkhomedir`, `useradd`/`usermod`/`chpasswd`.

| Piece | What it does |
|---|---|
| `pam/worksuite-directory` | `pam-auth-update` profile, priority 300 (before `pam_unix`). `auth`: helper with `expose_authtok`; `[success=end default=ignore]` so local accounts fall through to `pam_unix`. `session`: home creation and the break-glass hook. |
| `worksuite-pam-directory auth` | Names of the form `user@domain` go to `POST desktop/v1/os/directory/authenticate` with the device credential (`/var/lib/worksuite-device-agent/state.json`). On success the local account exists with UID `200000 + user_id` (stable across devices, WSOS-DIR-003), a locked local password, and `sudo` when the directory role is administrator (`group_role_map`, WSOS-DIR-006). |
| Offline cache | `/var/lib/worksuite-directory/cache.json` (0600): salted scrypt verifier + user record. Used only when the server is unreachable (network error or 5xx), and only for `offline_login_days` (from directory policy) since the last online sign-in (WSOS-DIR-004). `ACCOUNT_DISABLED` from the server removes the entry and locks the account (WSOS-DIR-005). A wrong password online never falls back to the cache. |
| Break-glass `wsadmin` | Created locked by the package. `worksuite-breakglass-rotate.timer` generates a 24-character password, encrypts it (RSA-OAEP-256) to `escrow_public_key` from the directory settings, posts it to `POST desktop/v1/os/break-glass`, and only then sets it. No escrow → the account stays locked. Opening a session as `wsadmin` locks the password at once, records `break_glass.used` (journal + `POST desktop/v1/os/break-glass/events`, queued while offline) and starts a rotation: each escrowed password works once (WSOS-DIR-010). |

Passwords travel on stdin and in the HTTPS request body only. They are never put in argv, the environment, the
journal or a file; tests in `test/directory.test.ts` check logs and stored state for the password.

Not covered yet: password-expiry prompts (DIR-007), an SSO token handed to the session (DIR-008), AD/LDAP via
SSSD (the server endpoint is the only backend today), smart cards (DIR-011).

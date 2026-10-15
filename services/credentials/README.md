# worksuite-credentials

The session's single token broker (WSOS-IDN-008), shipped in `worksuite-user-services`.

- **Sign-in** (`SignIn {server_url}`): `/.well-known/worksuite-desktop` → OneAuth issuer → OIDC discovery, then
  authorization code + PKCE (S256) in the system browser with a one-shot `127.0.0.1` redirect listener (RFC 8252).
  Public client, no client secret (WSOS-IDN-001). https only.
- **Refresh tokens** go to the Secret Service keyring through `secret-tool` (secret on stdin), never to files
  (WSOS-IDN-002). Rotated refresh tokens replace the stored one.
- **Access tokens** stay in memory, capped at 15 min (WSOS-IDN-003), reused until 60 s before expiry, one refresh in
  flight per account. `invalid_grant` → `sign_in_required`.
- **Lock / Unlock**: the shell calls `Lock` on screen lock and logout; cached tokens are dropped and requests refused.
- **Socket**: `$XDG_RUNTIME_DIR/worksuite/credentials.sock`, mode 0600, one JSON request per line:
  `GetAccessToken {account_id, force_refresh}`, `SignIn {server_url, mode}`, `SignOut {account_id}`, `Status`, `Lock`, `Unlock`.
- **Accounts** (no secrets): `$XDG_CONFIG_HOME/worksuite/accounts.json`.
- **Sync config**: after sign-in (`SignIn {server_url, mode}`) the broker reads `desktop/v1/bootstrap` (`user.id`,
  `org.id`, `modules[].key`, optional `modules[].data_type` and `modules[].offline`; `online_only` modules are skipped),
  writes `$XDG_CONFIG_HOME/worksuite/sync.json` (0600, no secrets) and restarts `worksuite-sync.service`. If that
  fails, the sign-in fails and nothing is stored. Sign-out removes the file and stops sync.

```sh
npm test
```

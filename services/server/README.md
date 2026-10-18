# worksuite-server (MVP)

A single-process WorkSuite server, so WorkSuite OS works end to end without the full WorkSuite cloud. It serves
the endpoints in `api-contracts/openapi.yaml` that the OS services call, and a minimal OneAuth (OpenID Connect)
provider for the credentials broker. Node 22 TypeScript, `node:sqlite`, no runtime dependencies.

## What it serves

| Area | Endpoints | Client |
| --- | --- | --- |
| Discovery | `/.well-known/worksuite-desktop` | credentials broker |
| OneAuth | `/oauth/.well-known/openid-configuration`, `authorize` (login page), `token`, `userinfo`, `revoke` | credentials broker |
| Session | `desktop/v1/bootstrap`, `apps`, `links/resolve`, `audit` | broker (sync config), shell |
| Sync | `desktop/v1/sync/mutations`, `sync/changes`, `sync/events`, `files/{id}/lock` | sync service |
| Devices | `desktop/v1/devices/register`, `heartbeat`, `commands/{id}/ack`, `policies` | device agent |
| OS | `desktop/v1/os/catalog`, `inventory`, `update-results`, `diagnostics`, `directory`, `break-glass` | device agent, package service |
| Releases | `/os/manifests/{ring}/{arch}.json`, `desktop/v1/releases/manifest?platform=os` | update coordinator |
| APT repository | `/os/apt/` (static, with `--apt-dir`; built by `tools/repo/publish.sh`) | apt on devices |
| Admin console | `/admin` (UI), `/admin/api/*` | administrators in a browser |

## Admin console

`https://<server>/admin`: overview, devices (details, commands, revoke), wipe requests, users, enrollment tokens,
policy, app catalog, releases (read-only) and an activity log.
- **Who can use it:** users with the admin role (`user-add --admin`), and only within their own organization.
- **Session:** an HttpOnly, Secure, SameSite=Strict cookie scoped to `/admin`, lasting 8 hours and stored hashed.
- **CSRF:** every API call must carry `X-WS-Admin: 1`.
- **Sign-in throttling:** 10 failures per 15 minutes per address.
- **Page hardening:** the page uses `script-src 'self'` with no third-party code, and data is only ever rendered as text.
- **Remote wipe:** follows the two-person rule. One administrator requests it with a reason; a different
  administrator approves it, which issues the signed `RemoteWipe` command with `approval_id` set to the request.
- **Policy changes:** validated field by field, versioned and signed, and every active device gets a `RefreshPolicy`.
- **Releases:** shown read-only, because publishing signs with the release key (CLI only).

## Security model

- **OneAuth:** public client `worksuite-os`, authorization code + PKCE S256 only, loopback `http://127.0.0.1:*`
  redirects only (RFC 8252). Access tokens last 15 minutes. Refresh tokens rotate on every use, and reusing an
  old one revokes the whole token family. Passwords are hashed with scrypt.
- **Stored secrets:** access/refresh tokens, authorization codes, device credentials and enrollment tokens are
  stored only as SHA-256 hashes.
- **Tenant scoping:** comes from the authenticated user or device, never from the request. A device credential
  sent with a user call must belong to the user's organization. Organizations created with `--require-device`
  refuse user calls without one (403 `DEVICE_REQUIRED`).
- **Signing:** policies, release manifests and device commands are signed with Ed25519, using the same canonical
  JSON (sorted keys) the clients verify. `keys-export` writes the public keys as `<key_id>.pem` for
  `/usr/share/worksuite/keys/{device-commands,release}`. `keys-rotate` adds a new signing key and keeps the old
  ones exportable.
- **Idempotency:** `Idempotency-Key` is required on the POSTs that declare it. Replays within 24 hours return the
  stored response, with a key per principal. Sync mutations are also deduplicated by `(user, mutation_id)`.
- **Sync rules:** a stale `base_revision` gets `conflict` with the server's copy, unless `force` is set
  (last-write-wins types). Tombstones are kept for 30 days; older cursors get 410 `CURSOR_EXPIRED`.
- **Request limits:** JSON bodies are capped at 1 MiB (413). Errors use the contract's `{error: {code, message, request_id}}` shape.

## Running it

Clients only talk https, so put TLS in front of the server (or pass `--tls-cert` and `--tls-key`). The device must
trust the certificate.

```sh
node src/main.ts init --db ws.db --org "Livezen Technologies"            # → {"org_id": 1}
echo 'a long password' | node src/main.ts user-add --db ws.db --org 1 --email ana@example.com --name "Ana Perera"
node src/main.ts keys-export --db ws.db ./keys                               # ship in worksuite-archive-keyring
node src/main.ts serve --db ws.db --public-url https://ws.example.com --listen 127.0.0.1:8080
```

Administration (CLI today; the admin console comes later):

```sh
node src/main.ts enroll-token --db ws.db --org 1 --hours 24 --uses 1         # for: worksuite-device-agent enroll
node src/main.ts policy-set --db ws.db --org 1 policy.json                   # Policy fields, without version/signature; checked by src/policy.ts, the console's validator
node src/main.ts command --db ws.db --device <id> --name RequestLock
node src/main.ts release-publish --db ws.db manifest.json                     # ReleaseManifest, without signature
node src/main.ts catalog-put --db ws.db item.json                             # CatalogItem
node src/main.ts devices --db ws.db ; node src/main.ts device-revoke --db ws.db --device <id>
```

## Not in the MVP

- Federation to an external OneAuth or AD/LDAP. Users are local.
- Resumable binary diagnostic bundles. JSON summaries are accepted.
- Push (`sync/events` is accepted but not acted on), and multi-node deployment (SQLite, one process).

## Tests

`npm test` runs the server's own API tests, plus end-to-end tests that use the real client code:
- the broker's OIDC calls and sync config;
- the sync transport;
- the device `Agent` (enroll, signed policy, signed commands with acks, revocation);
- the package service's manifest verification.

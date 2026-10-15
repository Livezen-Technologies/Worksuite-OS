# worksuite-device-agent

Root-owned OS implementation of the WorkSuite Device Agent (SRS §9.3, §14.3) over the existing
`desktop/v1/devices/*` endpoints: `register` (enrollment, key pair TPM-backed when available),
`heartbeat` (inventory, OS/shell/kernel versions, update status, observed policy state) and
`commands/{id}/ack`. Bus API: `dbus/lk.worksuite.DeviceAgent1.xml` (local status + enrollment only).

## Remote commands (WSOS-MDM-003) — the complete list

`RefreshPolicy`, `InstallApprovedApplication {catalog_id}`, `ScheduleUpdate`, `RequestLock`,
`RebootDuringWindow`, `CollectApprovedDiagnostics {bundle_profile}`, `RemoteWipe {scope: worksuite_data|full_device, approval_id}`.
There is no shell, exec or file-read command (WSOS-MDM-006). Anything else is rejected `UNKNOWN_COMMAND`.

## Envelope validation — `src/commands.ts`

Order: shape → allow-list → signature present → Ed25519 signature over canonical JSON (sorted keys, signature
excluded) with a server key → device binding (`device_id` = enrolled id) → issued/expiry (5 min skew; per-command
max TTL, RemoteWipe ≤ 30 days) → args → replay (single-use id, remembered until expiry). Acceptance records the id;
each result is acked with `devices/commands/{id}/ack` as `received` → `started` → `completed|failed`
(wipe acks `started` before destroying keys, WSOS-WIPE-005). Full device wipe is refused on unencrypted devices.

`npm test` runs `test/commands.test.ts` (node:test, Node ≥ 22.18, no dependencies).

## Device credential for user services

After `devices/register`, the agent publishes the device credential at `/run/worksuite-device-agent/device-token`
(`RuntimeDirectory=worksuite-device-agent`, file mode 0644) so the user-level sync service and credentials broker can
send `X-WS-Device` (WSOS-IDN-005). It identifies the device, not a user; the private key stays in the agent's state
directory (or TPM). The file is removed on unenrollment, revocation and wipe.

# Requirements traceability (P1, initial)

Status: **Impl** = implemented and unit-tested here · **Cfg** = configuration/contract shipped, runtime not yet built · **Doc** = contract documented only.

| Requirement | Files | Status |
|---|---|---|
| WSOS-AUTH-001/002 greetd default session, no autologin | `live-build/config/hooks/normal/0100-worksuite-defaults.hook.chroot`, `installer/modules/users.conf` | Cfg |
| WSOS-SES-001 env import before portals | `services/session/bin/worksuite-session` (`--ready`), `services/session/labwc/autostart` | Cfg |
| WSOS-SES-002 user units bound to `worksuite-session.target` | `services/session/systemd/user/*` | Cfg |
| WSOS-SES-003 clean logout | `services/session/bin/worksuite-session` (`cleanup`) | Cfg |
| WSOS-SES-004/005 shell restart ≤ 3 s, recovery after 3 crashes / 60 s | `services/session/systemd/user/worksuite-shell.service`, `worksuite-recovery-launcher.service` | Cfg |
| WSOS-SES-006 compositor exit → greeter notice | `services/session/bin/worksuite-session` | Cfg |
| WSOS-SHL-001…004 bridge operations, errors, caller check | `native/wayland-bridge/lk.worksuite.WaylandBridge1.xml`, `native/wayland-bridge/README.md` | Doc |
| WSOS-INT-012 portal backends | `services/session/portals/worksuite-portals.conf` | Cfg |
| WSOS-DRV-004 conflict copy name | `services/sync/src/policy.ts` (`conflictCopyName`) | Impl |
| WSOS-IDN-001 OIDC code + PKCE, no client secret | `services/credentials/src/broker.ts` (`signIn`), `src/oidc.ts`, `src/pkce.ts` | Impl |
| WSOS-IDN-002/003/008 token broker | `services/credentials/src/broker.ts`, `src/keyring.ts`, `services/user-service/dbus/lk.worksuite.Credentials1.xml` | Impl |
| WSOS-IDN-005 `X-WS-Device` on every call | `services/sync/src/transport.ts` (`fetchTransport`), `api-contracts/openapi.yaml` | Impl |
| WSOS-IDN-006 DEVICE_REVOKED stops sync | `services/sync/src/engine.ts` | Impl |
| §8.2 local store, write + outbox in one transaction | `services/sync/src/db.ts`, `services/sync/src/store.ts` | Impl |
| WSOS-SYN-001 dedupe by mutation_id | `api-contracts/openapi.yaml` (`sync/mutations`), `services/sync/test/sync.test.ts` | Impl (client) |
| WSOS-SYN-002 ack + cursor in one transaction | `services/sync/src/engine.ts` (`pushOnce`, `pull`) | Impl |
| WSOS-SYN-003 backoff 1 s → 5 min, jitter | `services/sync/src/backoff.ts` | Impl |
| WSOS-SYN-004 per-record validation errors, no retry | `services/sync/src/engine.ts`, `LocalStore.failed()` | Impl |
| WSOS-SYN-005 one refresh on 401, never discard | `services/sync/src/engine.ts` (`authed`) | Impl |
| WSOS-SYN-006 expired cursor → bounded full resync | `services/sync/src/engine.ts` (`pull`, `sweep`) | Impl |
| WSOS-SYN-008 sign-out with unsent changes: wait / export / discard | `shell/src/screens/Settings.tsx` (`UnsentDialog`), `shell/electron/main.ts`, `services/sync/src/service.ts` (`unsent`, `exportUnsent`, `forgetAccount`) | Impl |
| §9.2 local database corruption → export outbox, rebuild | `services/sync/src/main.ts` (`checkIntegrity`) | Impl |
| WSOS-SES-003 sync stops cleanly on logout | `services/sync/src/service.ts` (`stop`), `worksuite-sync.service` | Impl |
| §8.4 conflict policy by data type | `services/sync/src/policy.ts` (`resolveConflict`) | Impl |
| WSOS-UPD-001/006, §9.2 repair | `services/package-service/` (D-Bus XML, polkit, unit, README) | Doc |
| §10.3 polkit actions `lk.worksuite.package.install`, `.update.apply`, `.repair` | `services/package-service/polkit/lk.worksuite.package.policy` | Cfg |
| WSOS-MDM-003/004/006, WSOS-WIPE-004 command allow-list + envelope | `services/device-agent/src/commands.ts`, `services/device-agent/test/commands.test.ts` | Impl |
| §9.3 enrollment, WSOS-IDN-005 device credential | `services/device-agent/src/agent.ts` (`enroll`), `src/host.ts` (`publishCredential`); first-run: `shell/src/screens/FirstRun.tsx`, `shell/electron/device.ts` (`enrollDevice`) | Impl |
| WSOS-MDM-001 inventory and versions | `services/device-agent/src/host.ts` (`facts`, `inventory`), `src/main.ts` | Impl |
| WSOS-MDM-002 signed policy | `services/device-agent/src/agent.ts` (`refreshPolicy`, `verifyPolicy`) | Impl |
| WSOS-MDM-007, WSOS-WIPE-007 management status for users | `services/device-agent/src/agent.ts` (`status`) → `/run/worksuite-device-agent/status.json` → `shell/src/screens/Settings.tsx` (`AboutDevice`) | Impl |
| WSOS-WIPE-002/003/005/006 remote wipe | `services/device-agent/src/agent.ts` (`wipe`, `offlineKillTimer`), `src/host.ts` (`wipeWorkSuiteData`, `cryptoErase`) | Impl |
| WSOS-SEC-007 systemd hardening | `services/*/systemd/*.service` | Cfg |
| WSOS-SEC-010 no SSH server | `packaging/debian/control` (`Conflicts: openssh-server`), live-build hook | Cfg |
| §10.2 / §14.5 server API contract | `api-contracts/openapi.yaml` | Doc |
| §11.6 / §12.2 one package per component + metapackage | `packaging/debian/control`, `*.install` | Cfg |
| WSOS-BOOT-001, WSOS-ARM-001/002 UEFI, amd64 + arm64 | `live-build/auto/config` | Cfg |
| WSOS-AUP-002 signed repos | `live-build/config/includes.chroot/etc/apt/sources.list.d/*.sources` (`Signed-By`) | Cfg |
| WSOS-INS-001…005, 007 installer | `installer/settings.conf`, `installer/modules/*` | Cfg (INS-003 typed confirm, INS-004 recovery key: custom module still needed) |

§13.1 adversarial cases covered by `services/sync/test/sync.test.ts`: duplicate mutation → one effect; crash after
server commit before ack → no duplicate; two offline edits → conflict kept; expired token → pending kept.
Command replay is covered by `services/device-agent/test/commands.test.ts`.
| WSOS-APT-001/002/003/004/006, WSOS-APP-002/003, WSOS-FLP-001/002/004, WSOS-UPD-001 (device side) | `services/package-service/src/service.ts`, `src/apt.ts`, `src/dbus.ts` | Impl |
| §7.2 Files: This Computer / WorkSuite Cloud, WSOS-DRV-002 sync states | `shell/src/screens/Files.tsx`, `shell/electron/files.ts`, `services/sync/src/service.ts` (`fileStates`, `driveSummary`) | Impl (UI; Drive transfer engine not in this repo) |
| WSOS-AUP-001…009, 011, WSOS-UPD-002/003/005 update coordinator | `services/package-service/src/updates.ts`, `src/coordinator.ts`, `src/dbus.ts`; Settings › Updates: `shell/src/screens/Settings.tsx`, `shell/electron/packages.ts` | Impl |
| WSOS-INS-003 typed disk-name confirmation, WSOS-INS-004 recovery key shown once | `installer/modules/worksuiteconfirm/` (C++ view module), `installer/modules/worksuiterecovery/` (Python job), `installer/settings.conf` | Impl (Calamares 3.3.5 load-tested; not run against a disk) |

## Branding (`worksuite-branding`)

| Item | Implementation | Verified |
|---|---|---|
| Boot splash with disk-unlock prompt | `branding/plymouth/` script theme, set as `default.plymouth` in postinst | Built and linted; not booted (no Plymouth/KVM in the dev container) |
| GRUB theme, quiet boot | `branding/grub/theme.txt`, `/etc/default/grub.d/worksuite.cfg` | Built; not booted |
| App icon (hicolor 16–512 + scalable), wallpaper | `branding/icons/`, `branding/wallpaper.svg`, rendered by `branding/render.sh` | Rendered |
| Installer logo and slideshow | `installer/branding/worksuite/` (concept A logo, 4 slides) | Not rendered (QtQuick.Window missing in container) |

## Server MVP (`services/server`)

| Item | Implementation | Verified |
|---|---|---|
| OneAuth sign-in (WSOS-IDN-001..003): OIDC code + PKCE S256, loopback redirects, 15 min access tokens, rotating refresh tokens with reuse detection, revocation | `src/oauth.ts` | E2E with the broker's `discover`/`tokenRequest`/`userinfo` |
| Device enrollment, signed policy, signed commands, acks, revocation (WSOS-MDM-001..006, WSOS-IDN-005) | `src/api.ts`, `src/admin.ts` | E2E with the real device `Agent` |
| Idempotent sync mutations, conflicts, cursor paging, tombstone window and 410 (WSOS-SYN-001, -006, -007) | `src/api.ts` | E2E with the sync transport; API tests |
| Document locks (WSOS-DRV-003) | `files/{id}/lock` | API tests |
| Signed release manifests (WSOS-AUP-002) | `/os/manifests/{ring}/{arch}.json` | Verified with the package service's `verifyManifest` |
| Not yet | Federation (AD/LDAP/external OneAuth), resumable diagnostic uploads, admin console, push | — |
| Admin console (WSOS-MDM-007 admin side, WSOS-WIPE-002 two-person wipe) | `services/server/src/console.ts`, `console-ui.ts` at `/admin` | API tests (auth, CSRF, org isolation, two-person wipe verified with the agent's validator, policy validation); browser run with screenshots in `docs/screenshots/admin/` |

## Signed updates and keys

| Item | Implementation | Verified |
|---|---|---|
| Signed APT repository per ring (WSOS-AUP-002) | `tools/repo/keygen.sh`, `publish.sh`; served by `worksuite-server --apt-dir` | `tests/repo/apt-e2e.sh` (real apt: verify, upgrade, tampered and foreign-signed refused, no path traversal); CI job `apt-repo` |
| Public keys on devices (WSOS-SEC-011) | `worksuite-archive-keyring` from `packaging/keyring/` (public keys only; empty = fail closed) | Package builds and lints; install paths checked |

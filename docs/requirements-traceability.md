# Requirements traceability (P1, initial)

Status: **Impl** = implemented and unit-tested here · **Cfg** = configuration/contract shipped, runtime not yet built · **Doc** = contract documented only.

| Requirement | Files | Status |
|---|---|---|
| WSOS-AUTH-001/002 greetd default session, no autologin | `live-build/config/hooks/normal/0100-worksuite-defaults.hook.chroot`, WorkSuite greeter `services/session/greeter/` (greetd IPC, PAM conversation, starts `worksuite-session`), `services/session/bin/worksuite-greeter`; opt-in autologin only via `services/session/bin/worksuite-autologin` (`--personal` unmanaged non-admin, `--kiosk` with policy `kiosk_autologin_user`); tests `services/session/greeter/tests/test_login.py`, `tests/session/session-test.sh`, `tests/session/autologin-test.sh` | Impl |
| WSOS-SES-001 env import before portals | `services/session/bin/worksuite-session` (`--ready`), `services/session/labwc/autostart`; test `tests/session/session-test.sh` | Impl |
| WSOS-SES-002 user units bound to `worksuite-session.target` | `services/session/systemd/user/*`; test `tests/session/session-test.sh` (wiring) | Impl (no real user manager in CI) |
| WSOS-SES-003 clean logout (compositor exit and shell Log out) | `services/session/bin/worksuite-session` (`cleanup`, `--logout`), `shell/electron/session.ts` (`logoutCommand`); tests `tests/session/session-test.sh`, `shell/electron/session.test.ts` | Impl |
| WSOS-SES-004, WSOS-REL-004 apps in their own `app-worksuite-*.scope`, shell restart ≤ 3 s (`KillMode=mixed`) | `shell/electron/session.ts` (`appLaunchCommand`), `services/session/systemd/user/worksuite-shell.service`; test `shell/electron/session.test.ts` | Impl (no VM kill test) |
| WSOS-SES-005 recovery after 3 crashes / 60 s | `services/session/systemd/user/worksuite-shell.service`, `worksuite-recovery-launcher.service` (`--safe`), `shell/src/screens/SafeLauncher.tsx`, `shell/electron/desktopHost.ts` (problem report); tests `tests/session/session-test.sh`, `shell/electron/bootmode.test.ts`, `electron/desktopHost.test.ts`, `src/screens/DesktopSettings.test.tsx` | Impl (no VM crash-loop test) |
| WSOS-DSK-008 clipboard history off by default, no passwords, clearable | `shell/electron/clipboard.ts` (wl-clipboard), `electron/desktopHost.ts`, `src/screens/DesktopSettings.tsx` (`ClipboardSection`); tests `electron/clipboard.test.ts` (incl. headless Labwc), `src/screens/DesktopSettings.test.tsx` | Impl |
| WSOS-DSK-009 default apps in Settings, stored in mimeapps.list | `shell/electron/mimeapps.ts`, `electron/xdg.ts` (`mime_types`), `src/screens/DesktopSettings.tsx` (`DefaultAppsPanel`); tests `electron/mimeapps.test.ts`, `src/screens/DesktopSettings.test.tsx` | Impl |
| WSOS-DSK-010 worksuite:// links via links/resolve | `shell/apps/worksuite-url-handler.desktop`, `apps/worksuite-mimeapps.list`, `shell/electron/webapps.ts` (`resolveLink`), `electron/appwindow.ts`; tests `electron/webapps.test.ts`, `electron/winexe.test.ts` | Impl |
| WSOS-DSK-011 shortcuts (Super, Alt+Tab, workspaces, Super+L, portal screenshot) | `services/session/labwc/rc.xml`, `shell/electron/screenshot.ts`, `shell/bin/worksuite-screenshot`; test `electron/screenshot.test.ts` (fake portal on a private bus) | Impl |
| WSOS-LCH-001 desktop-entry launch, fixed argv, no shell | `shell/electron/session.ts` (`appLaunchCommand`, `scopeCommand`), `electron/xdg.ts` (`execProgram`); tests `electron/session.test.ts`, `electron/xdg.test.ts` | Impl |
| WSOS-LCH-003 Windows programs explained, never run | `shell/electron/winexe.ts`, `electron/main.ts` (`ws:filesOpen`), `src/screens/Files.tsx`, `shell/apps/worksuite-windows-app.desktop`, `shell/bin/worksuite-windows-app`; test `electron/winexe.test.ts` | Impl |
| WSOS-SES-006 compositor exit → greeter notice | `services/session/bin/worksuite-session`, `bin/worksuite-greeter`, `tmpfiles/worksuite-session.conf`, live-build greetd config; test `tests/session/session-test.sh` | Impl |
| WSOS-LOCK-001/002/004 gtklock (ext-session-lock), lock before suspend, fail closed | `services/session/bin/worksuite-lock`, `bin/worksuite-idle`, `systemd/user/worksuite-idle.service`, `gtklock/{config.ini,style.css}`; test `tests/session/session-test.sh` (stub gtklock) | Impl (not run on a real compositor) |
| WSOS-LOCK-003 idle timeout within policy maximum | `shell/electron/session.ts`, `shell/src/screens/Settings.tsx` (`LockAfterRow`, Users section), `services/session/bin/worksuite-idle`, `systemd/user/worksuite-idle-policy.path`, `services/device-agent/src/enforce.ts`; tests `session.test.ts`, `session-test.sh`, `agent.test.ts` | Impl |
| WSOS-AUTH-004 pam_faillock with policy thresholds | `services/session/pam/worksuite-faillock*`, `pam/faillock.conf`, `packaging/debian/worksuite-session.postinst`, `services/device-agent/src/enforce.ts` (`faillockConf`) | Impl (PAM stack not run in a test) |
| WSOS-INT-001 managed WireGuard VPN (server-issued per-device config, device-held keys, always-on, kill switch, rotation, removal on revoke/wipe) | `live-build/config/package-lists/worksuite.list.chroot` (`wireguard-tools`, `nftables`), `api-contracts/openapi.yaml` (`/desktop/v1/os/vpn`, `/desktop/v1/os/vpn/peer`, `VpnConfig`, Policy `vpn_required`/`user_vpn`), `services/server/src/vpn.ts`, `src/api.ts`, `src/console.ts` (`/admin/api/vpn`), `services/device-agent/src/vpn.ts`, `src/agent.ts` (`refreshVpn`, `enforceVpn`), `src/host.ts` (`applyVpn`), `systemd/worksuite-device-agent.service`, `security/apparmor/worksuite-device-agent`; tests `services/server/test/vpn.test.ts`, `test/e2e.test.ts`, `services/device-agent/test/vpn.test.ts` | Impl (nmcli/nft effects not run in CI) |
| WSOS-INT-001 user WireGuard VPN (import .conf, connect/disconnect/remove, taskbar status, policy can forbid) | `shell/electron/system.ts` (`parseWgConf`, `vpn*`), `electron/main.ts`, `electron/preload.ts`, `src/screens/Settings.tsx` (`VpnSection`), `src/components/PanelItems.tsx` (`VpnBadge`), `src/lib/vpn.ts`; test `shell/electron/vpn.test.ts` | Impl |
| WSOS-INT-001 user OpenVPN (import .ovpn with hook refusal, private certificate copies, credentials on stdin) and captive-portal sign-in window | `live-build/config/package-lists/worksuite.list.chroot` (`network-manager-openvpn`), `live-build/config/includes.chroot/etc/NetworkManager/conf.d/20-worksuite-connectivity.conf`, `shell/electron/openvpn.ts`, `electron/connectivity.ts`, `electron/system.ts` (`vpnImportOpenvpn`, `connectivity`), `electron/main.ts` (`startPortalWatch`), `src/screens/Settings.tsx`, `docs/networking.md`; tests `shell/electron/openvpn.test.ts`, `electron/connectivity.test.ts` | Impl (nmcli effects not run in CI) |
| WSOS-INT-010 polkit authentication agent | `services/session/polkit` (PolkitAgent listener) relaying to `shell/electron/polkit.ts` and `src/components/AuthPrompt.tsx`; lxpolkit/mate-polkit fallback in `services/session/bin/worksuite-polkit-agent` | Impl + tests (not run against real polkitd) |
| WSOS-SHL-001…004 bridge operations, errors, caller check | `native/wayland-bridge/worksuite_bridge/`, `native/wayland-bridge/lk.worksuite.WaylandBridge1.xml` | `native/wayland-bridge/tests/` |
| WSOS-INT-012 portal backends | `services/session/portals/worksuite-portals.conf`, checked by `shell/electron/sessionConfig.test.ts` | Cfg + test |
| WSOS-INT-003…006 Bluetooth pairing, drives, power profiles, printers | `shell/electron/peripherals.ts`, `shell/src/screens/PeripheralSettings.tsx` | Impl + tests |
| WSOS-INT-007 notification server | `shell/electron/notifications.ts`, `shell/src/lib/appNotifications.ts` | Impl + D-Bus tests |
| WSOS-INT-009 keyring unlock on sign-in | `libpam-gnome-keyring` (control), image hook check | Cfg + test |
| WSOS-INT-011 input methods | `services/session/fcitx5/profile`, `worksuite-input-method.service`, `labwc/environment`, Settings input methods | Cfg + tests |
| WSOS-INT-013 screen-sharing consent, indicator | `services/session/bin/worksuite-screencast-chooser`, `xdg-desktop-portal-wlr/config`, `shell/src/components/CaptureBadge.tsx` | Impl + tests |
| WSOS-SYN-009 offline level | `services/server/src/db.ts` DEFAULT_WEB_APPS, `shell/src/lib/launcher.ts` | Impl + tests |
| WSOS-SYN-010 store on encrypted storage | `services/sync/src/storage.ts` | Impl + tests |
| WSOS-DRV-004 conflict copy name | `services/sync/src/policy.ts` (`conflictCopyName`) | Impl |
| WSOS-IDN-001 OIDC code + PKCE, no client secret | `services/credentials/src/broker.ts` (`signIn`), `src/oidc.ts`, `src/pkce.ts` | Impl |
| WSOS-IDN-002/003/008 token broker | `services/credentials/src/broker.ts`, `src/keyring.ts`, `services/user-service/dbus/lk.worksuite.Credentials1.xml` | Impl |
| WSOS-IDN-005 `X-WS-Device` on every call | `services/sync/src/transport.ts` (`fetchTransport`), `api-contracts/openapi.yaml` | Impl |
| WSOS-IDN-006 DEVICE_REVOKED stops sync | `services/sync/src/engine.ts` | Impl |
| §8.2 local store, write + outbox in one transaction | `services/sync/src/db.ts`, `services/sync/src/store.ts` | Impl |
| WSOS-SYN-001 dedupe by mutation_id | `api-contracts/openapi.yaml` (`sync/mutations`), `services/sync/test/sync.test.ts` | Impl (client) |
| WSOS-SYN-002 ack + cursor in one transaction | `services/sync/src/engine.ts` (`pushOnce`, `pull`) | Impl |
| WSOS-SYN-003 backoff 1 s → 5 min, jitter | `services/sync/src/backoff.ts` | Impl |
| WSOS-SYN-004 per-record validation errors, no retry | `services/sync/src/engine.ts`, `LocalStore.failed()`; shown per record in Settings › Users (`shell/src/screens/PeripheralSettings.tsx`) | Impl + tests |
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
| WSOS-MDM-002 policy enforcement: lock timeout, offline period, USB storage, Bluetooth, sign-in lockout | `api-contracts/openapi.yaml` (`Policy`), `services/server/src/console.ts` (`POLICY_FIELDS`), `services/device-agent/src/enforce.ts`, `src/host.ts` (`applyEnforcement`, `setOfflineAccessBlock`), `src/agent.ts` (`enforce`, `offlineAccessCheck`); tests `services/device-agent/test/agent.test.ts`, `services/server/test/console.test.ts` | Impl |
| WSOS-WIPE-001 `desktop.devices.wipe`, admin re-authentication, typed device name, second approver | CoreApprovalEngine `services/server/src/approvals.ts` (permission, distinct approver, personal-device waiver by policy `wipe_personal_single_approval`), `services/server/src/console.ts` (`reauth`, ownership route), `console-ui.ts` (`wipeConfirm`); test `services/server/test/console.test.ts` | Impl |
| WSOS-WIPE-008 wipe audit, devices marked Wiped and re-enrolment | `services/server/src/api.ts` (command ack → `wipe_requests.result`, `admin_log wipe_*`, `devices.wiped_at`, credential revoked), console "Wiped" status; test `services/server/test/console.test.ts` | Impl |
| WSOS-IDN-004 enrollment required before first use | `/etc/worksuite/provisioning.json` → `shell/electron/device.ts` (`provisioning`), `shell/src/screens/FirstRun.tsx`; tests `shell/electron/device.test.ts`, `shell/src/screens/FirstRun.test.tsx` | Impl |
| WSOS-IDN-007 revocation keeps local accounts | `services/device-agent/src/agent.ts` (`unenrollLocally` lifts the offline block); test `services/device-agent/test/agent.test.ts` | Impl |
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
| WSOS-APP-001/003, WSOS-ARM-005 App Center catalog from `desktop/v1/os/catalog` (no built-in apps; empty/error states) | `services/package-service/src/catalog.ts` (`GetCatalog`), `shell/electron/packages.ts`, `shell/src/lib/appcatalog.ts`, `shell/src/screens/AppCenter.tsx` | Impl; `services/package-service/test/features.test.ts`, `shell/src/lib/appcatalog.test.ts` |
| WSOS-APT-005 local .deb (staged copy, unverified publisher, policy, apt simulation, token + `install-local` polkit) | `services/package-service/src/service.ts`, `src/staging.ts`, `polkit/lk.worksuite.package.policy`; App Center dialog | Impl; `features.test.ts`, `dbus.test.ts` |
| WSOS-FLP-003/004 permission review/reset, app data removal, runtime pruning | `service.ts` (`appPermissions`, `resetAppPermissions`, `pruneRuntimes`), `shell/electron/packages.ts` (`flatpakUserClient`) | Impl; `features.test.ts`, `shell/electron/packages.test.ts` |
| WSOS-AIM-001…004 AppImages (import + metadata, first-run approval, embedded GPG signature, same-key updates) | `services/package-service/src/appimage.ts`, `src/appimage-cli.ts`, `bin/worksuite-appimage` (per user) | Impl; `services/package-service/test/appimage.test.ts` (real squashfs-tools and gpg) |
| §7.2 Files: This Computer / WorkSuite Cloud, WSOS-DRV-002 sync states | `shell/src/screens/Files.tsx`, `shell/electron/files.ts`, `services/sync/src/service.ts` (`fileStates`, `driveSummary`) | Impl (UI; Drive transfer engine not in this repo) |
| WSOS-AUP-008 resumable downloads (apt partials kept, retries; interrupted = waiting), WSOS-AUP-010 `.wsupdate` USB bundles, WSOS-AUP-012 entitlement gating with a signed device licence | `services/package-service/src/service.ts` (`download`, `installBundle`), `src/bundle.ts`, `src/updates.ts` (`verifyLicence`, `decide`), `src/coordinator.ts`; Settings › Updates "Install from a USB drive" | Impl; `features.test.ts`, `entitlement.test.ts` |
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
| Document locks (WSOS-DRV-003) | `files/{id}/lock`; client: `services/sync/src/locks.ts`, `shell/electron/officeLock.ts` | API + client tests (needs DRV-001 file map) |
| Signed release manifests (WSOS-AUP-002) | `/os/manifests/{ring}/{arch}.json` | Verified with the package service's `verifyManifest` |
| Release pause/resume/pull, ring promotion, emergency release to all rings (WSOS-UPD-004, WSOS-AUP-013), `desktop.releases.manage` | `src/admin.ts`, admin API `/admin/api/releases/*` (`src/console.ts`), CLI `release-*`, `grant` | `test/releases.test.ts` (re-signed manifests verified with the package service) |
| Device licence for update entitlements (WSOS-AUP-012) | `GET /desktop/v1/os/licence` (`src/api.ts`, `admin.ts` `licenceFor`), CLI `licence-set` | `test/releases.test.ts` with the package service's `verifyLicence` |
| Offline `.wsupdate` bundles (WSOS-AUP-010) | CLI `bundle-build` (`admin.ts` `buildBundle`) | `test/releases.test.ts` with the package service's `inspectBundle` |
| Not yet | Federation (AD/LDAP/external OneAuth), resumable diagnostic uploads, admin console, push | — |
| Admin console (WSOS-MDM-007 admin side, WSOS-WIPE-002 two-person wipe) | `services/server/src/console.ts`, `console-ui.ts` at `/admin` | API tests (auth, CSRF, org isolation, two-person wipe verified with the agent's validator, policy validation); browser run with screenshots in `docs/screenshots/admin/` |

## Signed updates and keys

| Item | Implementation | Verified |
|---|---|---|
| Signed APT repository per ring (WSOS-AUP-002) | `tools/repo/keygen.sh`, `publish.sh`; served by `worksuite-server --apt-dir` | `tests/repo/apt-e2e.sh` (real apt: verify, upgrade, tampered and foreign-signed refused, no path traversal); CI job `apt-repo` |
| Public keys on devices (WSOS-SEC-011) | `worksuite-archive-keyring` from `packaging/keyring/` (public keys only; empty = fail closed) | Package builds and lints; install paths checked |
| No private keys in the tree, HSM/offline key process (WSOS-SEC-011) | `docs/security/hardening.md` | CI `os-scripts` fails on any `PRIVATE KEY` block |
| SBOM per release (WSOS-SEC-011) | `tools/sbom/spdx.mjs`, `tools/sbom/generate.sh` (SPDX 2.3: image package list, WorkSuite .debs with SHA-256, npm runtime deps incl. Electron; syft when present) | `tools/sbom/spdx.test.mjs` in CI; generated and uploaded per arch in `image.yml` |

## Directory sign-in (`worksuite-directory`)

| Requirement | Implementation | Verified |
|---|---|---|
| WSOS-DIR-002/009 directory password check at the greeter | `services/directory/pam/worksuite-directory` (pam-auth-update, `pam_exec expose_authtok`, `[success=end default=ignore]`), `src/main.ts` (HTTPS + device credential) → `POST desktop/v1/os/directory/authenticate` (`services/server/src/api.ts`, `api-contracts/openapi.yaml`) | `services/directory/test/directory.test.ts`; server `api.test.ts` (device-bound, org-scoped, disabled) |
| WSOS-DIR-001 join (setup, Settings, policy) | Enrollment in first-run and Settings › About (`EnrollCard`), directory settings from the server (`worksuite-server directory-set`, `GET desktop/v1/os/directory`), greeter domain `worksuite-directory-greeter.timer` | `shell/electron/device.test.ts`, `services/server/test/identity.test.ts` |
| WSOS-DIR-002 Other user, domain shown, user / user@domain / DOMAIN\\user | `services/session/greeter/worksuite_greeter/login.py` (`normalize`, `domain_label`), `ui.py`; `worksuite-pam-directory greeter-config` | `services/session/greeter/tests/test_login.py` |
| WSOS-DIR-007 password expiry / change at next sign-in | `services/server/src/identity.ts`, `api.ts` (`PASSWORD_EXPIRED`, `change-password`); `services/directory/src/directory.ts` (`CHANGE_PREFIX`, `markName`); greeter change form | `services/server/test/identity.test.ts`, `directory.test.ts`, `test_login.py` |
| WSOS-DIR-008 tokens after directory sign-in without a second prompt | login code (`identity.ts` `issueLoginCode`), RFC 8693 exchange in `oauth.ts`; handoff `services/directory/src/main.ts`; broker `services/credentials/src/main.ts` (`importLoginHandoff`), `broker.ts` (`signInWithLoginCode`) | `identity.test.ts`, `services/credentials/test/broker.test.ts`, `directory.test.ts` |
| WSOS-DIR-009 MFA (TOTP) | `identity.ts` (RFC 6238, replay-protected, `worksuite-server totp-enroll`), greeter code field, OneAuth sign-in page | `identity.test.ts` (RFC test vectors), `directory.test.ts`; passkeys not implemented |
| WSOS-DIR-011 smart card (P3) | `services/directory/smartcard/` (pam_pkcs11 profile, off by default; `worksuite-smartcard-setup`) | `tests/session/smartcard-test.sh` (no hardware) |
| WSOS-DIR-003 stable UID, home | UID 200000 + user id, `useradd` with locked password, `pam_mkhomedir` | `directory.test.ts` (uid, conflicts) |
| WSOS-DIR-004/005 offline cache with policy expiry; disabled refused | `src/directory.ts` (`authenticate`): scrypt verifier, `offline_login_days`, cache purge + lock on `ACCOUNT_DISABLED` | `directory.test.ts` |
| WSOS-DIR-006 group → role | `localGroups()` with `group_role_map` | `directory.test.ts` |
| WSOS-DIR-010 break-glass admin | `rotate()`/`session()`, `worksuite-breakglass-rotate.{service,timer}`, `wsadmin` (postinst), server `POST desktop/v1/os/break-glass` + `/events` | `directory.test.ts` (escrow decrypts to the set password, one-time lock, audit queue), `api.test.ts` |
| Passwords never logged | stdin/HTTPS body only | `directory.test.ts` checks logs, cache and request URL |

## Recovery boot (`worksuite-recovery-boot`)

| Requirement | Implementation | Verified |
|---|---|---|
| WSOS-BOOT-003, §9.2-R4 previous kernel kept and bootable | `services/recovery-boot/kernel/zz-worksuite-kernel-retention`, `grub/42_worksuite_recovery` | `tests/boot/recovery-boot.test.sh` (CI `os-scripts`) |
| §9.2-R3 "WorkSuite Recovery" boot entry → recovery screens | `grub/42_worksuite_recovery`, `systemd/worksuite-recovery.target`, `worksuite-recovery-shell.service`, `shell/electron/bootmode.ts` (`worksuite.recovery=1`) | `recovery-boot.test.sh`, `shell/electron/bootmode.test.ts`; not booted in a VM |
| §9.2-R1 boot-time package repair | `bin/worksuite-boot-repair`, `worksuite-boot-repair.service` (`OnFailure=` → recovery target) | `recovery-boot.test.sh` (stub dpkg/apt) |

## Hardening

| Requirement | Implementation | Verified |
|---|---|---|
| WSOS-SEC-004 per-app session partitions | `shell/electron/appwindows.ts` (`persist:ws-app-<id>`), `ws:openWorkSuiteApp` in `main.ts`/`preload.ts` | `shell/electron/appwindows.test.ts` |
| WSOS-SEC-009 AppArmor | `security/apparmor/*`, `AppArmorProfile=-…` in units, postinst reload | `tests/security/apparmor.test.sh` (CI) |
| WSOS-SEC-012 Electron patch policy | `docs/security/hardening.md`, `.github/dependabot.yml` | Process |
| WSOS-SEC-001 renderer prefs, no navigation | `shell/electron/webSecurity.ts` `shellWebPreferences`, `main.ts`, `appwindows.ts` `navigationDecision` | `shell/electron/webSecurity.test.ts`, `appwindows.test.ts`, `boundary.test.ts` |
| WSOS-SEC-002 strict CSP in the shipped bundle | `SHELL_CSP` (`webSecurity.ts`), build-only plugin in `shell/vite.config.ts` | `webSecurity.test.ts` |
| WSOS-SEC-003 default-deny web permissions, per-origin admin grants | `webSecurity.ts` `parseGrants`/`permissionAllowed`, `/etc/worksuite/web-permissions.json`, `appwindows.ts` | `webSecurity.test.ts`, `appwindows.test.ts` |
| WSOS-SEC-006 URL scheme allow-list | `webSecurity.ts` `externalAllowed` | `webSecurity.test.ts` |
| WSOS-SEC-013 no isolation claims for unsandboxed apps | `docs/security/hardening.md` | `tests/security/isolation-claims.test.sh` (CI) |
| WSOS-SEC-014 Secure Boot chain and key strategy | `docs/security/hardening.md`, `live-build/auto/config` | Hardware boot pending |
| WSOS-REL-004 killing Electron spares apps | `session.ts` app scopes | `tests/perf/guest/electron-kill` + `electron_kill_apps_lost` gate (`tests/perf/gates.tsv`, `gates.test.sh`) |
| WSOS-PRF-005 launcher first frame | `shell/src/lib/perfProbe.ts`, `screens/Desktop.tsx`, forwarding in `main.ts`, `measure-shell` | `perfProbe.test.ts`; `launcher_first_frame_ms` gate (hw, optional) |
| WSOS-ACC text size reflow, launcher dialog semantics | `shell/src/index.css` (`data-text-scale`), `lib/a11y.ts`, `screens/Desktop.tsx` | `lib/textScale.test.ts`, `lib/a11y.test.ts`, `a11y.axe.test.tsx` |

## ARM64 and performance gates

| Requirement | Implementation | Verified |
|---|---|---|
| WSOS-ARM-001/004/008 arm64 build + QEMU UEFI boot | `.github/workflows/image.yml` matrix (native `ubuntu-24.04-arm`), `tests/vm/qemu-arch.sh`, arch-aware `boot-test.sh`/`server-e2e.sh`, serial console per arch in `live-build/auto/config` | Workflow defined; not yet run green |
| WSOS-PRF-001…005, REL-001/002, ARM-007 | `tests/perf/guest/*` (probes on `WORKSUITE_PERF=1` images), `tests/perf/gates.tsv` (hw-* = SRS limits, ci-*-tcg = regression bounds, separate ARM rows), `tests/perf/gates.sh`, `boot-test.sh PERF_PROFILE=…` | `tests/perf/gates.test.sh` (CI); VM gates in `image.yml`, not yet run green |

## Architecture boundary, installer, updates and MDM

| Requirement | Implementation | Verified |
|---|---|---|
| WSOS-ARC-001 Electron main as user, no root command runner | `shell/electron/main.ts` (one `ipcMain.handle` behind `validSender`, `execFile` arrays), sandboxed windows, user unit `worksuite-shell.service`; the only elevation is `pkexec /usr/bin/worksuite-device-agent enroll` | `shell/electron/boundary.test.ts` |
| WSOS-ARC-003 native apps are compositor windows | `gtk-launch` in its own scope (`xdg.ts`, `session.ts`), labwc; no BrowserView/WebContentsView/webview/reparenting | `shell/electron/boundary.test.ts` |
| WSOS-ARC-004 desktop with remote services unreachable | shell loads `dist/index.html` from disk, CSP `'self'` only; CI boot test runs with `-nic none` | `boundary.test.ts`, `tests/vm/boot-test.sh` |
| WSOS-UPD-001 post-update health check | `services/package-service/src/coordinator.ts` (`health`: `dpkg --audit`, installed version = manifest, `healthCheck` env: failed WorkSuite units in `main.ts`); failure skips reboot, runs repair, reports `health_failures` for a signed rollback directive | `test/coordinator.test.ts` |
| WSOS-UPD-006 updates never delete user data/outbox/licences | update path runs only apt/flatpak/dpkg; no rm/autoremove/purge or user paths | `test/coordinator.test.ts` |
| WSOS-FLP-001 adding a remote: admin + policy | `AddRemote` (polkit `lk.worksuite.package.add-remote`, auth_admin) + policy `approved_remotes` and `flatpak_remotes` (exact https `.flatpakrepo` URL) | `test/features.test.ts`, `test/dbus.test.ts` |
| WSOS-MDM-001 hardware, software, versions, update status | `services/device-agent/src/inventory.ts` (sysfs DMI/disks/NICs/GPUs/batteries, firmware), `host.ts` inventory + `versions` + `update`; package service publishes `/run/worksuite-package-service/update-status.json` | `services/device-agent/test/inventory.test.ts` |
| WSOS-MDM-005 requested vs observed | `services/server/src/console.ts` (`observedCommand`, `observedPolicy`), `console-ui.ts` (Requested / Observed columns, policy requested vs observed) | `services/server/test/console.test.ts` |
| WSOS-INS-002 language, keyboard, timezone, first admin | `installer/settings.conf`, `modules/usersq.conf` (sudo group, root locked) | `installer/tests/test_config.py` |
| WSOS-INS-005 offline install | `packages.conf` remove-only, no internet requirement, unpack from ISO squashfs, bootloader packages in image | `installer/tests/test_config.py` (config); no install run in CI |
| WSOS-INS-007 fresh identity, no live credentials | `machineid.conf`, image hook empties machine-id, no `networkcfg` (live Wi-Fi secrets), `shellprocess-worksuite.conf` clears agent/enrollment/SSH host keys/NM connections | `installer/tests/test_config.py` |
| WSOS-INS-009 first-boot assistant | `shell/src/screens/FirstRun.tsx` + `FirstRunNetwork.tsx` (NetworkManager list/join, password on nmcli stdin), mode, sign-in, skip | `FirstRun.test.tsx` |
| WSOS-ARM-003 certified list, same gates as x86 | `tests/hw/gates.tsv`, `tests/hw/certified.tsv`, `tests/hw/probe.sh` | `tests/hw/test_hw.py` (no ARM machine qualified yet) |
| WSOS-ARM-008 arm64 VM tests | `tests/vm/vm.sh` now arch-aware via `qemu-arch.sh` | not yet run green |

# Setup app installation: end-to-end test, 2026-11-11

- **What ran:** the setup service's app engine (`services/setup/src/apps`), unchanged, driven by `tests/setup-apps/run.sh`.
- **Where:** a clean `debian:trixie` container (78 packages at the start), using the real `apt-get`, `dpkg` and `flatpak` binaries.
- **Bundled set:** the five published WorkSuite packages, checked against a `SHA256SUMS` file:
  - `worksuite` 0.2.300 (WorkSuite Desktop)
  - `worksuite-office` 10.1.20-1044
  - `worksuite-pos` 1.0.8
  - `worksuite-desk` 0.1.3
  - `worksuite-frameflow` 1.7.25
- **Third-party source:** VLC, from Debian's signed HTTPS repository.

## Results

| # | Scenario | Result |
|---|---|---|
| 1 | Offline setup with policy `setup_restricted_apps: [worksuite-desk]`, `software_install: approved`; selection: Office, POS, Desk, FrameFlow, VLC | **Pass.** Desktop (required), Office, POS and FrameFlow installed from the bundled files, one attempt each. Desk was skipped as `restricted` and VLC as `not_allowed`. |
| 2 | The same setup again | **Pass.** All four reported `already`; nothing was reinstalled. |
| 3 | Offline, VLC allowed but not bundled | **Pass.** VLC queued; the queue file holds `["vlc"]`. |
| 4 | Online: drain the queue | **Pass.** VLC 3.0.24-0+deb13u1 installed through signed APT; the queue is empty. |
| 5 | POS removed, then reinstalled from a bundled directory whose checksums don't match | **Pass.** It failed with "the bundled worksuite-pos_1.0.8_amd64.deb is missing or damaged". apt was never called and POS stayed uninstalled. |
| 6 | App whose package doesn't exist | **Pass.** One attempt, "its dependencies cannot be resolved: E: Unable to locate package …", and the run continued, since the app was optional. |
| 7 | System afterwards | **Pass.** `worksuite`, `worksuite-office`, `worksuite-frameflow` and `vlc` show `install ok installed`. Their binaries have 0 missing libraries, and their desktop entries are present. |

## Notes

- **Offline dependencies:** "offline" means no non-bundled source was used for the apps themselves. In this container, apt resolved the bundled packages' system dependencies from the Debian mirror. On WorkSuite OS those dependencies are already in the image (live-build hook `0200-worksuite-apps`).
- **Test-script bug found and fixed:** the script's own check first used `dpkg -s`, which also succeeds for a removed package whose config files remain. It now checks the `Status` field.
- **Engine bug found and fixed:** "already installed" apps reported source `apt` even when they came from the bundled files. They now report no source.
- **Unit tests:** `services/setup/test/apps.test.ts` covers the same rules with a fake package manager: policy, dependency order and cycles, retry with backoff, no retry for unresolvable packages, the offline queue and its drain, and refusal of damaged bundles.

## Log excerpt

```
======== 0. clean Debian 13 + signed HTTPS sources ========
======== 1. OFFLINE setup: Desktop+Office+POS+FrameFlow from verified bundled debs; Desk restricted; VLC not allowed ========
plan: worksuite-desktop* worksuite-office worksuite-pos worksuite-frameflow | skipped: [{"id":"worksuite-desk","why":"restricted"},{"id":"vlc","why":"not_allowe
  | WorkSuite Desktop: installing from bundled (attempt 1/3)
  | WorkSuite Desktop: installed
  | WorkSuite Office: installing from bundled (attempt 1/3)
  | WorkSuite Office: installed
  | WorkSuite POS: installing from bundled (attempt 1/3)
  | WorkSuite POS: installed
  | Worksuite FrameFlow: installing from bundled (attempt 1/3)
  | Worksuite FrameFlow: installed
======== 2. same setup again (idempotent): everything already installed ========
plan: worksuite-desktop* worksuite-office worksuite-pos worksuite-frameflow | skipped: []
  | WorkSuite Desktop: already installed
  | WorkSuite Office: already installed
  | WorkSuite POS: already installed
  | Worksuite FrameFlow: already installed
======== 3. OFFLINE third-party app on the allowlist: queued (no bundled copy) ========
plan: worksuite-desktop* vlc | skipped: []
  | WorkSuite Desktop: already installed
  | VLC: offline, queued for when the network is back
======== 4. back online: drain the queue (signed APT) ========
  | VLC: installing from apt (attempt 1/3)
  | VLC: installed
======== 5. tampered bundled package: refused, never handed to apt ========
plan: worksuite-desktop* worksuite-pos | skipped: []
  | WorkSuite Desktop: already installed
  | WorkSuite POS: the bundled worksuite-pos_1.0.8_amd64.deb is missing or damaged
ok: tampered pos not installed (deinstall ok config-files)
======== 6. unresolvable package: one attempt, clear reason, setup not failed (optional app) ========
  | WorkSuite Desktop: already installed
  | Broken app: installing from apt (attempt 1/3)
  | Broken app: attempt 1 failed: its dependencies cannot be resolved: E: Unable to locate package worksuite-no-such-package
======== 7. the real system afterwards ========
worksuite              install ok installed 0.2.300
worksuite-office       install ok installed 10.1.20-1044
worksuite-pos          deinstall ok config-files 1.0.8
worksuite-desk         not installed
worksuite-frameflow    install ok installed 1.7.25
vlc                    install ok installed 3.0.24-0+deb13u1
vlc-openbd.desktop vlc-opencda.desktop vlc-opendvd.desktop vlc-openvcd.desktop vlc.desktop worksuite-frameflow.desktop worksuite-office.desktop worksuite.deskto
```

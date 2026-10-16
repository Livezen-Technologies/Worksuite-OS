# WorkSuite OS

Debian 13 "trixie" desktop distribution that boots into the WorkSuite desktop (React 19 / Electron on Labwc)
and stays usable when the WorkSuite backend is unreachable. Requirements: SRS-WSOS-001 (release 1.0).

| Path | What |
| --- | --- |
| `shell/` | worksuite-shell — React 19 / TypeScript / Tailwind v4 renderer + hardened Electron main/preload. Screens: greeter, lock, first-run, desktop + launcher, Files, App Center, Settings, recovery launcher, installer |
| `native/wayland-bridge/`, `native/panel/` | Wayland bridge service (window list, tray watcher; Python) and notes on the panel, which is the shell's taskbar |
| `services/` | session units, user services, sync engine (SQLite outbox), package service, device agent |
| `api-contracts/` | OpenAPI for `desktop/v1` and the new `desktop/v1/os` group |
| `packaging/` | Debian packages incl. the `worksuite-desktop` metapackage |
| `live-build/`, `installer/` | ISO build (amd64, arm64, UEFI) and Calamares configuration |
| `docs/` | Requirements traceability; hardware acceptance checklist [`docs/testing/hardware-acceptance.md`](docs/testing/hardware-acceptance.md) with results template [`docs/testing/hardware-results-template.csv`](docs/testing/hardware-results-template.csv) |

## Shell

```sh
cd shell
npm install
npm run dev        # browser preview at http://localhost:5173 (?mode=installer, ?mode=recovery)
npm test           # unit tests
npm run build      # renderer + Electron main/preload
npm start          # run in Electron
```

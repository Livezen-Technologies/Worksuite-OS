# WorkSuite OS

Debian 13 "trixie" desktop distribution that boots into the WorkSuite desktop (React 19 / Electron on Labwc)
and stays usable when the WorkSuite backend is unreachable. Requirements: SRS-WSOS-001 (release 1.0).

| Path | What |
| --- | --- |
| `shell/` | worksuite-shell — React 19 / TypeScript / Tailwind v4 renderer + hardened Electron main/preload. Screens: greeter, lock, first-run, desktop + launcher, Files, App Center, Settings, recovery launcher, installer |
| `native/wayland-bridge/`, `native/panel/` | Wayland bridge service (window list, tray watcher; Python) and notes on the panel, which is the shell's taskbar |
| `services/` | session units, user services, sync engine (SQLite outbox), package service, device agent, on-device AI assistant (`services/ai`) |
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

### Desktop widgets

After sign-in the wallpaper shows WorkSuite Desktop's Home cards as widgets: At a glance (due today, meetings,
unread mail and chats), Today's work, Today's agenda, Waiting for me, Announcements, and on request Your daily
brief, Recent activity and Recent files. The main process (`shell/electron/widgets.ts`) reads the same platform
endpoints as Desktop's Home (`/api/dashboard/home`, `/api/dashboard/summary`, `/api/tasks`, `/api/calendar/events`,
`/api/hr/announcements/mine`, `/api/hr/approvals/pending`) with the credentials broker's token, which never reaches
the renderer; it caches the last answer per account in `~/.cache/worksuite/widgets` (dropped on sign-out) and the
renderer refreshes every 5 minutes and on reconnect. A module the person cannot open (404/403) has no widget.
Items open through the worksuite:// path: WorkSuite Desktop when installed, else the module's web app window.

Right-click the wallpaper (or the pencil above the widgets) for **Edit widgets** / **Add widgets**: remove, move
(drag, or the arrow buttons), wide/narrow, and the picker. The layout is saved in the synced `preferences/shell`
object (`widgets`), with a local copy. Signed out: one "Sign in to WorkSuite to see your widgets" card. Policy
`desktop_widgets: false` (admin console › Policy) turns them off; a kiosk never shows them. UI:
`shell/src/components/DesktopWidgets.tsx`, model `shell/src/lib/widgets.ts`, strings `shell/src/i18n/widgets.ts`.

### WhatsApp

WhatsApp has no native Linux app, so WorkSuite OS ships the official WhatsApp Web (https://web.whatsapp.com) as an
app: `worksuite-app whatsapp` (`lk.worksuite.whatsapp.desktop`, Network › Instant messaging) opens it in its own
window, app_id `lk.worksuite.whatsapp`, one instance. It is pinned to Start and the taskbar for new users (saved pins
are left alone) and listed in All apps and search. The window (`shell/electron/whatsappwindow.ts`, rules in
`shell/electron/whatsapp.ts`) uses its own persistent partition `persist:whatsapp`, so the QR link survives restarts
and nothing is shared with WorkSuite sign-in; it carries no WorkSuite token. Only WhatsApp's own https hosts
(`whatsapp.com`, `*.whatsapp.com`, `*.whatsapp.net`) load in the window; other links open in the default browser.
Notifications are allowed, camera and microphone are asked for (once per run), screen sharing goes through the
ScreenCast portal, nothing else is granted. Downloads go to ~/Downloads. The unread count from the page title
"(N) WhatsApp" shows as a badge on the taskbar button and as a notification that focuses the window. Closing the
window quits it, like the WorkSuite app windows. Policy `whatsapp: false` (admin console › Policy) removes it; a
kiosk never shows it.

## Third-party notices

- WhatsApp and the WhatsApp logo are trademarks of WhatsApp LLC (Meta Platforms, Inc.). WorkSuite OS is not
  affiliated with or endorsed by them; the logo (`shell/apps/icons/lk.worksuite.whatsapp.svg`, glyph from Simple
  Icons, CC0) is used only as the launcher icon that identifies the WhatsApp Web app.

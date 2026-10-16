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

### Desktops and Task View

Virtual desktops work like Windows 11. **Super+Tab** (or the Task View button next to Search, or a three-finger swipe
up) opens Task View: the desktop's open windows as cards, and a strip of desktops with **New desktop**. Click a window
to focus it; drag it onto a desktop to move it; right-click for **Move to**, **Show this window on all desktops** and
**Show windows from this app on all desktops**. Right-click a desktop for **Rename** (or double-click its name, or F2),
**Choose background**, **Move left/right** (or drag, or Alt+Shift+Left/Right) and **Close**. Esc closes Task View.
**Ctrl+Super+D** adds a desktop, **Ctrl+Super+F4** closes the current one (its windows go to the desktop on its left),
**Ctrl+Super+Left/Right** switch (the name shows briefly; the wallpaper slides unless motion is reduced),
Super+1…9 / Super+Shift+1…9 go to or send the window to a desktop. 1 to 16 desktops; one to start with. Hover the
Task View button for a flyout of desktops. Settings › Multitasking: the Task View button, and whether the taskbar and
Alt+Tab show windows from only the current desktop (default) or all. Names, order, count, wallpapers and apps on all
desktops are kept in the synced `preferences/shell` object and restored at sign-in. A kiosk has one desktop and no
Task View.

Labwc 0.8 fixes the desktop count in rc.xml and does not report a window's desktop, so the Wayland bridge
(`native/wayland-bridge/worksuite_bridge/workspace.py`) tracks windows, rewrites `<desktops>` in
`~/.config/worksuite/labwc/rc.xml` and reloads Labwc (`labwc --reconfigure`), moving windows to their final desktop
first because Labwc drops surplus desktops from the end. Labwc 0.8 cannot capture single windows, so window cards show
the app icon and title, and the current desktop's card a small capture of the screen (`grim`, in memory only).

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
"(N) WhatsApp" shows as a badge on the taskbar button; notifications are WhatsApp Web's own, one per message. Closing the
window quits it, like the WorkSuite app windows. Policy `whatsapp: false` (admin console › Policy) removes it; a
kiosk never shows it.

## Third-party notices

- WhatsApp and the WhatsApp logo are trademarks of WhatsApp LLC (Meta Platforms, Inc.). WorkSuite OS is not
  affiliated with or endorsed by them; the logo (`shell/apps/icons/lk.worksuite.whatsapp.svg`, glyph from Simple
  Icons, CC0) is used only as the launcher icon that identifies the WhatsApp Web app.

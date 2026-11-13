# One WorkSuite Settings window: phased plan

Goal: Network, Wi-Fi, Bluetooth, Display, Sound, Power, Personalization, Accessibility, Updates, Drivers and Accounts
are all configured inside the WorkSuite Settings window under GNOME. GNOME's panels (`gnome-control-center <panel>`)
remain only as a clearly labelled, temporary fallback for settings that are not yet safe to drive natively. No control
is shown unless it changes the real system setting; every panel reads its state back from the backend after a change.

## Where it stands (commit 8f37bbc)

- One launcher: GNOME Settings' launcher is diverted and opens WorkSuite Settings; WorkSuite Settings lists every
  section (tests/session/one-settings-test.sh).
- Native under GNOME today: Personalization (gsettings, dash-to-panel, arcmenu, blur-my-shell), Accessibility
  (gsettings), Updates, Drivers, Devices, Privacy & security, Managed, Users, Graphics, AI.
- Opens the GNOME panel today: Network, VPN, Bluetooth, Display, Sound, Power, Notifications, Multitasking, Printers,
  Keyboard, Mouse & touchpad, Touchscreen & pen, Appearance, Lock screen, Clipboard, Date & time, Default apps, About.

Key finding: the WorkSuite panels for the most-used of these already exist (written for the Labwc session) and use
session-independent system services. They are hidden under GNOME only by the handoff in Settings.tsx.

| Section | Existing WorkSuite panel backend | Works under GNOME as is? |
|---|---|---|
| Network, Wi-Fi, VPN | NetworkManager (`nmcli`, electron/system.ts) | Expected yes: NM is session-independent |
| Bluetooth | BlueZ (`bluetoothctl`, peripherals.ts/system.ts) | Expected yes |
| Sound | PipeWire/WirePlumber (`wpctl`, system.ts) | Expected yes |
| Power | power-profiles-daemon + UPower | Expected yes; screen-blank/suspend timeouts need GNOME's gsettings keys under GNOME |
| Date & time | systemd-timedated (`timedatectl`) | Expected yes; 24-hour clock is a GNOME gsettings key |
| Display | `wlr-randr` (Labwc only) | No: GNOME needs Mutter's `org.gnome.Mutter.DisplayConfig` |
| Keyboard, Mouse, Touch | Labwc rc.xml | No: GNOME uses `org.gnome.desktop.peripherals.*` / input-sources gsettings |
| Appearance, Lock screen, Notifications, Multitasking, Clipboard | Labwc / WorkSuite shell | Need GNOME gsettings equivalents |
| Printers, Default apps | CUPS / mimeapps | Printers: CUPS is session-independent; Default apps: xdg-mime |

"Expected yes" is not "verified": each moves out of the handoff only after a VM test of read, change, read-back,
persistence after reboot, and the permission prompt (polkit) where one applies.

## Phase 1: switch on the existing native panels (smallest change, most-used settings)

Network & Wi-Fi & VPN, Bluetooth, Sound, Power (profiles, battery), Date & time.

- Change: add them to the native set in GnomeHandoff.tsx; no new backend code.
- Per panel VM test: list and connect Wi-Fi (or wired in QEMU), toggle Bluetooth (no adapter in QEMU: the panel must say
  so, not show a dead switch), change output volume and default device, switch power profile, set time zone and NTP.
- Cost: no new processes; each panel already polls only while it is open.
- Fallback stays for anything a test shows missing (e.g. 802.1X enterprise Wi-Fi: "More options" opens the GNOME
  Network panel, labelled as such).

## Phase 2: GNOME-native backends for desktop-specific settings (GSettings)

Keyboard (layouts via `org.gnome.desktop.input-sources`, repeat, shortcuts), Mouse & touchpad
(`org.gnome.desktop.peripherals.mouse/touchpad`), Appearance (dark/light `color-scheme`, accent, wallpaper picker
over `org.gnome.desktop.background` with the four WorkSuite wallpapers), Lock screen (`org.gnome.desktop.screensaver`,
`org.gnome.desktop.session idle-delay`), Notifications (`org.gnome.desktop.notifications`), Multitasking
(`org.gnome.mutter`), Power timeouts (`org.gnome.settings-daemon.plugins.power`), 24-hour clock.

- Same pattern as desktopLook.ts/a11y.ts: an allow-list of schema/key/value, JSON over IPC, read-back after each set.
- The Labwc implementations stay for the Labwc session; the panel picks the backend by session.

## Phase 3: Display (Mutter DisplayConfig)

Resolution, refresh rate, scale, orientation, primary display and arrangement for several monitors through
`org.gnome.Mutter.DisplayConfig` (`GetCurrentState` / `ApplyMonitorsConfig` with method 1 = temporary, then 2 =
persistent after the person confirms, with GNOME's revert-on-timeout behaviour so a bad mode cannot lock them out).
Tested with QEMU `virtio-vga` `max_outputs=2`.

## Phase 4: the rest, then retire the fallback

Printers (CUPS via `lpstat`/`lpadmin` behind polkit, or keep GNOME's panel), Default apps (`xdg-mime`), About
(hostnamectl, os-release), Sharing/Privacy extras. Only when every section is native and VM-tested is the "Open the
system panel" fallback removed; gnome-control-center can then become a recommends rather than a dependency.

## Constraints kept throughout

- Backends are the system's (NetworkManager, BlueZ, PipeWire, UPower, power-profiles-daemon, timedated, Mutter,
  GSettings); nothing is reimplemented.
- Privileged changes go through polkit as today; no new setuid helpers, no AppArmor or signature relaxations.
- Low resource use: no resident helper processes; panels poll or subscribe only while visible.
- Each phase ships with unit tests for the allow-lists and a VM run with screenshots before it is called done.

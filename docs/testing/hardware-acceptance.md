# Hardware and manual acceptance checklist

This checklist covers every row in [`docs/srs-gap-analysis.md`](../srs-gap-analysis.md) that is **Partial** only because it needs real hardware or a person. CI cannot close these rows. A row moves to Done when a run here passes and its evidence is recorded.

## How to record results

- Copy [`hardware-results-template.csv`](hardware-results-template.csv) to `results-<date>-<device>.csv`. Add one line per check and metric. `result` is `pass`, `fail` or `blocked`.
- Put the evidence (command output, screenshots, short videos) next to the CSV and name it in the `evidence` column. Never record passphrases, recovery keys, PINs or tokens.
- Write down the image version (`cat /etc/os-release`), the kernel (`uname -r`) and the device model (`cat /sys/class/dmi/id/product_name`).
- Common commands:
  - `systemd-analyze`, `systemd-analyze blame`, `systemd-analyze critical-chain greetd.service`
  - `tests/perf/guest/measure-boot`, `measure-shell`, `login-cycles`, `suspend-cycles`, `electron-kill` (they are installed on the `-perf` image and also run by `worksuite-perf.service`)
  - `tests/perf/gates.sh` with profile `hw-amd64` or `hw-arm64` from `tests/perf/gates.tsv`
  - `tests/hw/probe.sh` for the hardware gates in `tests/hw/gates.tsv`; add the machine to `tests/hw/certified.tsv` only when every gate passes
  - The System monitor app (`shell/src/screens/Monitor.tsx`), **Health** tab: take a screenshot after each run (failed units, memory, CPU, update health)
  - `journalctl -b -p warning`, `systemctl --failed`, `loginctl list-sessions`

## Equipment

| Profile | Minimum |
|---|---|
| Reference laptop (`hw-amd64`) | Recent x86-64 laptop, 4+ cores, 16 GB RAM, NVMe SSD, Intel or AMD iGPU with a DRM driver, UEFI with Secure Boot, Wi-Fi, Bluetooth, webcam |
| Low-end device | 2-core x86-64, 4 GB RAM, eMMC or SATA SSD, iGPU |
| ARM64 device (`hw-arm64`) | UEFI arm64 machine (for example a Snapdragon X laptop or a SystemReady board) with a DRM GPU |
| Peripherals | Two external monitors (HDMI/DP, one 4K), USB-C dock, IPP Everywhere printer, Bluetooth headset, mouse and keyboard, PIV smart card and CCID reader, FIDO2 key, USB stick of 8 GB or more |
| Network | Wi-Fi AP, a captive-portal AP (hotel-style login page), WireGuard and OpenVPN test servers |
| Server | A WorkSuite test org with two admin accounts that hold `desktop.devices.wipe` |

---

## 1. Performance (WSOS-PRF-001…006, WSOS-REL-001, WSOS-REL-004)

Run on the reference laptop **and** on the low-end device. Install the `-perf` image to disk. Do 5 cold boots and record the median.

| ID | Title | SRS limit | How to measure |
|---|---|---|---|
| WSOS-PRF-001 | Greeter visible | ≤ 30 s from power-on | `tests/perf/guest/measure-boot`; check `systemd-analyze` (firmware + loader + kernel + userspace) and greetd ActiveEnter |
| WSOS-PRF-002 | Login to usable desktop | ≤ 5 s | Sign in with `WORKSUITE_PERF=1`; `tests/perf/guest/measure-shell` → `shell_ready_ms`. Also time from pressing Enter at the greeter to the panel with a screen recording |
| WSOS-PRF-003 | Idle memory | ≤ 1.5 GiB (1536 MiB) | After sign-in, wait 60 s idle, then `idle_mem_mib` (MemTotal − MemAvailable) from `measure-shell`; compare with the Health tab |
| WSOS-PRF-004 | Idle CPU | < 2 % | `idle_cpu_pct` over 30 s idle with the desktop shown; cross-check with `top -b -d 30 -n 2` |
| WSOS-PRF-005 | Launcher first frame | ≤ 200 ms | Press Super 10 times; read `launcher_first_frame_ms` from the shell output (`journalctl --user -u worksuite-shell`); record the median and the worst |
| WSOS-PRF-006 | Shell restart | ≤ 3 s | `pkill -KILL -f worksuite-shell`; time until the panel comes back (`journalctl --user -u worksuite-shell -o short-monotonic`) |

Steps:
1. Boot the `-perf` image 5 times from power-off. Save the `systemd-analyze` and `measure-boot` output each time.
2. Sign in, run `measure-shell`, open the launcher 10 times, and kill the shell once.
3. Run `tests/perf/gates.sh` with `hw-amd64` (or `hw-arm64`) on the results.

Pass: every limit above is met on the reference laptop. On the low-end device, record the numbers. A miss there must be filed as a known limitation, but it does not block the row.

Also run:
- **WSOS-REL-001**: 100 sign-in/sign-out cycles. Use `login-cycles` with N=100 for PAM/logind, plus 10 real greeter sign-ins by hand. Pass: 0 failures, 0 leaked sessions (`loginctl`), no new failed units, and memory growth within the gate.
- **WSOS-REL-004**: run `electron-kill` inside a graphical session with a real app open. Pass: `electron_kill_apps_lost == 0` and the app window is still there.

## 2. Suspend/resume, 50 cycles (WSOS-REL-002)

Equipment: the reference laptop, on battery and on AC. Repeat on the ARM64 device.

1. Sign in and open Files, a WorkSuite web app and a terminal.
2. Run `sudo tests/perf/guest/suspend-cycles 50` (rtcwake s2idle). Then do 5 lid-close cycles by hand.
3. After every resume, the lock screen must show before any desktop content.

Pass: 50/50 resumes; `LockedHint=yes` after each one (`loginctl show-session <id> -p LockedHint`); Wi-Fi reconnects within 10 s; no new failed units; the apps are still running.
Record: the `suspend-cycles` output, `journalctl -b | grep -iE 'suspend|resume'`, and a Health tab screenshot.

## 3. Screen sharing with a GPU (§7.1 Meet screencast, §7.1 portal acceptance, WSOS-DSK-013)

Equipment: the reference laptop (GPU render node `/dev/dri/renderD128`) and an external monitor.

1. Run `tests/portals/run.sh` on the machine. The ScreenCast stream case must run now instead of being skipped.
2. Open Meet and start sharing. The `worksuite-screencast-chooser` consent must appear every time. Pick a monitor; a remote participant must see it.
3. Deny once. Pass if no stream starts.
4. While sharing, click **Stop sharing** in the panel badge. Pass if the stream ends within 1 s, the badge goes away, and `pw-dump` shows no xdpw stream node.
5. Share again, lock with Super+L, and press Super+Shift+Esc on the lock screen. Pass if the stream ends (needs Labwc ≥ 0.8; record `labwc --version`).
6. Through the portal, open and save a file from a Flatpak app, drag a file from Files into a web app, and print a page (see section 11).

Record: a screen recording of steps 2–5 and the `run.sh` output.

## 4. Smart-card sign-in (WSOS-DIR-011)

Equipment: a PIV card with a certificate from a test CA (UPN `user@domain`), a CCID reader, and the CA certificate plus its CRL.

1. Run `sudo worksuite-smartcard-setup enable` with the CA, then `worksuite-smartcard-setup status`.
2. Check `pcsc_scan` (the card is seen) and `pkcs11-tool --list-objects`.
3. At the greeter, insert the card and enter the PIN. Pass if you are signed in as the mapped user.
4. Negative cases: wrong PIN (refused, faillock counts it), revoked certificate (refused), certificate from another CA (refused), card removed while signed in (record what happens).
5. Run `worksuite-smartcard-setup disable`. Pass if password sign-in still works.

## 5. Passkeys / FIDO2 (WSOS-DIR-009)

Equipment: a FIDO2 key (USB, and NFC if possible).

1. In a WorkSuite web-app window and on the OneAuth sign-in page, register a passkey and sign in with it.
2. At the greeter, passkeys are not implemented yet. Record `blocked`, not `fail`.
3. TOTP at the greeter: enroll with `worksuite-server totp-enroll`, sign in with a code, and check that a reused code is refused.

## 6. ARM64 devices (WSOS-ARM-001/002/003/004/007/008)

1. Boot the arm64 ISO that `image.yml` built from the same tag as amd64 (compare `/etc/os-release`). It must boot through UEFI only.
2. Run `tests/hw/probe.sh`. Gates: UEFI, GPU with a hardware DRM driver, Wi-Fi scan, 3× suspend/resume, audio, storage.
3. Install, then do sections 1 (with the `hw-arm64` profile), 2 and 13.
4. Check that the shell and the services are native: `file` on the shell binary shows aarch64.

Pass: every probe gate passes. Add the device to `tests/hw/certified.tsv` with the evidence.

## 7. Orca screen-reader walkthrough (WSOS-ACC-001…006)

Equipment: the reference laptop and headphones. Turn on Orca from the accessibility panel on the greeter.

With the **keyboard only** and Orca on, go through: greeter → sign in → launcher (search, open an app) → taskbar and tray (arrow keys) → Settings (every page) → App Center (search, install) → Files → lock and unlock → installer (from the live ISO).

Pass: every control can be reached with Tab or the arrow keys; focus is always visible; Orca reads the name, role and state of each control; dialogs keep focus inside and return it on close. Record each finding with its screen and control.

## 8. High contrast and 200 % text (WSOS-ACC-001…006)

1. Turn on high contrast, set text size to 200 %, and turn on reduced motion.
2. Visit every screen from section 7 at 1366×768 and at 1920×1080.

Pass: no clipped or overlapping text, no horizontal scrolling inside dialogs, every button label readable, and no animations with reduced motion on. Take a screenshot of each screen.

## 9. Sinhala and Tamil native review (§11.5, WSOS-INT-011)

Follow [`docs/i18n/README.md`](../i18n/README.md). A native speaker of each language must:
1. Install in Sinhala, then in Tamil, and read every installer screen.
2. Read every shell screen, and set `review.reviewed: true` only for the strings they checked.
3. Type Sinhala (Wijesekara and phonetic) and Tamil (Tamil99 and phonetic) with fcitx5 in Files, a web app, a GTK app and a Qt app, and switch layouts with the keyboard shortcut.
4. Check date, number and currency formats.

Pass: no wrong or untranslated strings left, and typing works in every app type.

## 10. Multi-monitor hotplug (WSOS-DSK-005/006/007)

Equipment: the reference laptop, two external monitors and a USB-C dock.

1. Plug in each monitor, then both through the dock. Each output must get its own panel and background.
2. Set scale to 100, 150 and 200 %; arrange, mirror and extend; sign out and in. The settings must persist per monitor.
3. Unplug while windows are on the external monitor. The windows and the launcher must move to the remaining output within 2 s.
4. Unplug and replug 20 times. Then suspend while docked and resume undocked.

Pass: no lost windows, no crash (`coredumpctl list` is empty), and the panel is correct after every change.

## 11. Printers and Bluetooth (WSOS-INT-006, WSOS-INT-003)

Printing: in Settings › Devices › Print queue, add an IPP Everywhere printer found on the network and one more by `ipps://` address. Print a test page, a PDF from Files, and a page from a web app. Pass: all three print correctly.

Bluetooth: pair a headset (audio must play through it), a mouse, and a keyboard that needs a passkey. The current agent is NoInputNoOutput, so the keyboard must show a clear message; record that as a known limitation. Then set policy `bluetooth: false`. Pass if the radio is blocked (`rfkill list`) and Settings shows it as disabled by policy.

## 12. VPN, captive portal and kill switch (WSOS-INT-001)

1. Import a WireGuard and an OpenVPN profile in Settings › Network. Connect, then check the public IP from the test server and `resolvectl status`.
2. With the kill switch on, stop the VPN server. Pass if no traffic leaves outside the tunnel (`tcpdump -i <wifi-if> not port <vpn-port>` shows nothing).
3. Join the captive-portal AP. Pass if the sign-in page opens, the kill switch lets only the portal traffic through, and the VPN connects after the portal sign-in.

## 13. Encrypted install, single passphrase and recovery key (WSOS-BOOT-002, WSOS-INS-001, WSOS-INS-005)

1. Install offline (no network cable, Wi-Fi off) with encryption on.
2. The recovery key is shown once. Keep it in the test vault, never in the results.
3. Reboot. Pass if the passphrase is asked for once (in the initramfs) and you reach the greeter with no second prompt.
4. Reboot and unlock with the recovery key instead. Pass if it boots.
5. `sudo cryptsetup luksDump /dev/<partition>` shows LUKS2 with two key slots.
6. Install again without encryption and check that it boots.

## 14. Reinstall keeping home (§9.2-R6, §9.2-R3)

1. Create files in `~/Documents`, and make a Drive-synced change while offline.
2. Boot the GRUB entry **WorkSuite Recovery**. Pass if the recovery screens show.
3. Choose Reset → **Keep my files**.

Pass: the system reinstalls; after sign-in every file is there with the same owner and UID; the sync outbox is sent once online.

## 15. Update failure path (WSOS-UPD-001, §9.2-R4, WSOS-APT-006)

1. Pull the power while an update applies (during dpkg). On the next boot, `worksuite-boot-repair.service` must finish dpkg (`dpkg --audit` prints nothing).
2. Install a test update with a broken kernel or graphics driver. Pass if the post-update health check fails and the previous-kernel GRUB entry boots a working desktop.
3. Try to update with the battery under 40 % and no AC. Pass if the update is refused with a clear message.
4. Pass if the result, with OS, shell and kernel versions, shows in the admin console.

## 16. Remote wipe with two admins (WSOS-WIPE-001…008)

Equipment: an encrypted, enrolled install and two admin accounts.

1. Admin A requests a full wipe, signs in again and types the device name. Pass if nothing runs before admin B approves.
2. Admin B approves. Pass if the device reports `started` and the LUKS key slots are destroyed (the disk cannot be unlocked with the passphrase or the recovery key).
3. Repeat with a data wipe on another enrolled device. Pass if tokens, the database, Drive files and caches are gone for every user, and the local accounts are kept.
4. Try a full wipe on an unencrypted install. Pass if it is refused with NOT_ENCRYPTED.
5. Pass if the console audit log has every step and the device is marked wiped.

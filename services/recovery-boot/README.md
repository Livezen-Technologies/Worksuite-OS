# worksuite-recovery-boot

Recovery boot path (SRS §9.2, WSOS-BOOT-003).

| File | Installed as | Role |
|---|---|---|
| `grub/42_worksuite_recovery` | `/etc/grub.d/` | Top-level GRUB entries "WorkSuite Recovery" (newest kernel, `systemd.unit=worksuite-recovery.target worksuite.recovery=1`) and "WorkSuite OS (previous kernel X)". |
| `grub/05_worksuite_bootcheck` + `systemd/worksuite-boot-ok.service` | `/etc/grub.d/`, system unit (graphical.target) | G13 failed-start fallback: GRUB writes `worksuite_boot_ok=0` to grubenv each start and the unit sets it to 1 once the system is up. If GRUB still finds 0, it selects the previous-kernel entry, counts down 8 s and loads `theme-failed.txt` (warning banner). Skipped when grubenv can't be written (LUKS, LVM, btrfs `/boot`). |
| `kernel/zz-worksuite-kernel-retention` | `/etc/kernel/postinst.d/`, `/etc/kernel/postrm.d/` | Regenerates `/etc/apt/apt.conf.d/01worksuite-kernel-retention`: `APT::NeverAutoRemove` for the two newest kernels and the running one. |
| `systemd/worksuite-recovery.target` | system unit | Isolatable target: multi-user without the greeter, plus the recovery shell and boot repair. |
| `systemd/worksuite-recovery-shell.service` | system unit | `worksuite-cage` + `worksuite-shell --recovery` on tty1 as the unprivileged `worksuite-recovery` user. The shell also switches to recovery when `/proc/cmdline` has `worksuite.recovery=1` (`shell/electron/bootmode.ts`). |
| `bin/worksuite-boot-repair` + `systemd/worksuite-boot-repair.service` | `/usr/libexec/worksuite/`, enabled in `multi-user.target` | Before the greeter: when `dpkg --audit` reports an interrupted run or `/var/lib/worksuite/repair-on-boot` exists, runs `dpkg --configure -a` and `apt-get -f install`. On failure the unit isolates `worksuite-recovery.target`. |

Tests: `tests/boot/recovery-boot.test.sh` (runs the GRUB script, retention hook and repair script against stub
`/boot` trees and stub dpkg/apt-get).

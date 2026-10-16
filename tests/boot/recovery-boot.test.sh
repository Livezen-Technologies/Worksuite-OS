#!/bin/sh
# Recovery boot pieces (WSOS-BOOT-003, SRS §9.2) against stub /boot trees and stub dpkg/apt-get. No root needed.
#   tests/boot/recovery-boot.test.sh
set -eu
here=$(cd "$(dirname "$0")/../.." && pwd)
rb="$here/services/recovery-boot"
t=$(mktemp -d); trap 'rm -rf "$t"' EXIT
fail=0
check() { if eval "$2"; then echo "ok - $1"; else echo "not ok - $1"; fail=1; fi; }

mkdir -p "$t/boot"
for v in 6.12.38+deb13-amd64 6.12.41+deb13-amd64 6.12.9+deb13-amd64; do : > "$t/boot/vmlinuz-$v"; : > "$t/boot/initrd.img-$v"; done
: > "$t/boot/vmlinuz-6.12.50+deb13-amd64"   # no initrd: not offered

# GRUB entries
out=$(WORKSUITE_BOOT_DIR="$t/boot" GRUB_DEVICE_UUID=1234-abcd GRUB_CMDLINE_LINUX_DEFAULT="quiet splash" sh "$rb/grub/42_worksuite_recovery")
check "recovery entry exists" 'echo "$out" | grep -q "^menuentry '"'"'WorkSuite Recovery'"'"'"'
check "recovery entry boots the newest kernel with an initrd into the recovery target" \
  'echo "$out" | grep -q "vmlinuz-6.12.41+deb13-amd64 root=UUID=1234-abcd ro .*systemd.unit=worksuite-recovery.target worksuite.recovery=1"'
check "previous kernel entry" 'echo "$out" | grep -q "WorkSuite OS (previous kernel 6.12.38+deb13-amd64)"'
check "kernel without initrd skipped" '! echo "$out" | grep -q 6.12.50'
check "version order is not lexical" '! echo "$out" | grep -q "previous kernel 6.12.9"'
mkdir -p "$t/empty"
check "no kernels, no entries" '[ -z "$(WORKSUITE_BOOT_DIR="$t/empty" sh "$rb/grub/42_worksuite_recovery")" ]'

check "no boot-details entry unless an administrator turned it on" '! echo "$out" | grep -q "show boot details"'
: > "$t/details"
det=$(WORKSUITE_BOOT_DIR="$t/boot" WORKSUITE_BOOT_DETAILS_FLAG="$t/details" GRUB_DEVICE_UUID=1234-abcd sh "$rb/grub/42_worksuite_recovery")
check "boot-details entry: newest kernel, no splash, systemd status shown" \
  'echo "$det" | grep -q "WorkSuite OS (show boot details)" && echo "$det" | grep "vmlinuz-6.12.41" | grep -q "nosplash systemd.show_status=true" && ! echo "$det" | grep "show_status=true" | grep -q " quiet"'
check "row icons: recovery and previous classes" 'echo "$out" | grep -q "class ws-recovery" && echo "$out" | grep -q "class ws-previous"'

# G13 failed-start fallback
bc=$(WORKSUITE_BOOT_DIR="$t/boot" GRUB_THEME=/usr/share/grub/themes/worksuite/theme.txt sh "$rb/grub/05_worksuite_bootcheck")
check "failed start selects the previous kernel" 'echo "$bc" | grep -q "set default=\"worksuite-previous-6.12.38+deb13-amd64\""'
check "failed start loads the banner theme" 'echo "$bc" | grep -q "theme=\"/usr/share/grub/themes/worksuite/theme-failed.txt\""'
check "each start is marked pending" 'echo "$bc" | grep -q "^save_env worksuite_boot_ok"'
check "one kernel: no fallback" '[ -z "$(WORKSUITE_BOOT_DIR="$t/empty" sh "$rb/grub/05_worksuite_bootcheck")" ]'
check "success unit clears the mark" 'grep -q "grub-editenv /boot/grub/grubenv set worksuite_boot_ok=1" "$rb/systemd/worksuite-boot-ok.service"'

# Kernel retention
WORKSUITE_BOOT_DIR="$t/boot" WORKSUITE_APT_CONF="$t/keep.conf" WORKSUITE_RUNNING=6.12.9+deb13-amd64 sh "$rb/kernel/zz-worksuite-kernel-retention"
check "newest kept" 'grep -qF "\"^linux-image-6\.12\.50\+deb13-amd64\$\";" "$t/keep.conf"'
check "previous kept" 'grep -qF "\"^linux-image-6\.12\.41\+deb13-amd64\$\";" "$t/keep.conf"'
check "running kept" 'grep -qF "\"^linux-image-6\.12\.9\+deb13-amd64\$\";" "$t/keep.conf"'
check "older not pinned" '! grep -q "38" "$t/keep.conf"'
if command -v apt-config >/dev/null; then
  check "apt parses the retention file" 'APT_CONFIG="$t/keep.conf" apt-config dump APT::NeverAutoRemove >/dev/null'
fi

# Boot repair with stub dpkg/apt-get
mkdir -p "$t/bin"
cat > "$t/bin/dpkg" <<'EOF'
#!/bin/sh
echo "dpkg $*" >> "$STUB_LOG"
case "$1" in
  --audit) [ -e "$STUB_DIRTY" ] && echo "The following packages are only half configured:" ; exit 0 ;;
  --configure) [ -e "$STUB_BROKEN" ] && exit 1; rm -f "$STUB_DIRTY"; exit 0 ;;
esac
EOF
printf '#!/bin/sh\necho "apt-get $*" >> "$STUB_LOG"\n[ -e "$STUB_BROKEN" ] && exit 100\nexit 0\n' > "$t/bin/apt-get"
chmod +x "$t/bin/dpkg" "$t/bin/apt-get"
repair() { PATH="$t/bin:$PATH" STUB_LOG="$t/log" STUB_DIRTY="$t/dirty" STUB_BROKEN="$t/broken" \
  WORKSUITE_REPAIR_FLAG="$t/flag" WORKSUITE_RUN_DIR="$t/run" sh "$rb/bin/worksuite-boot-repair" >/dev/null; }
: > "$t/log"; repair
check "clean system: no repair run" '[ "$(cat "$t/run/boot-repair")" = clean ] && ! grep -q configure "$t/log"'
: > "$t/dirty"; repair
check "interrupted dpkg is repaired" '[ "$(cat "$t/run/boot-repair")" = repaired ] && grep -q "dpkg --configure -a" "$t/log" && grep -q "apt-get .*-f install" "$t/log"'
: > "$t/flag"; repair
check "requested repair runs and clears the flag" '[ "$(cat "$t/run/boot-repair")" = repaired ] && [ ! -e "$t/flag" ]'
: > "$t/dirty"; : > "$t/broken"
check "failed repair exits non-zero (unit isolates recovery)" '! repair && [ "$(cat "$t/run/boot-repair")" = failed ]'

# Units
check "recovery target isolatable and conflicts with greeter" 'grep -q "^AllowIsolate=yes" "$rb/systemd/worksuite-recovery.target" && grep -q "Conflicts=greetd.service" "$rb/systemd/worksuite-recovery.target"'
check "repair failure isolates recovery" 'grep -q "^OnFailure=worksuite-recovery.target" "$rb/systemd/worksuite-boot-repair.service"'
exit $fail

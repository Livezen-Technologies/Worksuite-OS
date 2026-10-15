#!/bin/sh
# Reinstall keeping /home (SRS §9.2-R6): services/recovery-boot/bin/worksuite-reinstall.
#   tests/boot/reinstall-keep-home.test.sh
# Part 1 (no root): /home inside the root file system, reimaged in a directory.
# Part 2 (root with loop devices, cryptsetup, sfdisk): a partitioned disk image, root ext4 on partition 1 and /home
# ext4 inside LUKS2 on partition 2; the script finds the root by itself. Skipped when not root.
# shellcheck disable=SC2034,SC2016 # variables are read inside check's eval
set -eu
here=$(cd "$(dirname "$0")/../.." && pwd)
re="$here/services/recovery-boot/bin/worksuite-reinstall"
t=$(mktemp -d)
loop='' mapper=''
cleanup() {
    [ -n "$mapper" ] && cryptsetup close "$mapper" 2>/dev/null || true
    [ -n "$loop" ] && losetup -d "$loop" 2>/dev/null || true
    rm -rf "$t"
}
trap cleanup EXIT
fail=0
check() { if eval "$2"; then echo "ok - $1"; else echo "not ok - $1"; fail=1; fi; }

# Recovery image: a new system with a /home that must never be unpacked over the user's.
mkdir -p "$t/img/etc" "$t/img/usr/bin" "$t/img/home/live"
printf 'ID=worksuite\nVERSION_ID="1.1"\n' > "$t/img/etc/os-release"
printf 'new\n' > "$t/img/usr/bin/tool"; printf 'live\n' > "$t/img/home/live/x"
printf 'image fstab\n' > "$t/img/etc/fstab"; printf 'root:x:0:0::/root:/bin/sh\n' > "$t/img/etc/passwd"
mksquashfs "$t/img" "$t/fs.squashfs" -quiet -noappend >/dev/null

old_system() {  # $1 root dir; $2 fstab
    mkdir -p "$1/etc" "$1/usr/bin" "$1/var/junk" "$1/home"
    printf 'ID=worksuite\nVERSION_ID="1.0"\n' > "$1/etc/os-release"
    printf '%s\n' "$2" > "$1/etc/fstab"
    printf 'root:x:0:0::/root:/bin/sh\nann:x:1000:1000::/home/ann:/bin/sh\n' > "$1/etc/passwd"
    printf 'ann-laptop\n' > "$1/etc/hostname"
    printf 'old\n' > "$1/usr/bin/tool"; printf 'broken\n' > "$1/var/junk/x"
}

# ---- argument and confirmation checks (no root) ----
rc=0; "$re" --mode erase --disk vda --confirm vdb >/dev/null 2>&1 || rc=$?
check "erase refuses a wrong typed disk name" '[ "$rc" = 3 ]'
rc=0; "$re" --mode erase --disk vda >/dev/null 2>&1 || rc=$?
check "erase refuses without a typed disk name" '[ "$rc" = 3 ]'
rc=0; WORKSUITE_INSTALLER=true "$re" --mode erase --disk vda --confirm vda >/dev/null 2>&1 || rc=$?
check "erase with the right name hands over to the installer" '[ "$rc" = 0 ]'
rc=0; "$re" --mode keep --disk 'vda;rm' >/dev/null 2>&1 || rc=$?
check "bad disk name refused" '[ "$rc" = 2 ]'
rc=0; "$re" --mode keep --disk vda --target-dir "$t" --source "$t/none" >/dev/null 2>&1 || rc=$?
check "no recovery image refused" '[ "$rc" = 4 ]'
rc=0; "$re" --mode keep --disk vda --target-dir / --source "$t/fs.squashfs" --no-bootloader >/dev/null 2>&1 || rc=$?
check "never reimages the running system" '[ "$rc" = 7 ]'

# ---- part 1: /home inside the root file system ----
r="$t/root1"; old_system "$r" 'UUID=1111 / ext4 defaults 0 1'
mkdir -p "$r/home/ann/Documents"; printf 'thesis\n' > "$r/home/ann/Documents/t.txt"
before=$(cd "$r/home" && find . -type f -exec sha256sum {} + | sort)
"$re" --mode keep --disk vda --target-dir "$r" --source "$t/fs.squashfs" --no-bootloader >/dev/null
check "system files replaced" 'grep -qx new "$r/usr/bin/tool"'
check "files not in the image removed" '[ ! -e "$r/var/junk" ]'
check "os-release is the new version" 'grep -q 1.1 "$r/etc/os-release"'
check "home contents unchanged" '[ "$(cd "$r/home" && find . -type f -exec sha256sum {} + | sort)" = "$before" ]'
check "image /home not unpacked" '[ ! -e "$r/home/live" ]'
check "accounts kept" 'grep -q "^ann:" "$r/etc/passwd"'
check "fstab kept" 'grep -q "UUID=1111" "$r/etc/fstab"'
check "host name kept" 'grep -qx ann-laptop "$r/etc/hostname"'
check "reinstall marker written" '[ -s "$r/etc/worksuite/reinstalled" ]'

# ---- part 2: real disk, /home in LUKS on its own partition ----
if [ "$(id -u)" != 0 ] || ! command -v cryptsetup >/dev/null || ! command -v sfdisk >/dev/null || ! losetup -f >/dev/null 2>&1; then
    echo "ok - # SKIP loop-device test (needs root, losetup, cryptsetup, sfdisk)"
    exit "$fail"
fi
truncate -s 160M "$t/disk.img"
printf 'size=60M\n,\n' | sfdisk -q "$t/disk.img" >/dev/null
loop=$(losetup -f --show -P "$t/disk.img")
for _ in 1 2 3 4 5; do [ -b "${loop}p2" ] && break; partx -u "$loop" 2>/dev/null || true; sleep 1; done
p1=${loop}p1 p2=${loop}p2
mkfs.ext4 -q "$p1"
mkdir -p "$t/m"
luks=0
printf 'pass' | cryptsetup luksFormat -q --type luks2 --pbkdf pbkdf2 --pbkdf-force-iterations 1000 "$p2" -
if printf 'pass' | cryptsetup open "$p2" "wsre-home-$$" - 2>/dev/null; then
    luks=1 mapper=wsre-home-$$ hdev=/dev/mapper/wsre-home-$$
else
    echo "ok - # SKIP LUKS layer (no device-mapper here); /home is a plain partition"
    wipefs -qa "$p2"; hdev=$p2
fi
mkfs.ext4 -q "$hdev"
huuid=$(blkid -s UUID -o value "$hdev")
mount "$hdev" "$t/m"; mkdir -p "$t/m/ann"; printf 'secret\n' > "$t/m/ann/notes"; umount "$t/m"
luuid=none
if [ "$luks" = 1 ]; then cryptsetup close "$mapper"; mapper=; luuid=$(cryptsetup luksUUID "$p2"); fi
hdr=$(dd if="$p2" bs=1M count=16 2>/dev/null | sha256sum)
data=$(dd if="$p2" bs=1M 2>/dev/null | sha256sum)
mount "$p1" "$t/m"; old_system "$t/m" "UUID=$(blkid -s UUID -o value "$p1") / ext4 defaults 0 1
UUID=$huuid /home ext4 defaults 0 2"; printf 'home UUID=%s none luks\n' "$luuid" > "$t/m/etc/crypttab"; umount "$t/m"

out=$("$re" --mode keep --disk "${loop#/dev/}" --source "$t/fs.squashfs" --no-bootloader 2>&1) || true
echo "$out" | sed 's/^/# /'
check "loop: home partition reported kept" 'echo "$out" | grep -q "home: UUID=$huuid (kept)"'
check "loop: home partition header (LUKS when present) unchanged" '[ "$(dd if="$p2" bs=1M count=16 2>/dev/null | sha256sum)" = "$hdr" ]'
check "loop: whole home partition unchanged, byte for byte" '[ "$(dd if="$p2" bs=1M 2>/dev/null | sha256sum)" = "$data" ]'
mount -o ro "$p1" "$t/m"
check "loop: root reimaged" 'grep -qx new "$t/m/usr/bin/tool" && [ ! -e "$t/m/var/junk" ]'
check "loop: crypttab and fstab kept" 'grep -q "$luuid" "$t/m/etc/crypttab" && grep -q "$huuid" "$t/m/etc/fstab"'
umount "$t/m"
if [ "$luks" = 1 ]; then printf 'pass' | cryptsetup open "$p2" "wsre-chk-$$" -; mapper=wsre-chk-$$; hdev=/dev/mapper/$mapper; fi
mount -o ro "$hdev" "$t/m"
check "loop: home still mounts (unlocks) and holds the user's files" 'grep -qx secret "$t/m/ann/notes"'
umount "$t/m"
exit "$fail"

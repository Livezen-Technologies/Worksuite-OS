#!/bin/sh
# worksuite-offline-update (boot menu › Update WorkSuite OS) against a fake installed system: the real bundle tool
# (tools/release/make-wsupdate.mjs) and verifier (package-service/src/bundle-cli.ts), a stub chroot for apt and dpkg.
# No root needed.  tests/boot/offline-update.test.sh
set -eu
here=$(cd "$(dirname "$0")/../.." && pwd)
up="$here/services/recovery-boot/bin/worksuite-offline-update"
t=$(mktemp -d); trap 'rm -rf "$t"' EXIT
fail=0
check() { if eval "$2"; then echo "ok - $1"; else echo "not ok - $1"; fail=1; fi; }
node=$(command -v "${NODE:-node}")

# The installed system: WorkSuite 1.0.0~rc1, trusting one release key.
root="$t/root"
mkdir -p "$root/etc" "$root/var/lib/dpkg" "$root/usr/share/worksuite/keys/release" "$root/var/log"
echo 'ID=worksuite' > "$root/etc/os-release"
printf 'Package: worksuite-desktop\nStatus: install ok installed\nVersion: 1.0.0~rc1\nArchitecture: all\n\n' > "$root/var/lib/dpkg/status"
"$node" -e '
const { generateKeyPairSync } = require("node:crypto"); const fs = require("node:fs");
const k = generateKeyPairSync("ed25519");
fs.writeFileSync(process.argv[1], k.privateKey.export({ type: "pkcs8", format: "pem" }));
fs.writeFileSync(process.argv[2], k.publicKey.export({ type: "spki", format: "pem" }));
const o = generateKeyPairSync("ed25519"); fs.writeFileSync(process.argv[3], o.privateKey.export({ type: "pkcs8", format: "pem" }));
' "$t/release.pem" "$root/usr/share/worksuite/keys/release/ws-release-1.pem" "$t/other.pem"
mkdir -p "$t/debs"; echo one > "$t/debs/worksuite-desktop_1.0.0~rc2_all.deb"; echo two > "$t/debs/worksuite-shell_1.0.0~rc2_amd64.deb"
mk() { "$node" "$here/tools/release/make-wsupdate.mjs" --key "$1" --key-id ws-release-1 --version "$2" --min-version 1.0.0~rc1 --out "$3" "$t"/debs/*.deb >/dev/null; }
mk "$t/release.pem" 1.0.0~rc2 "$t/media/update.wsupdate" 2>/dev/null || { mkdir -p "$t/media"; mk "$t/release.pem" 1.0.0~rc2 "$t/media/update.wsupdate"; }

# Stub chroot: records apt/dpkg calls; apt prints Status-Fd lines; STUB_APT_FAIL makes the install fail.
cat > "$t/chroot" <<'STUB'
#!/bin/sh
root=$1; shift
echo "$*" >> "$STUB_LOG"
case "$1 $2" in
  "apt-get -s") [ -n "${STUB_SIM_FAIL:-}" ] && { echo "E: worksuite-shell : Depends: libfoo but it is not installable"; exit 100; }; exit 0 ;;
  "apt-get -y") for a in "$@"; do case "$a" in /*.deb) [ -f "$root$a" ] || { echo "missing $root$a" >&2; exit 100; } ;; esac; done
                [ -n "${STUB_APT_FAIL:-}" ] && { echo "E: dpkg was interrupted" >&2; exit 100; }
                echo "pmstatus:worksuite-desktop:50:Unpacking"; echo "pmstatus:worksuite-shell:100:Installed"; exit 0 ;;
  "dpkg --audit") exit 0 ;;
  "sh -c") exit 1 ;;   # no update-grub in the fake system
esac
exit 0
STUB
chmod +x "$t/chroot"
export STUB_LOG="$t/calls" WS_UPD_TARGET_DIR="$root" WS_UPD_CHROOT="$t/chroot" WS_UPD_ARCH=amd64 WS_UPD_MNT="$t/mnt" \
  WS_UPD_CLI="$node --no-warnings $here/services/package-service/src/bundle-cli.ts"

out=$(sh "$up" inspect --target /dev/fake --bundle "$t/media/update.wsupdate")
check "inspect: the installed system's key accepts the bundle" 'echo "$out" | grep -q "\"version\":\"1.0.0~rc2\"" && echo "$out" | grep -q "\"packages\":2"'

: > "$t/calls"
out=$(sh "$up" apply --target /dev/fake --bundle "$t/media/update.wsupdate")
check "apply: ends with done" '[ "$(echo "$out" | tail -1)" = done ]'
check "apply: progress rises through installing to 100" 'echo "$out" | grep -q "^progress 60 installing" && echo "$out" | grep -q "^progress 100 done"'
check "apply: simulated first, then installed offline from the copied packages" \
  'head -1 "$t/calls" | grep -q "^apt-get -s -q --no-download install -- /var/cache/worksuite-offline-update/worksuite-desktop_1.0.0~rc2_all.deb /var/cache/worksuite-offline-update/worksuite-shell_1.0.0~rc2_amd64.deb" && grep -q "^apt-get -y -q --no-download .*--force-confold install -- /var/cache/worksuite-offline-update/" "$t/calls"'
check "apply: copied packages removed afterwards" '[ ! -e "$root/var/cache/worksuite-offline-update" ]'
check "apply: logged on the installed system" 'grep -q "update 1.0.0~rc1 -> 1.0.0~rc2 from update.wsupdate" "$root/var/log/worksuite-offline-update.log" && grep -q "updated to 1.0.0~rc2" "$root/var/log/worksuite-offline-update.log"'

: > "$t/calls"
mk "$t/other.pem" 1.0.0~rc2 "$t/media/foreign.wsupdate"
out=$(sh "$up" apply --target /dev/fake --bundle "$t/media/foreign.wsupdate" || true)
check "a bundle signed with a key the installed system does not trust is refused, nothing runs" \
  'echo "$out" | grep -q "^error bundle is not signed with the WorkSuite release key" && [ ! -s "$t/calls" ]'

cp "$t/media/update.wsupdate" "$t/media/tampered.wsupdate"
printf 'X' | dd of="$t/media/tampered.wsupdate" bs=1 seek=1600 conv=notrunc 2>/dev/null
out=$(sh "$up" apply --target /dev/fake --bundle "$t/media/tampered.wsupdate" || true)
check "an altered package is refused before apt" 'echo "$out" | grep -q "^error " && [ ! -s "$t/calls" ]'

mk "$t/release.pem" 0.9.0 "$t/media/old.wsupdate"
out=$(sh "$up" apply --target /dev/fake --bundle "$t/media/old.wsupdate" || true)
check "an older release is refused (no downgrade without a signed rollback directive)" 'echo "$out" | grep -q "^error refused a downgrade"'

: > "$t/calls"
out=$(STUB_SIM_FAIL=1 sh "$up" apply --target /dev/fake --bundle "$t/media/update.wsupdate" || true)
check "dependency problems stop it at the simulation, before anything is installed" \
  'echo "$out" | grep -q "^error E: worksuite-shell : Depends: libfoo" && ! grep -q "^apt-get -y" "$t/calls"'

out=$(STUB_APT_FAIL=1 sh "$up" apply --target /dev/fake --bundle "$t/media/update.wsupdate" || true)
check "a failing install is reported as failed, never as done" 'echo "$out" | grep -q "^error installing the packages failed" && ! echo "$out" | grep -qx done'

echo 'ID=debian' > "$t/os-release.debian"; cp "$root/etc/os-release" "$t/keep"; cp "$t/os-release.debian" "$root/etc/os-release"
out=$(sh "$up" inspect --target /dev/fake --bundle "$t/media/update.wsupdate" || true)
check "a system that is not WorkSuite OS is refused" 'echo "$out" | grep -q "^error no WorkSuite OS on this partition"'
cp "$t/keep" "$root/etc/os-release"

out=$(WS_UPD_MEDIA="$t/media" sh "$up" scan 2>/dev/null | grep '^bundle' || true)
check "scan lists the bundles on the drives" 'echo "$out" | grep -qx "bundle $t/media/update.wsupdate" && echo "$out" | grep -qx "bundle $t/media/old.wsupdate"'

out=$(sh "$up" frobnicate || true)
check "unknown command: usage" 'echo "$out" | grep -q "^error usage"'

exit $fail

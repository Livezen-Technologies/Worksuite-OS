#!/bin/sh
# No Debian logo where a person looks: WorkSuite takes over desktop-base's alternatives (vendor logo on the sign-in
# screen, backgrounds), the console banner and GRUB's entries name WorkSuite, and removal gives Debian's back.
set -u
ROOT=$(cd "$(dirname "$0")/../.." && pwd)
n=0; fail=0
ok() { n=$((n + 1)); echo "ok $n - $1"; }
bad() { n=$((n + 1)); fail=1; echo "not ok $n - $1"; }
D=$ROOT/packaging/debian
for f in logo logo-text logo-text-version; do
  [ -f "$ROOT/branding/vendor-logos/$f.svg" ] && ok "vendor logo $f.svg" || bad "vendor logo $f.svg"
done
grep -q 'for h in 64 128 256' "$ROOT/branding/render.sh" && ok "PNG sizes Debian ships (GDM uses logo-text-version-64.png)" || bad "vendor logo PNG sizes"
grep -q 'usr/share/worksuite/vendor-logos build-branding/vendor-logos' "$D/rules" && ok "logos installed" || bad "logos installed"
for a in vendor-logos desktop-background desktop-login-background desktop-grub; do
  grep -q "update-alternatives --install [^ ]* $a [^ ]* 100$" "$D/worksuite-branding.postinst" && grep -q "update-alternatives --remove $a " "$D/worksuite-branding.prerm" \
    && ok "$a: WorkSuite at priority 100, removed again on uninstall" || bad "$a alternative"
done
grep -q "WorkSuite OS %s" "$ROOT/live-build/config/hooks/normal/0100-worksuite-defaults.hook.chroot" && ok "console banner names WorkSuite" || bad "console banner"
grep -qx 'GRUB_DISTRIBUTOR="WorkSuite OS"' "$ROOT/branding/grub/worksuite.cfg" && ok "GRUB entries name WorkSuite" || bad "GRUB entries"
grep -q '^NAME="WorkSuite OS"' "$ROOT/branding/os-release" && grep -q '^LOGO=worksuite-os' "$ROOT/branding/os-release" && ok "os-release: name and logo (GNOME Settings › About)" || bad "os-release"
echo "1..$n"; exit $fail

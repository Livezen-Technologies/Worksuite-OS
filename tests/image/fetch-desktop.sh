#!/bin/sh
# tools/fetch-desktop.sh picks WorkSuite Desktop's .deb by its control fields: tiny fake debs built with dpkg-deb.
# Package worksuite wins; the old name worksuite-desktop (0.x, arch-specific, e.g. WorkSuite-0.2.74-amd64.deb) is
# renamed to worksuite with its data untouched; the OS metapackage worksuite-desktop (all, 1.0.0~dev1) never matches.
set -eu
root=$(cd "$(dirname "$0")/../.." && pwd)
t=$(mktemp -d); trap 'rm -rf "$t"' EXIT
ok() { echo "ok - $1"; }
fail() { echo "FAIL - $1"; cat "$t/log" 2>/dev/null; exit 1; }

fake() {   # fake DIR FILE PACKAGE VERSION ARCH [COMPRESSION]
  d="$t/src/$2"; mkdir -p "$d/DEBIAN" "$d/opt/WorkSuite" "$1"
  printf 'Package: %s\nVersion: %s\nArchitecture: %s\nMaintainer: Test <t@example.com>\nDescription: fake\n' "$3" "$4" "$5" > "$d/DEBIAN/control"
  echo "$3 $4 $5" > "$d/opt/WorkSuite/worksuite"
  dpkg-deb -Z"${6:-xz}" --root-owner-group -b "$d" "$1/$2" >/dev/null
}
fetch() {  # fetch DIR [ARCH] → status; output deb in $t/out
  rm -rf "$t/out"; ARCH=${2:-amd64} WORKSUITE_DESKTOP_DIR=$1 WORKSUITE_DESKTOP_DEST=$t/out "$root/tools/fetch-desktop.sh" > "$t/log" 2>&1
}
field() { dpkg-deb -f "$(ls "$t"/out/worksuite-app_*.deb)" "$1"; }

# Current builds: package worksuite, both arches, plus the OS metapackage alongside.
fake "$t/new" WorkSuite-0.2.300-amd64.deb worksuite 0.2.300 amd64
fake "$t/new" WorkSuite-0.2.300-arm64.deb worksuite 0.2.300 arm64
fake "$t/new" worksuite-desktop_1.0.0~dev1_all.deb worksuite-desktop 1.0.0~dev1 all
fetch "$t/new" || fail "new: fetch failed"
[ "$(field Package) $(field Architecture)" = "worksuite amd64" ] || fail "new: picked $(field Package) $(field Architecture)"
[ -f "$t/out/worksuite-app_0.2.300_amd64.deb" ] || fail "new: output name"
ok "package worksuite, amd64"
fetch "$t/new" arm64 || fail "new: arm64 fetch failed"
[ "$(field Architecture)" = arm64 ] || fail "new: arm64"
ok "package worksuite, arm64"

# Old builds: package worksuite-desktop 0.2.74 (the file names say nothing; dpkg-deb decides).
for z in xz gzip zstd; do
  rm -rf "$t/old" "$t/src"
  fake "$t/old" WorkSuite-0.2.74-amd64.deb worksuite-desktop 0.2.74 amd64 "$z"
  fake "$t/old" WorkSuite-0.2.74-arm64.deb worksuite-desktop 0.2.74 arm64 "$z"
  fetch "$t/old" || fail "old ($z): fetch failed"
  out=$(ls "$t"/out/worksuite-app_*.deb)
  [ "$(field Package) $(field Architecture) $(field Version)" = "worksuite amd64 0.2.74" ] || fail "old ($z): $(field Package)"
  field Replaces | grep -q 'worksuite-desktop (<< 1.0~)' || fail "old ($z): Replaces"
  dpkg-deb --info "$out" >/dev/null || fail "old ($z): invalid deb"
  [ "$(dpkg-deb --fsys-tarfile "$out" | tar -xOf - ./opt/WorkSuite/worksuite)" = "worksuite-desktop 0.2.74 amd64" ] || fail "old ($z): data"
  ok "old package name worksuite-desktop renamed to worksuite ($z)"
done

# Only the OS metapackage, or the wrong arch: nothing to pick.
rm -rf "$t/meta"; fake "$t/meta" worksuite-desktop_1.0.0~dev1_all.deb worksuite-desktop 1.0.0~dev1 all
fake "$t/meta" WorkSuite-0.2.300-arm64.deb worksuite 0.2.300 arm64
if fetch "$t/meta"; then fail "meta: picked $(field Package)"; fi
grep -q "no amd64 worksuite .deb" "$t/log" || fail "meta: message"
ok "OS metapackage and other arch never picked"

#!/bin/sh
# tools/fetch-pos.sh picks the worksuite-pos .deb by its control fields (tiny fake debs built with dpkg-deb), never by
# file name: the wanted arch wins, other packages (WorkSuite Desktop's worksuite, the OS metapackage worksuite-desktop) and
# other arches never match.
set -eu
root=$(cd "$(dirname "$0")/../.." && pwd)
t=$(mktemp -d); trap 'rm -rf "$t"' EXIT
ok() { echo "ok - $1"; }
fail() { echo "FAIL - $1"; cat "$t/log" 2>/dev/null; exit 1; }

fake() {   # fake DIR FILE PACKAGE VERSION ARCH
  d="$t/src/$2"; mkdir -p "$d/DEBIAN" "$d/opt/app" "$1"
  printf 'Package: %s\nVersion: %s\nArchitecture: %s\nMaintainer: Test <t@example.com>\nDescription: fake\n' "$3" "$4" "$5" > "$d/DEBIAN/control"
  echo "$3 $4 $5" > "$d/opt/app/bin"
  dpkg-deb -Zxz --root-owner-group -b "$d" "$1/$2" >/dev/null
}
fetch() {  # fetch DIR [ARCH] -> status; output deb in $t/out
  rm -rf "$t/out"; ARCH=${2:-amd64} WORKSUITE_POS_DIR=$1 WORKSUITE_POS_DEST=$t/out "$root/tools/fetch-pos.sh" > "$t/log" 2>&1
}
field() { dpkg-deb -f "$(ls "$t"/out/worksuite-pos_*.deb)" "$1"; }

fake "$t/a" Release-1.2.3-arm64.deb worksuite-pos 1.2.3 arm64
fake "$t/a" Release-1.2.3-amd64.deb worksuite-pos 1.2.3 amd64
fake "$t/a" zz-other_1.0_amd64.deb worksuite 0.2.300 amd64
fake "$t/a" worksuite-desktop_1.0.0~dev1_all.deb worksuite-desktop 1.0.0~dev1 all
fetch "$t/a" || fail "fetch failed"
[ "$(field Package) $(field Architecture)" = "worksuite-pos amd64" ] || fail "picked $(field Package) $(field Architecture)"
[ -f "$t/out/worksuite-pos_1.2.3_amd64.deb" ] || fail "output name"
ok "worksuite-pos, amd64"
fetch "$t/a" arm64 || fail "arm64 fetch failed"
[ "$(field Architecture)" = arm64 ] || fail "arm64"
ok "worksuite-pos, arm64"

# Misleading file names: the control fields decide.
fake "$t/b" worksuite-pos-9.9.9-amd64.deb worksuite 0.2.300 amd64
fake "$t/b" worksuite-pos-1.0.0-arm64.deb worksuite-pos 1.0.0 arm64
if fetch "$t/b"; then fail "picked $(field Package) $(field Architecture)"; fi
grep -q "no amd64 worksuite-pos .deb" "$t/log" || fail "message"
ok "other packages and other arch never picked"

# URL mode refuses a download without a checksum source.
if WORKSUITE_POS_URL=file:///nonexistent.deb WORKSUITE_POS_DEST=$t/out "$root/tools/fetch-pos.sh" > "$t/log" 2>&1; then fail "URL without deb"; fi
ok "URL mode fails without a deb"

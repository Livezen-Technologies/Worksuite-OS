#!/bin/sh
# Build the WorkSuite OS ISO inside Debian trixie (live-build >= 1:20230502; Ubuntu's older live-build lacks
# options used here). Needs root, network access to snapshot.debian.org, and the .debs from packaging/build-debs.sh.
#   sudo ARCH=amd64 SNAPSHOT=20261001T000000Z live-build/build.sh
# WORKSUITE_REPO=1 also adds download.worksuitecloud.com/os/apt (once it exists and its keyring is packaged).
set -eu
here=$(cd "$(dirname "$0")" && pwd)
: "${ARCH:=amd64}" "${SNAPSHOT:?pin a snapshot.debian.org timestamp}" "${WORKSUITE_REPO:=0}"
debs="$here/../packaging/out"
ls "$debs"/*.deb >/dev/null 2>&1 || { echo "build the packages first: packaging/build-debs.sh" >&2; exit 1; }
v=$(dpkg-query -W -f='${Version}' live-build 2>/dev/null | sed 's/^1://')
case "$v" in 2023*|2024*|2025*|2026*|2027*) ;; *) echo "live-build $v is too old; build inside Debian trixie" >&2; exit 1 ;; esac

work=$(mktemp -d)
cp -a "$here/." "$work/"
cd "$work"
mkdir -p config/packages.chroot
cp "$debs"/*_all.deb "$debs"/*_"$ARCH".deb config/packages.chroot/
[ "$WORKSUITE_REPO" = 1 ] || rm -f config/archives/worksuite.list.*
ARCH="$ARCH" SNAPSHOT="$SNAPSHOT" lb config
lb build 2>&1 | tee build.log
iso=$(ls ./*.iso | head -n1)
out="$here/out"; mkdir -p "$out"
name="worksuite-os-1.0.0-dev-$ARCH.iso"
mv "$iso" "$out/$name"
(cd "$out" && sha256sum "$name" > "$name.sha256")
echo "built $out/$name"

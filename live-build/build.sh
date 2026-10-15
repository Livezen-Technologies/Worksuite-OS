#!/bin/sh
# Build the WorkSuite OS ISO inside Debian trixie (live-build >= 1:20230502; Ubuntu's older live-build lacks
# options used here). Needs root, network access to snapshot.debian.org, and the .debs from packaging/build-debs.sh.
#   sudo ARCH=amd64 SNAPSHOT=20261001T000000Z live-build/build.sh
# Behind a TLS-intercepting proxy: BUILD_HTTPS_PROXY=http://host:port BUILD_CA_CERT=/path/ca.crt (build time only;
# a last hook removes both from the image).
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
find config/packages.chroot -name '*-dbgsym_*' -delete
if [ -n "${BUILD_HTTPS_PROXY:-}" ]; then
  export https_proxy="$BUILD_HTTPS_PROXY" HTTPS_PROXY="$BUILD_HTTPS_PROXY"
  mkdir -p config/includes.chroot_before_packages/etc/apt/apt.conf.d
  printf 'Acquire::https::Proxy "%s";\n' "$BUILD_HTTPS_PROXY" > config/includes.chroot_before_packages/etc/apt/apt.conf.d/00build-proxy
  if [ -n "${BUILD_CA_CERT:-}" ]; then
    cp "$BUILD_CA_CERT" config/includes.chroot_before_packages/etc/apt/build-proxy-ca.crt
    echo 'Acquire::https::CaInfo "/etc/apt/build-proxy-ca.crt";' >> config/includes.chroot_before_packages/etc/apt/apt.conf.d/00build-proxy
  fi
  cat > config/hooks/normal/9999-build-proxy-cleanup.hook.chroot <<'HOOK'
#!/bin/sh
set -e
rm -f /etc/apt/apt.conf.d/00build-proxy /etc/apt/build-proxy-ca.crt
HOOK
  chmod +x config/hooks/normal/9999-build-proxy-cleanup.hook.chroot
fi
[ "$WORKSUITE_REPO" = 1 ] || rm -f config/archives/worksuite.list.*
ARCH="$ARCH" SNAPSHOT="$SNAPSHOT" lb config
# Snapshot Release files are past Valid-Until by design; auto/config disables that check for apt.
lb build > build.log 2>&1 || { tail -40 build.log >&2; exit 1; }
iso=$(ls ./*.iso 2>/dev/null | head -n1)
[ -n "$iso" ] || { tail -40 build.log >&2; echo "lb build produced no ISO" >&2; exit 1; }
out="$here/out"; mkdir -p "$out"
name="worksuite-os-1.0.0-dev-$ARCH.iso"
mv "$iso" "$out/$name"
(cd "$out" && sha256sum "$name" > "$name.sha256")
echo "built $out/$name"

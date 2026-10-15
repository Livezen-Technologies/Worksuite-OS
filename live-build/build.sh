#!/bin/sh
# Build the WorkSuite OS ISO inside Debian trixie (live-build >= 1:20230502; Ubuntu's older live-build lacks
# options used here). Needs root, network access to snapshot.debian.org, and the .debs from packaging/build-debs.sh.
#   sudo ARCH=amd64 SNAPSHOT=20261001T000000Z live-build/build.sh
# Behind a TLS-intercepting proxy: BUILD_HTTPS_PROXY=http://host:port BUILD_CA_CERT=/path/ca.crt (build time only;
# a last hook removes both from the image).
# WORKSUITE_TEST_SERVER=DIR (from tests/vm/server-e2e.sh prepare) builds a separate *-test ISO that trusts that test
# CA, maps ws.test to the QEMU host, ships the test server's signing keys and runs the end-to-end client.
# WORKSUITE_REPO=1 also adds download.worksuitecloud.com/os/apt (once it exists and its keyring is packaged).
set -eu
here=$(cd "$(dirname "$0")" && pwd)
: "${ARCH:=amd64}" "${SNAPSHOT:?pin a snapshot.debian.org timestamp}" "${WORKSUITE_REPO:=0}"
debs="$here/../packaging/out"
ls "$debs"/*.deb >/dev/null 2>&1 || { echo "build the packages first: packaging/build-debs.sh" >&2; exit 1; }
v=$(dpkg-query -W -f='${Version}' live-build 2>/dev/null | sed 's/^1://')
case "$v" in 2023*|2024*|2025*|2026*|2027*) ;; *) echo "live-build $v is too old; build inside Debian trixie" >&2; exit 1 ;; esac

work=$(mktemp -d)
# A full lb build leaves several GB; --one-file-system never follows a leftover bind mount.
trap 'cd /; rm -rf --one-file-system "$work"' EXIT
cp -a "$here/." "$work/"
cd "$work"
mkdir -p config/packages.chroot
cp "$debs"/*_all.deb "$debs"/*_"$ARCH".deb config/packages.chroot/
find config/packages.chroot -name '*-dbgsym_*' -delete
# Boot menu artwork, row images, selection pill and fonts (IBM Plex, bundled) for the live GRUB theme.
"$here/../branding/grub/live/render.sh" config/bootloaders/grub-pc/live-theme
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
if [ -n "${WORKSUITE_TEST_SERVER:-}" ]; then
  t=$(cd "$WORKSUITE_TEST_SERVER" && pwd); inc=config/includes.chroot
  install -D -m 0644 "$t/ca.crt" $inc/usr/local/share/ca-certificates/worksuite-test-ca.crt
  for k in device-commands release; do mkdir -p $inc/usr/share/worksuite/keys/$k; cp "$t"/keys/*.pem $inc/usr/share/worksuite/keys/$k/; done
  install -D -m 0755 "$here/../tests/vm/server-e2e/e2e-client" $inc/usr/libexec/worksuite/e2e-client
  install -D -m 0644 "$here/../tests/vm/server-e2e/worksuite-e2e.service" $inc/etc/systemd/system/worksuite-e2e.service
  # Node keeps its own CA list; point the services at the system bundle, which now includes the test CA.
  for u in worksuite-device-agent worksuite-package-service; do
    mkdir -p $inc/etc/systemd/system/$u.service.d
    printf '[Service]\nEnvironment=NODE_EXTRA_CA_CERTS=/etc/ssl/certs/ca-certificates.crt\n' > $inc/etc/systemd/system/$u.service.d/test-ca.conf
  done
  cat > config/hooks/normal/9000-worksuite-test-server.hook.chroot <<'HOOK'
#!/bin/sh
set -e
update-ca-certificates >/dev/null
echo '10.0.2.2 ws.test' >> /etc/hosts
systemctl enable worksuite-e2e.service
HOOK
  chmod +x config/hooks/normal/9000-worksuite-test-server.hook.chroot
  suffix=-test
fi
[ "$WORKSUITE_REPO" = 1 ] || rm -f config/archives/worksuite.list.* config/includes.chroot/etc/apt/sources.list.d/worksuite.sources
ARCH="$ARCH" SNAPSHOT="$SNAPSHOT" lb config
# Snapshot Release files are past Valid-Until by design; auto/config disables that check for apt.
lb build > build.log 2>&1 || { tail -40 build.log >&2; exit 1; }
iso=$(ls ./*.iso 2>/dev/null | head -n1)
[ -n "$iso" ] || { tail -40 build.log >&2; echo "lb build produced no ISO" >&2; exit 1; }
out="$here/out"; mkdir -p "$out"
name="worksuite-os-1.0.0-dev-$ARCH${suffix:-}.iso"
mv "$iso" "$out/$name"
(cd "$out" && sha256sum "$name" > "$name.sha256")
echo "built $out/$name"

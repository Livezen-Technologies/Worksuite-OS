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
# WorkSuite Office (native editors, built by github.com/Livezen-Technologies/worksuite-office CI) ships in release
# images: tools/fetch-office.sh puts its .deb at live-build/config/packages.chroot/worksuite-office*.deb (or pass
# WORKSUITE_OFFICE_DEB=path). WORKSUITE_RELEASE=1 (set by CI) fails the build when it is missing; local dev builds
# without it leave Office out. Nothing is downloaded here. WORKSUITE_OFFICE_SHA256 (optional) pins the file; the
# package's architecture must match ARCH.
: "${WORKSUITE_RELEASE:=0}"
office_found=0
[ -z "${WORKSUITE_OFFICE_DEB:-}" ] || cp "$WORKSUITE_OFFICE_DEB" config/packages.chroot/worksuite-office_local.deb
for office in config/packages.chroot/worksuite-office*.deb; do
  [ -f "$office" ] || continue
  office_found=1
  if [ -n "${WORKSUITE_OFFICE_SHA256:-}" ]; then
    echo "$WORKSUITE_OFFICE_SHA256  $office" | sha256sum -c - >/dev/null || { echo "WorkSuite Office: checksum mismatch for $office" >&2; exit 1; }
  fi
  dpkg-deb --info "$office" >/dev/null || { echo "WorkSuite Office: $office is not a valid .deb" >&2; exit 1; }
  pkg=$(dpkg-deb -f "$office" Package); parch=$(dpkg-deb -f "$office" Architecture)
  case "$parch" in "$ARCH"|all) ;; *) echo "WorkSuite Office: $office is $parch, not $ARCH; skipping" >&2; rm -f "$office"; continue ;; esac
  echo "$pkg" >> config/package-lists/worksuite-office.list.chroot
  echo "WorkSuite Office: installing $pkg $(dpkg-deb -f "$office" Version)"
done
[ -s config/package-lists/worksuite-office.list.chroot ] || office_found=0
if [ "$office_found" = 0 ]; then
  if [ "$WORKSUITE_RELEASE" = 1 ]; then
    echo "WorkSuite Office: no $ARCH .deb, and release images must include it; run tools/fetch-office.sh first" >&2
    exit 1
  fi
  echo "WorkSuite Office: no .deb found; building without it (dev build)" >&2
fi
# WorkSuite Desktop (github.com/Livezen-Technologies/worksuite-desktop CI, package worksuite; the OS's own metapackage is worksuite-desktop) ships the same
# way: tools/fetch-desktop.sh puts its .deb at config/packages.chroot/worksuite-app_*.deb (or pass
# WORKSUITE_DESKTOP_DEB=path; WORKSUITE_DESKTOP_SHA256 pins it). Release images need it unless
# WORKSUITE_DESKTOP_OPTIONAL=1 (CI sets that when no desktop source is configured); without it the start menu's
# WorkSuite tiles open the worksuite-app web windows. On WorkSuite OS the app runs in its OS mode (the marker below).
desktop_found=0
[ -z "${WORKSUITE_DESKTOP_DEB:-}" ] || cp "$WORKSUITE_DESKTOP_DEB" config/packages.chroot/worksuite-app_local.deb
for desktop in config/packages.chroot/worksuite-app_*.deb; do
  [ -f "$desktop" ] || continue
  if [ -n "${WORKSUITE_DESKTOP_SHA256:-}" ]; then
    echo "$WORKSUITE_DESKTOP_SHA256  $desktop" | sha256sum -c - >/dev/null || { echo "WorkSuite Desktop: checksum mismatch for $desktop" >&2; exit 1; }
  fi
  dpkg-deb --info "$desktop" >/dev/null || { echo "WorkSuite Desktop: $desktop is not a valid .deb" >&2; exit 1; }
  pkg=$(dpkg-deb -f "$desktop" Package); parch=$(dpkg-deb -f "$desktop" Architecture)
  [ "$pkg" = worksuite ] || { echo "WorkSuite Desktop: $desktop is $pkg, not worksuite; skipping" >&2; rm -f "$desktop"; continue; }
  case "$parch" in "$ARCH"|all) ;; *) echo "WorkSuite Desktop: $desktop is $parch, not $ARCH; skipping" >&2; rm -f "$desktop"; continue ;; esac
  echo "$pkg" >> config/package-lists/worksuite-app.list.chroot
  desktop_found=1
  echo "WorkSuite Desktop: installing $pkg $(dpkg-deb -f "$desktop" Version)"
done
if [ "$desktop_found" = 0 ]; then
  if [ "$WORKSUITE_RELEASE" = 1 ] && [ "${WORKSUITE_DESKTOP_OPTIONAL:-0}" != 1 ]; then
    echo "WorkSuite Desktop: no $ARCH .deb, and release images must include it; run tools/fetch-desktop.sh first" >&2
    exit 1
  fi
  echo "WorkSuite Desktop: no .deb found; building without it (the start menu falls back to web app windows)" >&2
fi
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
if [ "${WORKSUITE_PERF:-0}" = 1 ]; then
  # Perf/reliability probes (tests/perf/guest) run once after boot and print WORKSUITE_PERF lines on the serial
  # console for tests/vm/boot-test.sh PERF_PROFILE=… (WSOS-PRF-*, REL-001/002, ARM-007). Test images only.
  inc=config/includes.chroot
  for f in measure-boot measure-shell login-cycles suspend-cycles electron-kill; do install -D -m 0755 "$here/../tests/perf/guest/$f" $inc/usr/libexec/worksuite/perf/$f; done
  install -D -m 0644 "$here/../tests/perf/guest/worksuite-perf.service" $inc/etc/systemd/system/worksuite-perf.service
  printf '#!/bin/sh\nset -e\nsystemctl enable worksuite-perf.service\n' > config/hooks/normal/9001-worksuite-perf.hook.chroot
  chmod +x config/hooks/normal/9001-worksuite-perf.hook.chroot
  suffix="${suffix:-}-perf"
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
# Image package list for the SBOM (tools/sbom/generate.sh, WSOS-SEC-011).
pk=$(ls ./*.packages 2>/dev/null | head -n1)
[ -n "$pk" ] && cp "$pk" "$out/${name%.iso}.packages"
echo "built $out/$name"

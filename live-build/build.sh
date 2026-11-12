#!/bin/sh
# Build the WorkSuite OS ISO inside Debian trixie (live-build >= 1:20230502; Ubuntu's older live-build lacks
# options used here). Needs root, network access to snapshot.debian.org, and the .debs from packaging/build-debs.sh.
#   sudo ARCH=amd64 SNAPSHOT=20261001T000000Z live-build/build.sh
# Behind a TLS-intercepting proxy: BUILD_HTTPS_PROXY=http://host:port BUILD_CA_CERT=/path/ca.crt (build time only;
# a last hook removes both from the image).
# WORKSUITE_TEST_SERVER=DIR (from tests/vm/server-e2e.sh prepare) builds a separate *-test ISO that trusts that test
# CA, maps ws.test to the QEMU host, ships the test server's signing keys and runs the end-to-end client.
# WORKSUITE_REPO=1 also adds the Update Center's APT repo, download.worksuitecloud.com/os/apt (needs the packaged
# archive keyring); WORKSUITE_UPDATE_HOST=https://… points the image at another Update Center.
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
# live-build indexes only packages.chroot files named *_<arch>.deb or *_all.deb, so local copies keep that suffix.
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
# The installer's Terms page (installer/branding/worksuite/terms/LICENSE-*.txt) ships as a marked draft until the
# approved legal text replaces it. A release image never shows a draft as the agreement people accept.
if [ "$WORKSUITE_RELEASE" = 1 ] && grep -ql 'DRAFT — REPLACE WITH THE FINAL LEGAL TEXT' "$here"/../installer/branding/worksuite/terms/LICENSE-*.txt; then
  echo "Installer terms are still the draft placeholder; add the approved legal text before a release build" >&2
  exit 1
fi
office_found=0
[ -z "${WORKSUITE_OFFICE_DEB:-}" ] || cp "$WORKSUITE_OFFICE_DEB" "config/packages.chroot/worksuite-office_local_$(dpkg-deb -f "$WORKSUITE_OFFICE_DEB" Architecture).deb"
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
[ -z "${WORKSUITE_DESKTOP_DEB:-}" ] || cp "$WORKSUITE_DESKTOP_DEB" "config/packages.chroot/worksuite-app_local_$(dpkg-deb -f "$WORKSUITE_DESKTOP_DEB" Architecture).deb"
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
# Worksuite FrameFlow (github.com/Livezen-Technologies/worksuite-frameflow, package worksuite-frameflow) and WorkSuite
# POS (github.com/Livezen-Technologies/worksuite-pos, package worksuite-pos) ship the same way as Desktop:
# tools/fetch-frameflow.sh / tools/fetch-pos.sh put them at config/packages.chroot/<package>_*.deb (or pass
# WORKSUITE_FRAMEFLOW_DEB / WORKSUITE_POS_DEB=path; *_SHA256 pins them). Release images need both unless
# WORKSUITE_FRAMEFLOW_OPTIONAL=1 / WORKSUITE_POS_OPTIONAL=1 (CI sets those when no source is configured). Their
# Depends resolve from the snapshot mirror at build time, so the installed system has them offline (unpackfs copies
# the image); hook 0200-worksuite-apps checks every bundled app's libraries in the chroot.
bundle_app() {  # bundle_app LABEL PACKAGE FETCH-SCRIPT LOCAL-DEB SHA256 OPTIONAL
  label=$1 want=$2 local_deb=$4 pin=$5 optional=$6 found=0
  [ -z "$local_deb" ] || cp "$local_deb" "config/packages.chroot/${want}_local_$(dpkg-deb -f "$local_deb" Architecture).deb"
  for deb in config/packages.chroot/"$want"_*.deb; do
    [ -f "$deb" ] || continue
    if [ -n "$pin" ]; then
      echo "$pin  $deb" | sha256sum -c - >/dev/null || { echo "$label: checksum mismatch for $deb" >&2; exit 1; }
    fi
    dpkg-deb --info "$deb" >/dev/null || { echo "$label: $deb is not a valid .deb" >&2; exit 1; }
    pkg=$(dpkg-deb -f "$deb" Package); parch=$(dpkg-deb -f "$deb" Architecture)
    [ "$pkg" = "$want" ] || { echo "$label: $deb is $pkg, not $want; skipping" >&2; rm -f "$deb"; continue; }
    case "$parch" in "$ARCH"|all) ;; *) echo "$label: $deb is $parch, not $ARCH; skipping" >&2; rm -f "$deb"; continue ;; esac
    echo "$pkg" >> "config/package-lists/$want.list.chroot"
    found=1
    echo "$label: installing $pkg $(dpkg-deb -f "$deb" Version)"
  done
  if [ "$found" = 0 ]; then
    if [ "$WORKSUITE_RELEASE" = 1 ] && [ "$optional" != 1 ]; then
      echo "$label: no $ARCH .deb, and release images must include it; run $3 first" >&2
      exit 1
    fi
    echo "$label: no .deb found; building without it" >&2
  fi
}
bundle_app "Worksuite FrameFlow" worksuite-frameflow tools/fetch-frameflow.sh "${WORKSUITE_FRAMEFLOW_DEB:-}" \
  "${WORKSUITE_FRAMEFLOW_SHA256:-}" "${WORKSUITE_FRAMEFLOW_OPTIONAL:-0}"
bundle_app "WorkSuite POS" worksuite-pos tools/fetch-pos.sh "${WORKSUITE_POS_DEB:-}" "${WORKSUITE_POS_SHA256:-}" \
  "${WORKSUITE_POS_OPTIONAL:-0}"
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
if [ "$WORKSUITE_REPO" = 1 ]; then
  # The Update Center's OS repository (https://download.worksuitecloud.com/os/apt), verified with the archive keyring
  # for the image build too. WORKSUITE_UPDATE_HOST points the image (APT source + coordinator) at another Update Center.
  key="$here/../packaging/keyring/worksuite-archive-keyring.gpg"
  [ -f "$key" ] || { echo "WORKSUITE_REPO=1 needs packaging/keyring/worksuite-archive-keyring.gpg" >&2; exit 1; }
  cp "$key" config/archives/worksuite.key.chroot; cp "$key" config/archives/worksuite.key.binary
  if [ -n "${WORKSUITE_UPDATE_HOST:-}" ]; then
    case "$WORKSUITE_UPDATE_HOST" in https://*) ;; *) echo "WORKSUITE_UPDATE_HOST must be https://" >&2; exit 1 ;; esac
    h=${WORKSUITE_UPDATE_HOST%/}
    sed -i "s#https://download.worksuitecloud.com#$h#g" config/archives/worksuite.list.* config/includes.chroot/etc/apt/sources.list.d/worksuite.sources config/includes.chroot/etc/worksuite/updates.json
  fi
else
  rm -f config/archives/worksuite.list.* config/includes.chroot/etc/apt/sources.list.d/worksuite.sources
fi
# Boot menu › Update WorkSuite OS: with WORKSUITE_RELEASE_KEY=release.key.pem and WORKSUITE_RELEASE_KEY_ID (the id of
# the public key devices ship in /usr/share/worksuite/keys/release/), the drive also carries a signed .wsupdate of this
# image's WorkSuite packages at /worksuite/, so booting it can update an installed system with no other drive.
# Without a key the updater still finds .wsupdate files on other drives.
if [ -n "${WORKSUITE_RELEASE_KEY:-}" ]; then
  : "${WORKSUITE_RELEASE_KEY_ID:?WORKSUITE_RELEASE_KEY needs WORKSUITE_RELEASE_KEY_ID}"
  osv=$(dpkg-deb -f config/packages.chroot/worksuite-desktop_*.deb Version)
  mkdir -p config/includes.binary/worksuite
  # shellcheck disable=SC2046 # one argument per package
  node "$here/../tools/release/make-wsupdate.mjs" --key "$WORKSUITE_RELEASE_KEY" --key-id "$WORKSUITE_RELEASE_KEY_ID" \
    --version "$osv" --min-version "${WORKSUITE_UPDATE_MIN_VERSION:-1.0.0~rc1}" --arch "$ARCH" \
    --out "config/includes.binary/worksuite/worksuite-os-$osv-$ARCH.wsupdate" \
    $(ls config/packages.chroot/worksuite-*_*.deb | grep -v -e '_local_' -e '/worksuite-app_' -e '/worksuite-office')
fi
ARCH="$ARCH" SNAPSHOT="$SNAPSHOT" lb config
# Snapshot Release files are past Valid-Until by design; auto/config disables that check for apt.
# snapshot.debian.org drops requests under load; debootstrap has no retry of its own. When the bootstrap stage
# fails only on downloads, clean the stages (keeping cache/, so fetched packages are reused) and try again.
attempt=1
while :; do
  rc=0; lb build > build.log 2>&1 || rc=$?
  iso=$(ls ./*.iso 2>/dev/null | head -n1)
  [ "$rc" = 0 ] && [ -n "$iso" ] && break
  if [ "$attempt" -ge 3 ] || ! grep -qE "Couldn't download packages|Failed to fetch|Unable to fetch|apt-get: terminated by signal" build.log; then
    tail -40 build.log >&2; echo "lb build produced no ISO" >&2; exit 1
  fi
  echo "lb build: package downloads failed (attempt $attempt of 3); retrying" >&2
  attempt=$((attempt + 1))
  lb clean > /dev/null 2>&1 || true
  sleep 30
done
[ -n "$iso" ] || { tail -40 build.log >&2; echo "lb build produced no ISO" >&2; exit 1; }
out="$here/out"; mkdir -p "$out"
name="worksuite-os-1.0.0-dev-$ARCH${suffix:-}.iso"
mv "$iso" "$out/$name"
(cd "$out" && sha256sum "$name" > "$name.sha256")
# Image package list for the SBOM (tools/sbom/generate.sh, WSOS-SEC-011).
pk=$(ls ./*.packages 2>/dev/null | head -n1)
[ -n "$pk" ] && cp "$pk" "$out/${name%.iso}.packages"
echo "built $out/$name"

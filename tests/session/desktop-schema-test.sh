#!/bin/sh
# Every WorkSuite GNOME override must name keys and values that exist in the schemas trixie ships: one wrong key makes
# glib-compile-schemas refuse ALL overrides on the image (no theme, no taskbar). Downloads the real packages, links
# the extension schemas the way worksuite-session does, and compiles strictly. Needs apt (run in a trixie container):
#   docker run --rm -v "$PWD:/src:ro" debian:trixie sh /src/tests/session/desktop-schema-test.sh
set -eu
SRC=${SRC:-/src}
W=$(mktemp -d); trap 'rm -rf "$W"' EXIT
apt-get update -qq >/dev/null
apt-get install -y -qq --no-install-recommends libglib2.0-bin >/dev/null
cd "$W"
apt-get download -qq gnome-shell-common gsettings-desktop-schemas mutter-common gnome-settings-daemon-common gnome-shell-extensions-common \
  gnome-shell-extension-user-theme gnome-shell-extension-dash-to-panel gnome-shell-extension-arc-menu gnome-shell-extension-blur-my-shell \
  gnome-shell-extension-appindicator gnome-shell-extension-tiling-assistant gdm3 >/dev/null
for d in *.deb; do dpkg-deb -x "$d" root; done
S=root/usr/share/glib-2.0/schemas
mkdir -p "$S"
# The same links worksuite-session ships (worksuite-session.links): schemas the packages leave outside the system dir.
for f in $(sed -n 's#^\(usr/share/[^ ]*\.gschema\.xml\) usr/share/glib-2.0/schemas/.*#\1#p' "$SRC/packaging/debian/worksuite-session.links"); do
  [ -f "root/$f" ] || { echo "not ok - linked schema missing in the package: $f"; exit 1; }
  cp "root/$f" "$S/"
done
cp "$SRC"/services/session/gnome/*.gschema.override "$S/"
if out=$(glib-compile-schemas --strict --targetdir="$W" "$S" 2>&1); then echo "ok 1 - WorkSuite GNOME overrides compile strictly against trixie's schemas"
else echo "$out"; echo "not ok 1 - WorkSuite GNOME overrides compile strictly against trixie's schemas"; exit 1; fi
echo 1..1

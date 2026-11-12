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
# The extensions' defaults live in a dconf keyfile (dconf/00-worksuite-desktop): same keys and GVariant values,
# so check them the same way, with each [org/gnome/...] path turned into its schema id.
sed '/^\[/ s#/#.#g' "$SRC/services/session/gnome/dconf/00-worksuite-desktop" > "$S/97_worksuite-dconf-check.gschema.override"
if out=$(glib-compile-schemas --strict --targetdir="$W" "$S" 2>&1); then echo "ok 1 - WorkSuite GNOME overrides compile strictly against trixie's schemas"
else echo "$out"; echo "not ok 1 - WorkSuite GNOME overrides compile strictly against trixie's schemas"; exit 1; fi
# Every .desktop id pinned or made a default must be a real app in trixie (a wrong id silently drops the pin).
apt-get download -qq nautilus gnome-control-center gnome-text-editor gnome-calculator loupe file-roller gnome-console gnome-system-monitor firefox-esr celluloid papers >/dev/null
for d in *.deb; do dpkg-deb -x "$d" root; done
ids=$( { grep -oh "'[A-Za-z0-9._-]*\.desktop'" "$SRC"/services/session/gnome/*.gschema.override "$SRC/services/session/gnome/dconf/00-worksuite-desktop" | tr -d "'"; sed -n 's/^[^#][^=]*=\([^;]*\.desktop\);.*$/\1/p' "$SRC/shell/apps/worksuite-mimeapps.list"; } | sort -u)
miss=""
for id in $ids; do
  case $id in worksuite.desktop) continue ;;   # WorkSuite Desktop (bundled app, its own package)
    worksuite-*|lk.worksuite.*) [ -f "$SRC/shell/apps/$id" ] || [ -f "$SRC/services/session/gnome/applications/$id" ] || [ "$id" = worksuite-app.desktop ] || [ "$id" = worksuite-office.desktop ] || miss="$miss $id"; continue ;; esac
  [ -f "root/usr/share/applications/$id" ] || miss="$miss $id"
done
if [ -z "$miss" ]; then echo "ok 2 - every pinned or default app exists"; else echo "not ok 2 - apps not found:$miss"; exit 1; fi
# dconf itself must compile the system database (a bad line would leave every default out).
apt-get install -y -qq --no-install-recommends dconf-cli >/dev/null
mkdir -p "$W/db.d"; cp "$SRC/services/session/gnome/dconf/00-worksuite-desktop" "$W/db.d/"
if dconf compile "$W/worksuite.db" "$W/db.d" 2>"$W/dconf.err" && [ -s "$W/worksuite.db" ]; then echo "ok 3 - dconf compiles the WorkSuite system database"
else cat "$W/dconf.err"; echo "not ok 3 - dconf compiles the WorkSuite system database"; exit 1; fi
grep -qx 'system-db:worksuite' "$SRC/services/session/gnome/dconf/profile-user" && grep -qx 'user-db:user' "$SRC/services/session/gnome/dconf/profile-user" \
  && echo "ok 4 - the user profile reads the person's settings, then the WorkSuite defaults" || { echo "not ok 4 - dconf user profile"; exit 1; }
echo 1..4

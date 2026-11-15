#!/bin/sh
# One Settings app under GNOME: GNOME Settings' launcher is diverted and replaced by a hidden entry that opens WorkSuite
# Settings; nothing pins GNOME Settings; gnome-control-center itself is not removed (WorkSuite Settings opens its panels).
set -u
ROOT=$(cd "$(dirname "$0")/../.." && pwd); n=0; fail=0
ok() { n=$((n + 1)); echo "ok $n - $1"; }
bad() { n=$((n + 1)); fail=1; echo "not ok $n - $1"; }
G=$ROOT/services/session/gnome; D=$ROOT/packaging/debian; F=$G/applications/org.gnome.Settings.desktop
d=/usr/share/applications/org.gnome.Settings.desktop
grep -q -- "--add --rename --divert $d.distrib $d" "$D/worksuite-session.preinst" && grep -q -- "--remove --rename --divert $d.distrib $d" "$D/worksuite-session.postrm" \
  && ok "GNOME Settings launcher diverted, restored on removal" || bad "GNOME Settings divert"
grep -q "applications/org.gnome.Settings.desktop usr/share/applications/" "$D/worksuite-session.install" && ok "replacement launcher installed" || bad "replacement installed"
grep -qx 'NoDisplay=true' "$F" && grep -qx 'Exec=/usr/lib/worksuite/shell/worksuite-shell --control-center' "$F" \
  && ok "replacement is hidden and opens WorkSuite Settings" || bad "replacement launcher contents"
grep -qx 'Name=Settings' "$G/applications/worksuite-settings.desktop" && ok "WorkSuite Settings is named Settings" || bad "WorkSuite Settings name"
if grep -q "org.gnome.Settings.desktop" "$G/95_worksuite-gnome.gschema.override" "$G/dconf/00-worksuite-desktop"; then bad "GNOME Settings still pinned"; else ok "nothing pins GNOME Settings"; fi
grep -q "worksuite-settings.desktop" "$G/95_worksuite-gnome.gschema.override" && ok "taskbar pins WorkSuite Settings" || bad "taskbar pin"
grep -q 'gnome-control-center' "$D/control" && ok "gnome-control-center stays a dependency (its panels are opened)" || bad "gnome-control-center dependency"
command -v desktop-file-validate >/dev/null && { desktop-file-validate "$F" && ok "replacement launcher validates" || bad "desktop-file-validate"; }
echo "1..$n"; exit $fail

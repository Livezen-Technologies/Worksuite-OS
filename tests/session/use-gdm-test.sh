#!/bin/sh
# worksuite-use-gdm (installer, installed systems): GDM must end up as display-manager.service. Debian's gdm.service is
# static, so `systemctl enable` does nothing for it; the first version disabled greetd, enabled nothing and left a VM
# with no sign-in screen at all. Fake root, stubbed systemctl and dconf.
set -u
ROOT=$(cd "$(dirname "$0")/../.." && pwd)
T=$(mktemp -d); trap 'rm -rf "$T"' EXIT
n=0; fail=0
ok() { n=$((n + 1)); echo "ok $n - $1"; }
bad() { n=$((n + 1)); fail=1; echo "not ok $n - $1"; }
mkdir -p "$T/stub" "$T/r/usr/sbin" "$T/r/usr/lib/systemd/system" "$T/r/etc/systemd/system" "$T/r/etc/X11" "$T/r/usr/share/worksuite/gdm/dconf" "$T/r/var/lib/AccountsService/users"
: > "$T/r/usr/sbin/gdm3"; chmod +x "$T/r/usr/sbin/gdm3"
printf '[Unit]\nDescription=GNOME Display Manager\n' > "$T/r/usr/lib/systemd/system/gdm.service"     # static: no [Install]
cp "$ROOT/services/session/gdm/90-worksuite" "$T/r/usr/share/worksuite/gdm/dconf/"
ln -s /etc/systemd/system/greetd.service "$T/r/etc/systemd/system/display-manager.service"           # the live image's
echo /usr/sbin/greetd > "$T/r/etc/X11/default-display-manager"
printf '[User]\nIcon=/x\n' > "$T/r/var/lib/AccountsService/users/qat"
cat > "$T/stub/systemctl" <<S
#!/bin/sh
echo "systemctl \$*" >> "$T/log"
case "\$1" in
  show) echo "$T/r/usr/lib/systemd/system/gdm.service" ;;
  disable) [ "\$2" = greetd.service ] && rm -f "$T/r/etc/systemd/system/display-manager.service" ;;
  enable) exit 0 ;;   # what real systemd does for a static unit: nothing
esac
S
printf '#!/bin/sh\necho "dconf $*" >> "%s/log"\n' "$T" > "$T/stub/dconf"; chmod +x "$T/stub/"*
PATH="$T/stub:$PATH" WORKSUITE_ROOT="$T/r" sh "$ROOT/services/session/gdm/worksuite-use-gdm" > "$T/out" 2>&1; rc=$?
[ $rc = 0 ] && ok "succeeds" || { bad "succeeds (rc $rc)"; sed 's/^/#   /' "$T/out"; }
[ "$(readlink -f "$T/r/etc/systemd/system/display-manager.service")" = "$T/r/usr/lib/systemd/system/gdm.service" ] \
  && ok "display-manager.service is GDM (static unit linked, not 'enabled')" || bad "display-manager.service is GDM"
[ "$(cat "$T/r/etc/X11/default-display-manager")" = /usr/sbin/gdm3 ] && ok "default-display-manager is gdm3" || bad "default-display-manager is gdm3"
grep -q '^systemctl disable greetd.service' "$T/log" && ok "greetd disabled" || bad "greetd disabled"
grep -q '^dconf update' "$T/log" && [ -f "$T/r/etc/dconf/db/gdm.d/90-worksuite" ] && ok "GDM dconf defaults installed and compiled (WorkSuite logo)" || bad "GDM dconf defaults installed and compiled"
grep -qx 'DefaultSession=worksuite-gnome.desktop' "$T/r/etc/gdm3/daemon.conf" && grep -qx 'AutomaticLoginEnable=false' "$T/r/etc/gdm3/daemon.conf" \
  && ok "daemon.conf: WorkSuite session, no automatic sign-in" || bad "daemon.conf"
grep -qx 'Session=worksuite-gnome' "$T/r/var/lib/AccountsService/users/qat" && ok "existing account signs in to the WorkSuite session" || bad "existing account session"
# No gdm.service: greetd stays, nothing is broken.
rm -f "$T/r/usr/lib/systemd/system/gdm.service"; ln -sfn /etc/systemd/system/greetd.service "$T/r/etc/systemd/system/display-manager.service"
cat > "$T/stub/systemctl" <<S
#!/bin/sh
echo "systemctl \$*" >> "$T/log"; [ "\$1" = show ] && echo ""; exit 0
S
chmod +x "$T/stub/systemctl"
PATH="$T/stub:$PATH" WORKSUITE_ROOT="$T/r" sh "$ROOT/services/session/gdm/worksuite-use-gdm" >/dev/null 2>&1
[ "$(readlink "$T/r/etc/systemd/system/display-manager.service")" = /etc/systemd/system/greetd.service ] && ok "without gdm.service greetd stays the display manager" || bad "without gdm.service greetd stays"
echo "1..$n"; exit $fail

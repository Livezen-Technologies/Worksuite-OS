#!/bin/sh
# Settings › Printers administration (issue #51): worksuite-printer-admin runs as root through pkexec, so it must
# pass only checked values to the CUPS tools; its polkit action and rule exist and are installed; the image ships the
# CUPS stack, Avahi discovery, ipp-usb and drivers (the build installs no recommends), and the live user is in lpadmin.
set -u
ROOT=$(cd "$(dirname "$0")/../.." && pwd)
H=$ROOT/services/session/bin/worksuite-printer-admin
TMP=$(mktemp -d); trap 'rm -rf "$TMP"' EXIT
LOG=$TMP/log
fail=0
ok() { echo "ok - $1"; }
bad() { echo "not ok - $1"; fail=1; }
check() { [ "$2" = "$3" ] && ok "$1" || { bad "$1"; echo "#   got:  $2"; echo "#   want: $3"; }; }

for t in lpinfo cupsenable cupsdisable cupsaccept; do
  printf '#!/bin/sh\necho "%s $*" >> "%s"\n' "$t" "$LOG" > "$TMP/$t"; chmod +x "$TMP/$t"
done
# lpstat answers "no such printer" unless LPSTAT_RCS lists exit codes for successive calls; lpadmin -p fails with ADD_RC.
printf '#!/bin/sh\necho "lpstat $*" >> "%s"\nset -- $(cat "%s/rcs" 2>/dev/null) 1\nrc=$1; shift; echo "$*" > "%s/rcs"\nexit $rc\n' "$LOG" "$TMP" "$TMP" > "$TMP/lpstat"; chmod +x "$TMP/lpstat"
printf '#!/bin/sh\necho "lpadmin $*" >> "%s"\n[ "$1" = -p ] && exit ${ADD_RC:-0}\nexit 0\n' "$LOG" > "$TMP/lpadmin"; chmod +x "$TMP/lpadmin"
export WORKSUITE_LPSTAT=$TMP/lpstat
export WORKSUITE_LPINFO=$TMP/lpinfo WORKSUITE_LPADMIN=$TMP/lpadmin WORKSUITE_CUPSENABLE=$TMP/cupsenable \
  WORKSUITE_CUPSDISABLE=$TMP/cupsdisable WORKSUITE_CUPSACCEPT=$TMP/cupsaccept
run() { : > "$LOG"; sh "$H" "$@" 2>/dev/null; echo "rc=$?" >> "$LOG"; tr '\n' ';' < "$LOG"; }

check "devices" "$(run devices)" "lpinfo --timeout 10 -l -v;rc=0;"
check "drivers by device id" "$(run drivers id 'MFG:HP;MDL:LaserJet M110w;')" "lpinfo --device-id MFG:HP;MDL:LaserJet M110w; -m;rc=0;"
check "add" "$(run add Office ipp://10.0.0.5/ipp/print everywhere 'Office printer')" "lpstat -p Office;lpadmin -p Office -E -v ipp://10.0.0.5/ipp/print -m everywhere -D Office printer;rc=0;"
check "add USB with a PPD" "$(run add Lab 'usb://Brother/HL?serial=1' drv:///brlaser.drv/br2350.ppd Lab)" "lpstat -p Lab;lpadmin -p Lab -E -v usb://Brother/HL?serial=1 -m drv:///brlaser.drv/br2350.ppd -D Lab;rc=0;"
echo "1 0" > "$TMP/rcs"
check "#51: a failed add removes the queue it left behind" "$(ADD_RC=1 run add H ipp://h/ipp/print everywhere H)" "lpstat -p H;lpadmin -p H -E -v ipp://h/ipp/print -m everywhere -D H;lpstat -p H;lpadmin -x H;rc=1;"
echo "0 0" > "$TMP/rcs"
check "#51: a failed add keeps a queue of that name that was already there" "$(ADD_RC=1 run add H ipp://h/ipp/print everywhere H)" "lpstat -p H;lpadmin -p H -E -v ipp://h/ipp/print -m everywhere -D H;rc=1;"
rm -f "$TMP/rcs"
check "remove" "$(run remove Office)" "lpadmin -x Office;rc=0;"
check "pause" "$(run pause Office)" "cupsdisable Office;rc=0;"
check "resume enables and accepts" "$(run resume Office)" "cupsenable Office;cupsaccept Office;rc=0;"
check "refuses an option as a name" "$(run remove -E)" "rc=2;"
check "refuses odd names" "$(run remove 'a/b')" "rc=2;"
check "refuses file: URIs" "$(run add X file:///etc/shadow everywhere X)" "rc=2;"
check "refuses credentials in URIs" "$(run add X ipp://u:p@host/ everywhere X)" "rc=2;"
check "refuses path-escaping drivers" "$(run add X ipp://h/ ../../etc/x X)" "rc=2;"
check "refuses option-like drivers" "$(run add X ipp://h/ -h X)" "rc=2;"
check "refuses control characters" "$(run add X ipp://h/ everywhere "$(printf 'a\nb')")" "rc=2;"
check "refuses unknown commands" "$(run 'devices;id')" "rc=2;"
check "refuses extra arguments" "$(run devices -v)" "rc=2;"

P=$ROOT/services/session/polkit
python3 -I - "$P/lk.worksuite.printers.policy" <<'PY' && ok "policy: auth_admin_keep, exec.path is the helper" || bad "policy: auth_admin_keep, exec.path is the helper"
import sys, xml.etree.ElementTree as ET
a = ET.parse(sys.argv[1]).getroot().find("action[@id='lk.worksuite.printers']")
assert a.find("defaults/allow_active").text == "auth_admin_keep"
assert a.find("defaults/allow_any").text == "no"
assert a.find("annotate[@key='org.freedesktop.policykit.exec.path']").text == "/usr/lib/worksuite/worksuite-printer-admin"
PY
grep -q 'action.id == "lk.worksuite.printers"' "$P/rules/50-worksuite-printers.rules" && grep -q 'isInGroup("lpadmin")' "$P/rules/50-worksuite-printers.rules" \
  && grep -q 'subject.local && subject.active' "$P/rules/50-worksuite-printers.rules" && ok "rule: local active lpadmin/sudo" || bad "rule: local active lpadmin/sudo"
INST=$ROOT/packaging/debian/worksuite-session.install
for f in "bin/worksuite-printer-admin usr/lib/worksuite/" "polkit/lk.worksuite.printers.policy usr/share/polkit-1/actions/" "polkit/rules/50-worksuite-printers.rules usr/share/polkit-1/rules.d/"; do
  grep -qx "services/session/$f" "$INST" && ok "installed: $f" || bad "installed: $f"
done
[ -x "$H" ] && ok "helper executable" || bad "helper executable"

L=$ROOT/live-build/config/package-lists/worksuite.list.chroot
for p in cups cups-daemon cups-filters cups-browsed ipp-usb avahi-daemon libnss-mdns cups-ipp-utils printer-driver-gutenprint; do
  grep -qx "$p" "$L" && ok "image: $p" || bad "image: $p"
done
grep -q 'LIVE_USER_DEFAULT_GROUPS=".* lpadmin"' "$ROOT/live-build/config/includes.chroot/etc/live/config.conf.d/worksuite.conf" && ok "live user in lpadmin" || bad "live user in lpadmin"
grep -q -- '- lpadmin' "$ROOT/installer/modules/usersq.conf" && ok "installed user in lpadmin" || bad "installed user in lpadmin"
exit $fail

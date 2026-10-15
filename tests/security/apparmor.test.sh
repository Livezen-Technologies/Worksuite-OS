#!/bin/sh
# WSOS-SEC-009: every shipped AppArmor profile compiles, every confined unit names its profile (with "-" so a
# kernel without AppArmor still boots), and only the shell profile is in complain mode.
#   tests/security/apparmor.test.sh       (needs apparmor_parser; no root, nothing is loaded)
set -eu
here=$(cd "$(dirname "$0")/../.." && pwd)
aa="$here/security/apparmor"
fail=0
check() { if eval "$2"; then echo "ok - $1"; else echo "not ok - $1"; fail=1; fi; }
command -v apparmor_parser >/dev/null || { echo "apparmor_parser missing (apt-get install apparmor)" >&2; exit 2; }

for p in "$aa"/*; do
  n=$(basename "$p")
  check "$n compiles" 'apparmor_parser -Q -K -T "$p" >/dev/null 2>"$p.err.$$" || { cat "$p.err.$$" >&2; false; }'
  rm -f "$p.err.$$"
  check "$n declares profile $n" 'grep -q "^profile $n " "$p"'
  if [ "$n" = worksuite-shell ]; then check "$n in complain mode (documented)" 'grep -q "complain" "$p"'
  else check "$n enforced" '! grep -q "complain" "$p"'; fi
done

unit() { u=$1; prof=$2; check "$u uses AppArmorProfile=-$prof" 'grep -q "^AppArmorProfile=-$prof\$" "$here/$u"'; }
unit services/device-agent/systemd/worksuite-device-agent.service worksuite-device-agent
unit services/package-service/systemd/worksuite-package-service.service worksuite-package-service
unit services/directory/systemd/worksuite-breakglass-rotate.service worksuite-directory
unit services/session/systemd/user/worksuite-shell.service worksuite-shell
unit services/recovery-boot/systemd/worksuite-recovery-shell.service worksuite-shell
for p in "$aa"/*; do
  n=$(basename "$p")
  check "$n installed to /etc/apparmor.d" 'cat "$here"/packaging/debian/*.install | grep -q "^security/apparmor/$n etc/apparmor.d/\$"'
done
exit $fail

#!/bin/sh
# Strict error handling lint: every listed script runs with `set -e…`, or says why it deliberately does not
# ("Deliberately no set -e", e.g. a file that is sourced into another shell). Sourced files must also end with a true
# status so a caller running with -e survives the `.`. Run: sh tests/repo/strict-shell.test.sh
set -eu
ROOT=$(cd "$(dirname "$0")/../.." && pwd)
n=0; fail=0
ok() { n=$((n + 1)); echo "ok $n - $1"; }
bad() { n=$((n + 1)); fail=1; echo "not ok $n - $1"; }
for f in \
    services/ai/bin/worksuite-ai \
    services/recovery-boot/bin/worksuite-boot-repair \
    services/device-agent/bin/worksuite-device-agent \
    services/package-service/networkmanager/90-worksuite-drivers \
    services/package-service/bin/worksuite-appimage \
    services/session/kiosk/worksuite-kiosk-signin \
    services/session/kiosk/worksuite-kiosk-session \
    services/session/kiosk/worksuite-kiosk-ctl \
    services/session/bin/worksuite-workspace-event \
    services/session/bin/worksuite-screencast-stop \
    services/session/bin/wlr-env \
    services/session/bin/worksuite-osk \
    services/session/bin/worksuite-toasts \
    services/session/bin/worksuite-signin \
    services/session/bin/worksuite-greeter; do
    p=$ROOT/$f
    if grep -Eq '^set -e' "$p"; then ok "$f: set -e"
    elif grep -q 'Deliberately no set -e' "$p"; then ok "$f: documented exception"
    else bad "$f: neither set -e nor a 'Deliberately no set -e' comment"; fi
done
# shellcheck disable=SC2016 # $1 expands in the inner shell
# wlr-env is sourced: under set -eu with an empty environment it must not abort its caller.
if env -i PATH="$PATH" HOME=/nonexistent WORKSUITE_SYSFS=/nonexistent WORKSUITE_KEYBOARD_CONF=/nonexistent \
    sh -eu -c '. "$1"; echo survived' sh "$ROOT/services/session/bin/wlr-env" | grep -qx survived; then
    ok "wlr-env can be sourced from a set -eu shell"
else bad "wlr-env can be sourced from a set -eu shell"; fi
kb=$(mktemp); trap 'rm -f "$kb"' EXIT
printf 'XKBLAYOUT=de\nXKBVARIANT=\n' > "$kb"
# shellcheck disable=SC2016
if env -i PATH="$PATH" HOME=/nonexistent WORKSUITE_SYSFS=/nonexistent WORKSUITE_KEYBOARD_CONF="$kb" \
    sh -eu -c '. "$1"; echo "$XKB_DEFAULT_LAYOUT"' sh "$ROOT/services/session/bin/wlr-env" | grep -qx de; then
    ok "wlr-env under set -eu with a partial keyboard file"
else bad "wlr-env under set -eu with a partial keyboard file"; fi
echo "1..$n"
exit "$fail"

#!/bin/sh
# Kiosk session scripts (WSOS-AUTH-002) with stubbed system programs. No root, no compositor.
# Run: sh tests/session/kiosk-test.sh
set -u
ROOT=$(cd "$(dirname "$0")/../.." && pwd)
K=$ROOT/services/session/kiosk
BIN=$ROOT/services/session/bin
T=$(mktemp -d); trap 'rm -rf "$T"' EXIT
n=0; fail=0
ok() { n=$((n + 1)); echo "ok $n - $1"; }
bad() { n=$((n + 1)); fail=1; echo "not ok $n - $1"; }
check() { if [ "$2" = "$3" ]; then ok "$1"; else bad "$1 (expected '$3', got '$2')"; fi; }
mkdir -p "$T/stub" "$T/run" "$T/home/.config/app" "$T/home/.cache" "$T/home/Documents"
stub() { printf '#!/bin/sh\n%s\n' "$2" > "$T/stub/$1"; chmod +x "$T/stub/$1"; }
ME=$(id -un)
export PATH="$T/stub:$PATH" LOG="$T/log" HOME="$T/home" XDG_RUNTIME_DIR="$T/run"
export WORKSUITE_KIOSK_ENV="$T/session.env" WORKSUITE_WLR_ENV=/dev/null
stub labwc 'echo "labwc $* KIOSK_IDLE_RESET_S=$KIOSK_IDLE_RESET_S KIOSK_OSK=$KIOSK_OSK" >> "$LOG"'
stub logger ':'
stub systemctl 'echo "systemctl $*" >> "$LOG"'
stub systemd-cat 'cat >/dev/null'

# ---- worksuite-session hands the kiosk account to the kiosk session ----
printf '#!/bin/sh\necho kiosk-session >> "$LOG"\n' > "$T/ks"; chmod +x "$T/ks"
printf 'KIOSK_USER=%s\nKIOSK_IDLE_RESET_S=600\nKIOSK_OSK=1\nKIOSK_EXIT_PIN=1\n' "$ME" > "$T/session.env"
WORKSUITE_KIOSK_SESSION="$T/ks" sh "$BIN/worksuite-session" >/dev/null 2>&1
grep -qx kiosk-session "$LOG" && ok "kiosk account: kiosk session instead of the shell" || bad "kiosk account: kiosk session instead of the shell"
grep -q '^labwc' "$LOG" && bad "kiosk account never gets the full shell" || ok "kiosk account never gets the full shell"
: > "$LOG"; printf 'KIOSK_USER=someoneelse\n' > "$T/session.env"
WORKSUITE_KIOSK_SESSION="$T/ks" sh "$BIN/worksuite-session" >/dev/null 2>&1
grep -q kiosk-session "$LOG" && bad "other accounts get the normal session" || ok "other accounts get the normal session"
grep -q '^labwc -C ' "$LOG" && ok "normal session runs Labwc with the WorkSuite config" || bad "normal session runs Labwc with the WorkSuite config"

# ---- worksuite-kiosk-session ----
: > "$LOG"
sh "$K/worksuite-kiosk-session" 2>/dev/null && bad "kiosk session refuses a non-kiosk account" || ok "kiosk session refuses a non-kiosk account"
grep -q labwc "$LOG" && bad "no compositor for a non-kiosk account" || ok "no compositor for a non-kiosk account"
printf 'KIOSK_USER=%s\nKIOSK_IDLE_RESET_S=600; reboot\nKIOSK_OSK=1\n' "$ME" > "$T/session.env"
WORKSUITE_KIOSK_LABWC="$T/labwc" sh "$K/worksuite-kiosk-session"
check "kiosk Labwc: locked config, kiosk start, validated values" "$(cat "$LOG")" "labwc -C $T/labwc -s /usr/lib/worksuite/worksuite-kiosk-start KIOSK_IDLE_RESET_S=0 KIOSK_OSK=1"
[ ! -e "$T/home/.config/app" ] && [ ! -e "$T/home/.cache" ] && ok "app data wiped (fresh session)" || bad "app data wiped (fresh session)"
[ -d "$T/home/Documents" ] && ok "only app data and caches are wiped" || bad "only app data and caches are wiped"

# ---- worksuite-kiosk-start: helpers, crash restart, stop on exit ----
: > "$LOG"
stub swayidle 'echo "swayidle $*" >> "$LOG"'
mkdir -p "$T/lib"; printf '#!/bin/sh\necho "osk $*" >> "$LOG"\n' > "$T/lib/worksuite-osk"; chmod +x "$T/lib/worksuite-osk"
printf '#!/bin/sh\necho app-run >> "$LOG"\nexit 1\n' > "$T/app"; chmod +x "$T/app"
KIOSK_IDLE_RESET_S=300 KIOSK_OSK=1 WORKSUITE_LIB="$T/lib" WORKSUITE_KIOSK_APP="$T/app" WORKSUITE_KIOSK_RESTART_DELAY=0 WORKSUITE_KIOSK_MAX_RESTARTS=3 sh "$K/worksuite-kiosk-start"
sleep 0.2
check "crashed app restarted" "$(grep -c '^app-run$' "$LOG")" 3
grep -q "^swayidle -w timeout 300 $T/lib/worksuite-kiosk-ctl reset$" "$LOG" && ok "idle reset after the policy's time" || bad "idle reset after the policy's time"
grep -q '^osk --kiosk$' "$LOG" && ok "on-screen keyboard hook started" || bad "on-screen keyboard hook started"
: > "$LOG"; rm "$T/lib/worksuite-osk"; stub wvkbd-mobintl 'echo "wvkbd $*" >> "$LOG"'
KIOSK_OSK=1 WORKSUITE_LIB="$T/lib" WORKSUITE_KIOSK_APP="$T/app" WORKSUITE_KIOSK_RESTART_DELAY=0 WORKSUITE_KIOSK_MAX_RESTARTS=1 sh "$K/worksuite-kiosk-start"
sleep 0.2
grep -q '^wvkbd -H 260 -L 208 -l full,special --fn IBM Plex Sans 16$' "$LOG" && ok "on-screen keyboard: the desktop's wvkbd, shown" || bad "on-screen keyboard: the desktop's wvkbd, shown"
: > "$LOG"; KIOSK_OSK=0 WORKSUITE_LIB="$T/lib" WORKSUITE_KIOSK_APP="$T/app" WORKSUITE_KIOSK_RESTART_DELAY=0 WORKSUITE_KIOSK_MAX_RESTARTS=1 sh "$K/worksuite-kiosk-start"
sleep 0.2
grep -q wvkbd "$LOG" && bad "no on-screen keyboard unless the policy asks" || ok "no on-screen keyboard unless the policy asks"
: > "$LOG"; mkdir -p "$T/run/worksuite-kiosk"; touch "$T/run/worksuite-kiosk/exiting"
WORKSUITE_LIB="$T/lib" WORKSUITE_KIOSK_APP="$T/app" sh "$K/worksuite-kiosk-start"
check "no restart once leaving kiosk mode" "$(grep -c '^app-run$' "$LOG")" 0
rm -f "$T/run/worksuite-kiosk/exiting"

# ---- worksuite-kiosk-ctl ----
sh -c 'trap "echo USR1 >> \"$LOG\"" USR1; trap "echo USR2 >> \"$LOG\"" USR2; i=0; while [ $i -lt 50 ]; do sleep 0.1; i=$((i+1)); done' & P=$!
sleep 0.2; echo "$P" > "$T/run/worksuite-kiosk/app.pid"
: > "$LOG"; sh "$K/worksuite-kiosk-ctl" exit-prompt; sleep 0.3; sh "$K/worksuite-kiosk-ctl" reset; sleep 0.3
check "ctl signals the kiosk app (USR1 exit prompt, USR2 reset)" "$(tr '\n' ' ' < "$LOG")" "USR1 USR2 "
echo '1; reboot' > "$T/run/worksuite-kiosk/app.pid"
sh "$K/worksuite-kiosk-ctl" reset 2>/dev/null && bad "ctl refuses a bad pid file" || ok "ctl refuses a bad pid file"
kill "$P" 2>/dev/null

# ---- PAM: greeter signs in only the kiosk account and administrators ----
stub id 'case "$3" in admin) echo "admin sudo";; *) echo "$3";; esac'
printf 'KIOSK_USER=kiosk\n' > "$T/session.env"
pam() { PAM_SERVICE=$1 PAM_USER=$2 sh "$K/worksuite-kiosk-signin"; }
pam greetd kiosk && ok "greeter: kiosk account allowed" || bad "greeter: kiosk account allowed"
pam greetd admin && ok "greeter: administrator allowed" || bad "greeter: administrator allowed"
pam greetd nimali && bad "greeter: other users refused" || ok "greeter: other users refused"
pam sudo nimali && ok "other PAM services unaffected" || bad "other PAM services unaffected"
WORKSUITE_KIOSK_ENV="$T/none" pam greetd nimali && ok "no kiosk mode: everyone allowed" || bad "no kiosk mode: everyone allowed"
rm "$T/stub/id"

# ---- worksuite-kiosk-apply ----
stub getent 'case "$2" in kiosk) echo "kiosk:x:1001:1001::/home/kiosk:/bin/sh";; *) exit 2;; esac'
stub useradd 'echo "useradd $*" >> "$LOG"'
stub passwd 'echo "passwd $*" >> "$LOG"'
stub id 'echo "$2"'
printf '#!/bin/sh\necho "autologin $*" >> "$LOG"\n' > "$T/autologin"; chmod +x "$T/autologin"
export WORKSUITE_AUTOLOGIN="$T/autologin" WORKSUITE_KIOSK_LOGIND="$T/logind/k.conf" WORKSUITE_KIOSK_SYSTEMCONF="$T/system/k.conf"
A="sh $K/worksuite-kiosk-apply"
: > "$LOG"
$A enable root >/dev/null 2>&1 && bad "apply: root refused" || ok "apply: root refused"
$A enable nimali >/dev/null 2>&1 && bad "apply: only the account the policy names" || ok "apply: only the account the policy names"
$A enable kiosk >/dev/null && ok "apply: enabled" || bad "apply: enabled"
grep -q '^autologin enable --kiosk kiosk$' "$LOG" && ok "apply: greetd autologin for the kiosk account" || bad "apply: greetd autologin for the kiosk account"
grep -q useradd "$LOG" && bad "apply: existing account reused" || ok "apply: existing account reused"
grep -qx 'NAutoVTs=0' "$T/logind/k.conf" && ok "apply: no gettys on other VTs" || bad "apply: no gettys on other VTs"
grep -qx 'CtrlAltDelBurstAction=none' "$T/system/k.conf" && ok "apply: Ctrl+Alt+Del burst does nothing" || bad "apply: Ctrl+Alt+Del burst does nothing"
grep -q 'systemctl mask --quiet ctrl-alt-del.target' "$LOG" && ok "apply: Ctrl+Alt+Del masked" || bad "apply: Ctrl+Alt+Del masked"
printf 'KIOSK_USER=visitor\n' > "$T/session.env"; : > "$LOG"
$A enable visitor >/dev/null && grep -q '^useradd --create-home --shell /bin/sh --comment WorkSuite kiosk --user-group visitor$' "$LOG" && grep -q '^passwd --lock visitor$' "$LOG" \
  && ok "apply: missing account created, password locked" || bad "apply: missing account created, password locked"
stub id 'echo "$2 sudo"'
printf 'KIOSK_USER=kiosk\n' > "$T/session.env"
$A enable kiosk >/dev/null 2>&1 && bad "apply: administrators cannot be the kiosk account" || ok "apply: administrators cannot be the kiosk account"
: > "$LOG"; $A disable >/dev/null
grep -q '^autologin disable$' "$LOG" && [ ! -e "$T/logind/k.conf" ] && [ ! -e "$T/system/k.conf" ] && grep -q 'unmask --quiet ctrl-alt-del.target' "$LOG" \
  && ok "apply: disable undoes it" || bad "apply: disable undoes it"
rm "$T/stub/id" "$T/stub/getent"

# ---- worksuite-autologin --kiosk takes the account from the kiosk policy file ----
stub getent 'case "$2" in kiosk|nimali) echo "$2:x:1000:1000::/home/$2:/bin/sh";; *) exit 2;; esac'
stub id 'echo "$2"'
printf '[default_session]\ncommand = "greeter"\n' > "$T/greetd.toml"
echo '{"enrolled":true,"policy":{"version":"3"}}' > "$T/state.json"
printf 'KIOSK_USER=kiosk\n' > "$T/session.env"
export WORKSUITE_GREETD_CONF="$T/greetd.toml" WORKSUITE_AGENT_STATE="$T/state.json"
sh "$BIN/worksuite-autologin" enable --kiosk nimali >/dev/null 2>&1 && bad "autologin: other accounts refused" || ok "autologin: other accounts refused"
sh "$BIN/worksuite-autologin" enable --kiosk kiosk >/dev/null && ok "autologin: kiosk policy account" || bad "autologin: kiosk policy account"
echo "1..$n"
exit $fail

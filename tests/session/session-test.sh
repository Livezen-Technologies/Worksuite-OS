#!/bin/sh
# Tests for the session scripts (screen lock, idle timeout, logout cleanup, greeter notice) with stubbed system
# programs. No root, no compositor. Run: sh tests/session/session-test.sh
set -u
ROOT=$(cd "$(dirname "$0")/../.." && pwd)
BIN=$ROOT/services/session/bin
T=$(mktemp -d)
trap 'kill $(cat "$T"/pids 2>/dev/null) 2>/dev/null; rm -rf "$T"' EXIT
mkdir -p "$T/stub" "$T/run" "$T/notice" "$T/home/.config/worksuite"
export PATH="$T/stub:$PATH" XDG_RUNTIME_DIR="$T/run" HOME="$T/home" XDG_CONFIG_HOME="$T/home/.config" XDG_STATE_HOME="$T/home/.local/state"
unset WAYLAND_DISPLAY LABWC_PID 2>/dev/null || true
fail=0; n=0
ok()   { n=$((n + 1)); echo "ok $n - $1"; }
bad()  { n=$((n + 1)); fail=1; echo "not ok $n - $1"; }
check() { if [ "$2" = "$3" ]; then ok "$1"; else bad "$1 (expected '$3', got '$2')"; fi; }

stub() { printf '#!/bin/sh\n%s\n' "$2" > "$T/stub/$1"; chmod +x "$T/stub/$1"; }
stub systemd-cat 'cat >/dev/null'
stub loginctl 'echo "loginctl $*" >> "$LOG"'
stub systemctl 'echo "systemctl $*" >> "$LOG"'
stub dbus-send 'echo "dbus-send $*" >> "$LOG"'
stub dbus-update-activation-environment 'true'
export LOG="$T/log"

# ---- idle timeout (WSOS-LOCK-003) ----
export WORKSUITE_LOCK_POLICY="$T/lock-policy.conf" WORKSUITE_LOCK_USER="$T/home/.config/worksuite/lock.conf"
timeout_for() {  # user policy
    rm -f "$WORKSUITE_LOCK_POLICY" "$WORKSUITE_LOCK_USER"
    [ -n "$1" ] && echo "LOCK_TIMEOUT_S=$1" > "$WORKSUITE_LOCK_USER"
    [ -n "$2" ] && echo "LOCK_TIMEOUT_MAX_S=$2" > "$WORKSUITE_LOCK_POLICY"
    sh "$BIN/worksuite-idle" --print-timeout
}
check "default idle timeout is 5 min" "$(timeout_for '' '')" 300
check "user choice applies without a policy" "$(timeout_for 120 '')" 120
check "user may choose never without a policy" "$(timeout_for 0 '')" 0
check "user choice below the policy maximum is kept" "$(timeout_for 120 900)" 120
check "user choice above the policy maximum is capped" "$(timeout_for 3600 900)" 900
check "never is not allowed under a policy maximum" "$(timeout_for 0 600)" 600
check "default above a lower policy maximum is capped" "$(timeout_for '' 60)" 60
printf 'LOCK_TIMEOUT_S=abc\nLOCK_TIMEOUT_S=; rm -rf /\n' > "$WORKSUITE_LOCK_USER"; rm -f "$WORKSUITE_LOCK_POLICY"
check "malformed user values are ignored" "$(sh "$BIN/worksuite-idle" --print-timeout)" 300

stub swayidle 'for a in "$@"; do printf "[%s]" "$a"; done'
echo "LOCK_TIMEOUT_S=240" > "$WORKSUITE_LOCK_USER"
check "swayidle locks on idle, on lock-session and before sleep (waiting for the locker)" \
    "$(WORKSUITE_LOCK_CMD=/x/lock sh "$BIN/worksuite-idle")" "[-w][timeout][240][loginctl lock-session][lock][/x/lock][before-sleep][/x/lock]"
echo "LOCK_TIMEOUT_S=0" > "$WORKSUITE_LOCK_USER"
check "no idle timeout when never, still locks before sleep" \
    "$(WORKSUITE_LOCK_CMD=/x/lock sh "$BIN/worksuite-idle")" "[-w][lock][/x/lock][before-sleep][/x/lock]"

# ---- locker: lock before returning, fail closed (WSOS-LOCK-002/004) ----
# Stub gtklock: runs its -L command (it holds the lock), then exits with the next status from $T/gtklock-rc.
cat > "$T/stub/gtklock" <<'EOF'
#!/bin/sh
while [ $# -gt 0 ]; do [ "$1" = "-L" ] && lockcmd=$2; shift; done
echo start >> "$T/gtklock-runs"
sh -c "$lockcmd"
rc=$(head -n 1 "$T/gtklock-rc"); sed -i 1d "$T/gtklock-rc"
[ -e "$T/gtklock-hold" ] && while [ -e "$T/gtklock-hold" ]; do sleep 0.05; done
exit "${rc:-0}"
EOF
chmod +x "$T/stub/gtklock"
export T
: > "$LOG"
printf '139\n134\n0\n' > "$T/gtklock-rc"     # SIGSEGV, SIGABRT, then a successful PAM unlock
touch "$T/gtklock-hold"
cp "$BIN/worksuite-lock" "$T/worksuite-lock"
if sh "$T/worksuite-lock"; then ok "worksuite-lock returns once the locker holds the lock"; else bad "worksuite-lock returns once the locker holds the lock"; fi
[ -e "$T/run/worksuite-locked" ] && ok "session is marked locked" || bad "session is marked locked"
if sh "$T/worksuite-lock"; then ok "a second lock request joins the running locker"; else bad "a second lock request joins the running locker"; fi
check "only one locker started for two requests" "$(wc -l < "$T/gtklock-runs" | tr -d ' ')" 1
rm -f "$T/gtklock-hold"
i=0; while [ -d "$T/run/worksuite-lock.guard" ] && [ $i -lt 100 ]; do sleep 0.1; i=$((i + 1)); done
check "a crashed locker is restarted until PAM unlock succeeds" "$(wc -l < "$T/gtklock-runs" | tr -d ' ')" 3
[ -e "$T/run/worksuite-locked" ] && bad "locked mark cleared after unlock" || ok "locked mark cleared after unlock"
grep -q "loginctl unlock-session" "$LOG" && ok "logind told about the unlock" || bad "logind told about the unlock"

# A locker that never takes the lock: worksuite-lock reports failure (swayidle logs it) but keeps trying.
rm -f "$T/gtklock-runs"; printf '1\n1\n1\n1\n1\n1\n' > "$T/gtklock-rc"
stub gtklock-fail 'echo start >> "$T/gtklock-runs"; exit 1'
if WORKSUITE_GTKLOCK=gtklock-fail WORKSUITE_LOCK_WAIT_S=1 sh "$T/worksuite-lock"; then bad "lock request fails when no locker can lock"; else ok "lock request fails when no locker can lock"; fi
[ -d "$T/run/worksuite-lock.guard" ] && ok "guard keeps retrying (fail closed)" || bad "guard keeps retrying (fail closed)"
cat "$T/run/worksuite-lock.guard/pid" >> "$T/pids" 2>/dev/null
kill "$(cat "$T/run/worksuite-lock.guard/pid")" 2>/dev/null; sleep 0.3; rm -rf "$T/run/worksuite-lock.guard"

# ---- logout cleanup (WSOS-SES-003) ----
: > "$LOG"
sleep 30 & labwc=$!; echo $labwc >> "$T/pids"
LABWC_PID=$labwc sh "$BIN/worksuite-session" --logout
sleep 0.1
for want in "systemctl --user stop worksuite-sync.service" "systemctl --user stop worksuite-credentials.service" \
            "org.freedesktop.Secret.Service.Lock" "systemctl --user stop worksuite-session.target" "systemctl --user unset-environment"; do
    grep -q -- "$want" "$LOG" && ok "logout: $want" || bad "logout: $want"
done
check "logout: sync stops before the keyring locks" "$(grep -n -e worksuite-sync -e Secret.Service.Lock "$LOG" | cut -d: -f1 | tr '\n' ' ')" "1 3 "
kill -0 $labwc 2>/dev/null && bad "logout ends the compositor" || ok "logout ends the compositor"

# ---- compositor exit notice → greeter (WSOS-SES-006) ----
export WORKSUITE_NOTICE_DIR="$T/notice"
stub labwc 'exit 1'
echo ': wlr env' > "$T/wlr-env"
WORKSUITE_WLR_ENV="$T/wlr-env" sh "$BIN/worksuite-session"; rc=$?
check "session exit status is the compositor's" "$rc" 1
[ -f "$T/notice/uid-$(id -u)" ] && ok "abnormal exit leaves a greeter notice" || bad "abnormal exit leaves a greeter notice"
stub zenity 'echo "zenity $*" >> "$LOG"'
stub gtkgreet 'echo "gtkgreet $*" >> "$LOG"'
: > "$LOG"
WORKSUITE_GREETER_LEGACY=1 sh "$BIN/worksuite-greeter" -c /usr/bin/worksuite-session
grep -q "zenity --warning" "$LOG" && grep -q "Open applications may have closed" "$LOG" && ok "greeter shows the notice" || bad "greeter shows the notice"
grep -q "gtkgreet -c /usr/bin/worksuite-session" "$LOG" && ok "greeter then starts gtkgreet" || bad "greeter then starts gtkgreet"
[ -e "$T/notice/uid-$(id -u)" ] && bad "notice removed after showing" || ok "notice removed after showing"
: > "$LOG"
WORKSUITE_GREETER_LEGACY=1 sh "$BIN/worksuite-greeter" -c /usr/bin/worksuite-session
grep -q zenity "$LOG" && bad "no notice after a clean session" || ok "no notice after a clean session"
# WSOS-AUTH-001: the WorkSuite greeter runs when GTK 4 bindings are present; gtkgreet only as the fallback.
stub python3 'echo "python3 $*" >> "$LOG"; exit 0'
: > "$LOG"
sh "$BIN/worksuite-greeter" -c /usr/bin/worksuite-session
grep -q "python3 -m worksuite_greeter" "$LOG" && ! grep -q gtkgreet "$LOG" && ok "greeter runs the WorkSuite greeter" || bad "greeter runs the WorkSuite greeter"
stub python3 'case "$*" in *require_version*) exit 1;; esac; echo "python3 $*" >> "$LOG"'
: > "$LOG"
sh "$BIN/worksuite-greeter" -c /usr/bin/worksuite-session
grep -q gtkgreet "$LOG" && ok "gtkgreet is the fallback without GTK 4" || bad "gtkgreet is the fallback without GTK 4"
rm -f "$T/stub/python3"
stub labwc 'exit 0'
WORKSUITE_WLR_ENV="$T/wlr-env" sh "$BIN/worksuite-session"
[ -e "$T/notice/uid-$(id -u)" ] && bad "clean exit leaves no notice" || ok "clean exit leaves no notice"

# ---- unit wiring ----
U=$ROOT/services/session/systemd/user
for u in worksuite-idle.service worksuite-idle-policy.path worksuite-polkit-agent.service; do
    grep -q "$u" "$U/worksuite-session.target" && ok "session target wants $u" || bad "session target wants $u"
done
grep -q '^KillMode=process$' "$U/worksuite-idle.service" && ok "restarting swayidle leaves a running locker alone" || bad "restarting swayidle leaves a running locker alone"
grep -q '^KillMode=mixed$' "$U/worksuite-shell.service" && ok "shell unit: SIGTERM to Electron, then its own helpers" || bad "shell unit KillMode"
grep -q 'worksuite-greeter' "$ROOT/live-build/config/hooks/normal/0100-worksuite-defaults.hook.chroot" && ok "greetd runs the greeter wrapper" || bad "greetd runs the greeter wrapper"

# ---- display environment before portals (WSOS-SES-001) ----
stub systemctl 'echo "systemctl $*" >> "$LOG"'
stub dbus-update-activation-environment 'echo "dbus-update-activation-environment $* XDG_CURRENT_DESKTOP=$XDG_CURRENT_DESKTOP" >> "$LOG"'
ready_log() { : > "$LOG"; env -u DISPLAY WAYLAND_DISPLAY=wayland-1 "$@" sh "$BIN/worksuite-session" --ready; }
ready_log
line_of() { grep -n -- "$1" "$LOG" | head -n 1 | cut -d: -f1; }
imp=$(line_of 'import-environment'); act=$(line_of 'dbus-update-activation-environment'); prt=$(line_of 'try-restart xdg-desktop-portal'); tgt=$(line_of 'start worksuite-session.target')
[ -n "$imp" ] && [ -n "$act" ] && [ -n "$tgt" ] && [ "$imp" -lt "$tgt" ] && [ "$act" -lt "$tgt" ] && ok "environment imported before the session target starts" || bad "environment imported before the session target starts"
[ -n "$prt" ] && [ "$act" -lt "$prt" ] && [ "$prt" -lt "$tgt" ] && ok "portals restarted with the imported environment" || bad "portals restarted with the imported environment"
grep -q 'import-environment WAYLAND_DISPLAY XDG_CURRENT_DESKTOP XDG_SESSION_TYPE XDG_SESSION_DESKTOP' "$LOG" && ok "WAYLAND_DISPLAY and XDG_CURRENT_DESKTOP imported" || bad "WAYLAND_DISPLAY and XDG_CURRENT_DESKTOP imported"
grep -q 'XDG_CURRENT_DESKTOP=WorkSuite:wlroots' "$LOG" && ok "XDG_CURRENT_DESKTOP is WorkSuite:wlroots" || bad "XDG_CURRENT_DESKTOP is WorkSuite:wlroots"
grep 'import-environment' "$LOG" | grep -qw DISPLAY && bad "DISPLAY not imported without XWayland" || ok "DISPLAY not imported without XWayland"
ready_log DISPLAY=:0
grep 'import-environment' "$LOG" | grep -qw DISPLAY && ok "DISPLAY imported when XWayland runs" || bad "DISPLAY imported when XWayland runs"

# ---- every session component is a user unit bound to worksuite-session.target (WSOS-SES-002) ----
for f in "$U"/*.service "$U"/*.path; do
    u=$(basename "$f")
    grep -q '^PartOf=worksuite-session.target$' "$f" && ok "$u is PartOf worksuite-session.target" || bad "$u is PartOf worksuite-session.target"
    case "$u" in worksuite-recovery-launcher.service|worksuite-idle-restart.service) continue ;; esac
    grep -q "^Wants=.*$u" "$U/worksuite-session.target" && ok "worksuite-session.target wants $u" || bad "worksuite-session.target wants $u"
done
grep -q '^BindsTo=graphical-session.target$' "$U/worksuite-session.target" && ok "session target bound to graphical-session.target" || bad "session target bound to graphical-session.target"

# ---- 3 shell crashes in 60 s → minimal launcher (WSOS-SES-005) ----
S=$U/worksuite-shell.service; R=$U/worksuite-recovery-launcher.service
grep -q '^StartLimitIntervalSec=60$' "$S" && grep -q '^StartLimitBurst=3$' "$S" && ok "shell start limit is 3 in 60 s" || bad "shell start limit is 3 in 60 s"
grep -q '^OnFailure=worksuite-recovery-launcher.service$' "$S" && ok "shell failure starts the recovery launcher" || bad "shell failure starts the recovery launcher"
grep -q '^ExecStart=/usr/lib/worksuite/shell/worksuite-shell --safe$' "$R" && ok "recovery launcher runs the shell's --safe launcher" || bad "recovery launcher runs --safe"
grep -q '^Conflicts=worksuite-shell.service$' "$R" && ok "recovery launcher replaces the shell" || bad "recovery launcher replaces the shell"
grep -q -- '--recovery' "$R" && bad "session launcher is not the boot recovery screens" || ok "session launcher is not the boot recovery screens"

# ---- screen-sharing consent per request (WSOS-INT-013) ----
CH=$BIN/worksuite-screencast-chooser
stub zenity 'echo "zenity $*" >> "$LOG"; [ -n "${ZENITY_PICK:-}" ] || exit 1; echo "$ZENITY_PICK"'
: > "$LOG"
check "chooser shares the screen the user picked" "$(printf 'eDP-1\nHDMI-A-1\n' | ZENITY_PICK=HDMI-A-1 sh "$CH")" "HDMI-A-1"
grep -q -- '--column=Screen' "$LOG" && grep -q 'eDP-1 HDMI-A-1' "$LOG" && ok "chooser lists every output" || bad "chooser lists every output"
printf 'eDP-1\n' | sh "$CH" >/dev/null; check "cancel denies the request" "$?" "1"
printf 'eDP-1\n' | ZENITY_PICK=evil sh "$CH" >/dev/null; check "unknown answer denies the request" "$?" "1"
: > "$LOG"; printf '' | ZENITY_PICK=eDP-1 sh "$CH" >/dev/null; check "no outputs: denied without asking" "$?:$(cat "$LOG")" "1:"
grep -q '^chooser_cmd=/usr/lib/worksuite/worksuite-screencast-chooser$' "$ROOT/services/session/xdg-desktop-portal-wlr/config" && ok "xdpw runs the consent chooser" || bad "xdpw runs the consent chooser"

echo "1..$n"
exit $fail

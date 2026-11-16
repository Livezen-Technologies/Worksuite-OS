#!/bin/sh
# Login keyring across sign-in, sign-out and sign-in again (WSOS-INT-009), without a real greetd: the PAM stack has one
# keyring pass in the right place, and sign-out stops the daemon so the next sign-in's PAM module starts and unlocks a
# fresh one through the socket. A fake systemctl / gnome-keyring-daemon on PATH stands in for the user manager.
#   sh tests/session/keyring-resignin-test.sh
# check() evals its single-quoted condition, which uses P, D, RUN and LOG.
# shellcheck disable=SC2016,SC2034
set -u
ROOT=$(cd "$(dirname "$0")/../.." && pwd)
P=$ROOT/services/session/pam
U=$ROOT/services/session/systemd/user
n=0; fail=0
ok() { n=$((n + 1)); echo "ok $n - $1"; }
bad() { n=$((n + 1)); fail=1; echo "not ok $n - $1"; }
check() { if eval "$2"; then ok "$1"; else bad "$1"; fi; }
T=$(mktemp -d); trap 'rm -rf "$T"' EXIT

# ---- PAM stack ----
check "greetd: login stack only, no keyring line of its own" 'grep -qx "@include login" "$P/greetd" && ! grep -q "^[^#]*pam_gnome_keyring" "$P/greetd"'
check "auth: optional pam_gnome_keyring.so, once" '[ "$(grep -c "	optional	pam_gnome_keyring.so$" "$P/worksuite-keyring")" = 1 ]'
check "session: optional pam_gnome_keyring.so auto_start, once" '[ "$(grep -c "	optional	pam_gnome_keyring.so auto_start$" "$P/worksuite-keyring")" = 1 ]'
check "auth part in Auth-Final, session part in Session-Final" 'awk "/^Auth-Final:/{s=\"a\"} /^Session-Type:/{s=\"\"} /^Session-Final:/{s=\"s\"} /pam_gnome_keyring.so\$/{a=s} /auto_start\$/{b=s} END{exit !(a == \"a\" && b == \"s\")}" "$P/worksuite-keyring"'
check "session part after pam_systemd (XDG_RUNTIME_DIR set, Priority below 0)" '[ "$(sed -n "s/^Priority: //p" "$P/worksuite-keyring")" -lt 0 ]'
check "no keyring line is required/requisite (sign-in never fails on the keyring)" '! grep -qE "(required|requisite).*pam_gnome_keyring" "$P/worksuite-keyring" "$P/greetd"'
check "faillock on, PIN and security-key profiles still off by default" 'grep -q "pam_faillock.so" "$P/worksuite-faillock" && grep -q "^Default: no$" "$P/worksuite-signin-pin" && grep -q "^Default: no$" "$P/worksuite-signin-u2f"'

# ---- the daemon ends with the graphical session (GNOME and WorkSuite) ----
D=$U/gnome-keyring-daemon.service.d/worksuite-session-end.conf
check "drop-in: gnome-keyring-daemon.service PartOf=graphical-session.target" 'grep -qx "PartOf=graphical-session.target" "$D"'
check "drop-in packaged with the user units" 'grep -q "^services/session/systemd/user/\* usr/lib/systemd/user/$" "$ROOT/packaging/debian/worksuite-session.install"'

# ---- sign-in, sign-out, sign-in with a fake user manager ----
mkdir -p "$T/bin" "$T/run"
LOG=$T/calls; : > "$LOG"
# gnome-keyring-daemon: records how it was started and whether it got the password (what pam_gnome_keyring does).
cat > "$T/bin/gnome-keyring-daemon" <<'S'
#!/bin/sh
echo "gnome-keyring-daemon $*" >> "$LOG"
if [ -e "$RUN/daemon" ]; then echo "already running" >> "$LOG"; exit 1; fi
pw=; [ "${1:-}" = --login ] && read -r pw
if [ -n "$pw" ]; then echo unlocked > "$RUN/daemon"; else echo locked > "$RUN/daemon"; fi
S
cat > "$T/bin/systemctl" <<'S'
#!/bin/sh
echo "systemctl $*" >> "$LOG"
case "$*" in
  "--user stop graphical-session.target"|"--user stop gnome-keyring-daemon.service") rm -f "$RUN/daemon" ;;
esac
exit 0
S
for c in dbus-send systemd-cat dbus-update-activation-environment; do printf '#!/bin/sh\nexit 0\n' > "$T/bin/$c"; done
chmod +x "$T/bin/"*
RUN=$T/run; PATH=$T/bin:$PATH; export LOG RUN PATH
# pam_gnome_keyring's session part (auto_start): hands the password to the daemon behind the socket (activating it).
signin() { echo secret | gnome-keyring-daemon --login >/dev/null 2>&1; }

signin
check "first sign-in: daemon started and unlocked" '[ "$(cat "$RUN/daemon")" = unlocked ]'
echo locked > "$RUN/daemon"   # sign-out locks the collection (Secret Service Lock)
sh "$ROOT/services/session/bin/worksuite-session" --logout
check "sign-out: worksuite-session stops gnome-keyring-daemon.service" 'grep -q "systemctl --user stop gnome-keyring-daemon.service" "$LOG"'
check "sign-out: its socket stays" '! grep -q "gnome-keyring-daemon.socket" "$LOG"'
check "sign-out: no locked daemon left for the next sign-in" '[ ! -e "$RUN/daemon" ]'
: > "$LOG"
signin
check "second sign-in: fresh daemon unlocked with the password" '[ "$(cat "$RUN/daemon")" = unlocked ] && ! grep -q "already running" "$LOG"'

# Without cleanup (GNOME session, or a WorkSuite session killed): the graphical-session.target stop takes it down.
echo locked > "$RUN/daemon"; : > "$LOG"
systemctl --user stop graphical-session.target
signin
check "session end without cleanup: next sign-in unlocks a fresh daemon" '[ "$(cat "$RUN/daemon")" = unlocked ] && ! grep -q "already running" "$LOG"'

echo "1..$n"
exit $fail

#!/bin/sh
# Device PIN and security-key sign-in PAM wiring (Settings > Users; WSOS-AUTH-004, DIR-009): both profiles are off by
# default, run after the faillock preauth and before the directory helper and pam_unix, pass the PIN on stdin only,
# keep the PIN away from the login keyring, and are packaged with their daemon, polkit action and helper.
#   sh tests/session/signin-pam-test.sh
set -u
ROOT=$(cd "$(dirname "$0")/../.." && pwd)
P=$ROOT/services/session/pam
n=0; fail=0
ok() { n=$((n + 1)); echo "ok $n - $1"; }
bad() { n=$((n + 1)); fail=1; echo "not ok $n - $1"; }
check() { if eval "$2"; then ok "$1"; else bad "$1"; fi; }
prio() { sed -n 's/^Priority: //p' "$1"; }

for f in worksuite-signin-pin worksuite-signin-pin-final worksuite-signin-u2f; do
  check "$f is off by default" 'grep -q "^Default: no$" "$P/$f"'
done
check "existing profiles stay on" 'grep -q "^Default: yes$" "$P/worksuite-faillock" && grep -q "^Default: yes$" "$P/worksuite-keyring"'

# pam-auth-update orders Primary modules by Priority, highest first.
pre=$(prio "$P/worksuite-faillock-preauth"); u2f=$(prio "$P/worksuite-signin-u2f"); pin=$(prio "$P/worksuite-signin-pin")
dir=$(prio "$ROOT/services/directory/pam/worksuite-directory"); fl=$(prio "$P/worksuite-faillock")
check "faillock preauth runs first (locked accounts refused before a PIN or key)" '[ "$pre" -gt "$u2f" ]'
check "security key before PIN" '[ "$u2f" -gt "$pin" ]'
check "PIN before the directory helper and pam_unix (256)" '[ "$pin" -gt "$dir" ] && [ "$pin" -gt 256 ]'
check "faillock authfail after them (a wrong PIN counts as a failed sign-in)" '[ "$fl" -lt 256 ]'

check "PIN: pam_exec, quiet, token on stdin" 'grep -q "pam_exec.so quiet expose_authtok /usr/lib/worksuite/worksuite-signin pam-pin$" "$P/worksuite-signin-pin"'
check "PIN: success ends the stack, anything else falls through to the password" 'grep -q "^	\[success=end default=ignore\]	pam_exec.so" "$P/worksuite-signin-pin"'
check "PIN: no log= or debug (the token is never written)" '! grep -Eq "log=|debug" "$P/worksuite-signin-pin" "$P/worksuite-signin-pin-final"'
check "PIN count reset only after a successful sign-in (Auth-Final, no token)" 'grep -q "^Auth-Final:" "$P/worksuite-signin-pin-final" && ! grep -q expose_authtok "$P/worksuite-signin-pin-final"'
check "u2f: pam_u2f with the WorkSuite authfile and origin" 'grep -q "pam_u2f.so authfile=/etc/worksuite/u2f_mappings origin=pam://worksuite appid=pam://worksuite cue nouserok" "$P/worksuite-signin-u2f"'
check "u2f: users without a key are skipped (nouserok)" 'grep -q nouserok "$P/worksuite-signin-u2f"'
check "keyring: skipped when the sign-in used the PIN" 'awk "/pam-pin-used/{a=NR} /pam_gnome_keyring.so\$/{b=NR} END{exit !(a && b == a + 1)}" "$P/worksuite-keyring"'
check "keyring: the skip jumps exactly one module" 'grep -q "^	\[success=1 default=ignore\]	pam_exec.so quiet /usr/lib/worksuite/worksuite-signin pam-pin-used$" "$P/worksuite-keyring"'
# pam_gnome_keyring's session part needs XDG_RUNTIME_DIR, which pam_systemd sets: it must come after it. pam-auth-update
# sorts by Priority, then by profile name backwards, so at systemd's Priority 0 "worksuite-keyring" came first; the
# module found no control socket, started a daemon of its own outside the user manager, and the session's daemon
# stayed locked ("Unlock Login Keyring" on every sign-in after the first).
check "keyring: session part after pam_systemd (Priority below systemd's 0)" '[ "$(prio "$P/worksuite-keyring")" -lt 0 ]'
check "PIN is not in any boot-time unlock path" '! grep -rqs "worksuite-signin" "$ROOT/installer" "$ROOT/services/recovery-boot" "$ROOT/live-build/config/hooks"'

S=$ROOT/services/session/systemd/system
check "daemon socket accepts per connection" 'grep -q "^Accept=yes$" "$S/worksuite-signin.socket"'
check "daemon runs the helper with the connection on stdin" 'grep -q "^ExecStart=/usr/lib/worksuite/worksuite-signin serve$" "$S/worksuite-signin@.service" && grep -q "^StandardInput=socket$" "$S/worksuite-signin@.service"'
check "daemon has no network" 'grep -q "^PrivateNetwork=yes$" "$S/worksuite-signin@.service"'
A=$ROOT/services/session/polkit/lk.worksuite.signin.policy
check "polkit: the person types their own password every time" 'grep -q "<allow_active>auth_self</allow_active>" "$A"'
check "polkit: the action is tied to the helper path" 'grep -q "exec.path\">/usr/lib/worksuite/worksuite-signin<" "$A"'
check "helper runs python isolated (-I)" 'grep -q "python3 -I" "$ROOT/services/session/bin/worksuite-signin"'

I=$ROOT/packaging/debian/worksuite-session.install
for f in bin/worksuite-signin signin/worksuite_signin pam/worksuite-signin-pin pam/worksuite-signin-pin-final pam/worksuite-signin-u2f \
         systemd/system/worksuite-signin.socket "systemd/system/worksuite-signin@.service" polkit/lk.worksuite.signin.policy; do
  check "packaged: $f" 'grep -q "^services/session/$f " "$I"'
done
# #56: the image is built in a chroot (no /run/systemd/system); the socket must be enabled there too.
check "postinst enables the PIN socket even without a running systemd" 'grep -q "^  systemctl enable worksuite-signin.socket" "$ROOT/packaging/debian/worksuite-session.postinst"'
# #56/#57: lk.worksuite.SignIn1 is a Python dbus-next service, activated as root.
check "worksuite-session depends on python3-dbus-next" 'sed -n "/^Package: worksuite-session$/,/^Description/p" "$ROOT/packaging/debian/control" | grep -q "python3-dbus-next"'
check "SignIn1 is packaged with its bus policy and activation file" 'grep -q "lk.worksuite.SignIn1.conf usr/share/dbus-1/system.d/" "$I" && grep -q "lk.worksuite.SignIn1.service usr/share/dbus-1/system-services/" "$I"'
check "prerm removes the profiles" 'grep -q "worksuite-signin-pin worksuite-signin-pin-final worksuite-signin-u2f" "$ROOT/packaging/debian/worksuite-session.prerm"'
check "image ships pam_u2f and pamu2fcfg" 'grep -qx libpam-u2f "$ROOT/live-build/config/package-lists/worksuite.list.chroot" && grep -qx pamu2fcfg "$ROOT/live-build/config/package-lists/worksuite.list.chroot"'

# The helper's own tests (verifier, lockout, PIN never in argv/logs).
check "helper unit tests" '(cd "$ROOT/services/session/signin" && python3 -m unittest discover -s tests -t . >/dev/null 2>&1)'
echo "1..$n"
exit $fail

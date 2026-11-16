#!/bin/sh
# Break-glass admin (WSOS-DIR-010, docs/security/break-glass-admin.md): postinst is idempotent and an upgrade keeps an
# existing wsadmin and its escrowed password; the sudoers drop-in parses and only touches wsadmin; the PAM account
# rule refuses wsadmin for remote services only. System commands are stubbed.
# check() evals its condition later, so single-quoted variables are intended and are used there.
# shellcheck disable=SC2016,SC2034
set -u
HERE=$(cd "$(dirname "$0")" && pwd)
ROOT="$HERE/../.."
POSTINST="$ROOT/packaging/debian/worksuite-directory.postinst"
SUDOERS="$ROOT/services/directory/sudoers/worksuite-breakglass"
PAMCFG="$ROOT/services/directory/pam/worksuite-directory"
T=$(mktemp -d); trap 'rm -rf "$T"' EXIT
mkdir -p "$T/stub"; LOG="$T/log"
n=0; fails=0
ok() { n=$((n + 1)); echo "ok $n - $1"; }
bad() { n=$((n + 1)); fails=$((fails + 1)); echo "not ok $n - $1"; }
check() { if eval "$2"; then ok "$1"; else bad "$1"; fi; }
stub() { printf '#!/bin/sh\n%s\n' "$2" > "$T/stub/$1"; chmod +x "$T/stub/$1"; }
for c in useradd usermod groupmod chgrp chpasswd passwd pam-auth-update systemctl install; do stub "$c" "echo \"$c \$*\" >> \"$LOG\""; done
stub aa-enabled 'exit 1'
stub pgrep 'exit 1'
run() { : > "$LOG"; PATH="$T/stub:$PATH" sh "$POSTINST" configure "$1"; }

# Fresh install, then the same configure again (dpkg --configure re-run): one account, created once.
stub getent 'case "$1 $2" in "passwd wsadmin") exit 2;; *) exit 2;; esac'
run ""
check "fresh install creates wsadmin locked" 'grep -q "^useradd --system .* wsadmin$" "$LOG" && grep -q "^usermod --lock wsadmin" "$LOG"'
stub getent 'case "$1 $2" in "passwd wsadmin") echo "wsadmin:x:999:999::/home/wsadmin:/bin/bash";; "group wsadmin") echo "wsadmin:x:999:";; *) exit 2;; esac'
stub id 'echo 999'
run ""
check "re-running configure creates nothing" '! grep -q "^useradd" "$LOG"'
check "re-running configure leaves the password alone" '! grep -q "^usermod --lock\|^chpasswd\|^passwd" "$LOG"'
check "re-running configure refreshes the PAM profiles" 'grep -q "^pam-auth-update --package" "$LOG"'

# Upgrade from an older version (its wsadmin holds an escrowed, unlocked password): kept as is.
for old in 0.1.0 0.9.0; do
  run "$old"
  check "upgrade from $old keeps wsadmin and its escrowed password" '! grep -q "^useradd\|^usermod --lock\|^chpasswd\|^passwd" "$LOG"'
done
# Upgrade from a version whose wsadmin was a regular user at 1000: only the UID moves, the password is not touched.
stub getent 'case "$1 $2" in "passwd wsadmin") echo "wsadmin:x:1000:1000::/home/wsadmin:/bin/bash";; "group wsadmin") echo "wsadmin:x:1000:";; *) exit 2;; esac'
stub id 'echo 1000'
run 0.1.0
check "upgrade from a UID-1000 wsadmin moves the UID only" 'grep -q "^usermod --uid 999 wsadmin" "$LOG" && ! grep -q "^usermod --lock\|^chpasswd" "$LOG"'

# sudoers drop-in: valid, only wsadmin defaults, no rule that grants anything.
VISUDO=$(command -v visudo || ls /usr/sbin/visudo 2>/dev/null || true)
if [ -n "$VISUDO" ]; then
  # Check a root-owned 0440 copy, as installed. CI runners are not root but have passwordless sudo.
  AS=""; [ "$(id -u)" -eq 0 ] || AS="sudo -n"
  cp "$SUDOERS" "$T/sudoers"
  $AS chown 0:0 "$T/sudoers" 2>/dev/null; $AS chmod 0440 "$T/sudoers" 2>/dev/null
  if out=$($AS "$VISUDO" -c -f "$T/sudoers" 2>&1); then ok "sudoers drop-in passes visudo -c"
  else bad "sudoers drop-in passes visudo -c"; echo "$out" | sed 's/^/# /'; fi
  $AS rm -f "$T/sudoers" 2>/dev/null
else
  check "sudoers drop-in syntax (no visudo)" '! grep -v "^#" "$SUDOERS" | grep -v "^$" | grep -qv "^Defaults:wsadmin [a-z_]*$"'
fi
check "sudoers drop-in records wsadmin output" 'grep -q "^Defaults:wsadmin log_output$" "$SUDOERS"'
check "sudoers drop-in grants nothing and changes no global default" '! grep -v "^#" "$SUDOERS" | grep -q "ALL\|^Defaults[[:space:]]\|^Defaults!\|NOPASSWD\|log_input"'
check "sudoers file name has no dot (sudo would skip it)" 'case "$(basename "$SUDOERS")" in *.*) false;; *) true;; esac'
check "drop-in is installed to /etc/sudoers.d" 'grep -q "^services/directory/sudoers/worksuite-breakglass etc/sudoers.d/$" "$ROOT/packaging/debian/worksuite-directory.install"'

# PAM account rule: skip for everyone but wsadmin; wsadmin refused for remote services only.
ACC=$(awk '/^Account:/{f=1;next} /^[A-Z]/{f=0} f' "$PAMCFG")
check "PAM profile declares an additional account section" 'grep -q "^Account-Type: Additional$" "$PAMCFG"'
check "PAM account rule skips users other than wsadmin" 'echo "$ACC" | sed -n 1p | grep -q "\[success=1 default=ignore\][[:space:]]*pam_succeed_if.so quiet user != wsadmin$"'
check "PAM account rule refuses wsadmin over remote services" 'echo "$ACC" | sed -n 2p | grep -q "^[[:space:]]*requisite[[:space:]]*pam_succeed_if.so quiet service notin sshd:xrdp-sesman:cockpit:vnc$"'
check "PAM account section has exactly these two lines" '[ "$(echo "$ACC" | grep -c .)" -eq 2 ]'
check "local console, greeter and sudo stay allowed" '! echo "$ACC" | grep -q "greetd\|login\|sudo\|su:\|systemd-user\|polkit"'
check "auth and session lines are unchanged" 'grep -q "^	\[success=end default=ignore\]	pam_worksuite.so$" "$PAMCFG" && grep -q "pam_exec.so quiet type=open_session /usr/libexec/worksuite/worksuite-pam-directory session$" "$PAMCFG"'

# Rotation after use and the boot/monthly rotation are still wired up.
check "session hook still starts a rotation" 'grep -q "worksuite-breakglass-rotate.service" "$ROOT/services/directory/src/main.ts"'

echo "1..$n"
[ "$fails" -eq 0 ]

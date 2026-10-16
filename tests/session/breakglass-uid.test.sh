#!/bin/sh
# worksuite-directory postinst: the break-glass account (wsadmin) is a system account below UID 1000, so the first
# real user gets 1000; an older wsadmin at 1000 moves to a system UID. System commands are stubbed.
set -u
HERE=$(cd "$(dirname "$0")" && pwd)
POSTINST="$HERE/../../packaging/debian/worksuite-directory.postinst"
T=$(mktemp -d); trap 'rm -rf "$T"' EXIT
mkdir -p "$T/stub"; LOG="$T/log"
n=0; fails=0
ok() { n=$((n + 1)); echo "ok $n - $1"; }
bad() { n=$((n + 1)); fails=$((fails + 1)); echo "not ok $n - $1"; }
stub() { printf '#!/bin/sh\n%s\n' "$2" > "$T/stub/$1"; chmod +x "$T/stub/$1"; }
for c in useradd usermod groupmod chgrp pam-auth-update systemctl install; do stub "$c" "echo \"$c \$*\" >> \"$LOG\""; done
stub aa-enabled 'exit 1'
stub pgrep 'exit 1'
run() { : > "$LOG"; PATH="$T/stub:$PATH" sh "$POSTINST" configure; }

# Fresh install, UID 999 taken by another system account: wsadmin gets 998, as a system account.
stub getent 'case "$1 $2" in "passwd wsadmin") exit 2;; "passwd 999") echo "x:x:999:999::/:/bin/false";; *) exit 2;; esac'
run
grep -q "^useradd --system --uid 998 .* wsadmin$" "$LOG" && ok "new wsadmin is a system account below 1000" || bad "new wsadmin is a system account below 1000"
grep -q "^usermod --lock wsadmin" "$LOG" && ok "new wsadmin is locked" || bad "new wsadmin is locked"

# Upgrade: wsadmin at UID 1000 moves to 999.
stub getent 'case "$1 $2" in "passwd wsadmin") echo "wsadmin:x:1000:1000::/home/wsadmin:/bin/bash";; "group wsadmin") echo "wsadmin:x:1000:";; *) exit 2;; esac'
stub id 'echo 1000'
run
grep -q "^usermod --uid 999 wsadmin" "$LOG" && ok "old wsadmin at 1000 moves to 999" || bad "old wsadmin at 1000 moves to 999"
grep -q "^groupmod --gid 999 wsadmin" "$LOG" && ok "and its group too" || bad "and its group too"
grep -q "^useradd" "$LOG" && bad "no second wsadmin" || ok "no second wsadmin"

# Already a system account: left alone.
stub id 'echo 999'
run
grep -q "^usermod --uid\|^useradd" "$LOG" && bad "system wsadmin left alone" || ok "system wsadmin left alone"

# live-config 0031 still creates the live user at the next free UID (no fixed 1000).
LIVE="$HERE/../../live-build/config/includes.chroot/usr/lib/live/config/0031-worksuite-live-user"
grep -q -- "--uid" "$LIVE" && bad "0031 picks no fixed UID" || ok "0031 picks no fixed UID"

echo "1..$n"
[ "$fails" -eq 0 ]

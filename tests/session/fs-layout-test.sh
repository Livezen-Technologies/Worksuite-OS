#!/bin/sh
# SRS §11.6-b: packaged defaults go to /usr (and /usr/share), configuration to /etc, never to /var, /home, /opt or
# /root; the shell keeps per-user state in the XDG base directories (shell/electron/xdgDirs.ts), not hard-coded
# ~/.config, ~/.local or ~/.cache paths. Run: sh tests/session/fs-layout-test.sh
set -u
ROOT=$(cd "$(dirname "$0")/../.." && pwd)
fail=0; n=0
ok()  { n=$((n + 1)); echo "ok $n - $1"; }
bad() { n=$((n + 1)); fail=1; echo "not ok $n - $1"; }

# 1. Every .install destination is under usr/, etc/ or lib/.
wrong=$(for f in "$ROOT"/packaging/debian/*.install; do
  grep -v '^[[:space:]]*\(#\|$\)' "$f" | awk -v f="$(basename "$f")" '{ d = $NF; sub(/^\//, "", d); if (d !~ /^(usr|etc|lib)\//) print f ": " $0 }'
done)
if [ -z "$wrong" ]; then ok "package files install under /usr, /etc or /lib"; else bad "files installed outside /usr, /etc, /lib:"; echo "$wrong" | sed 's/^/#   /'; fi

# 2. System-wide defaults the session reads live in /etc/xdg or /usr/share, not in a user's home.
if grep -rqE '"/home/|'"'"'/home/' "$ROOT"/services/session/bin 2>/dev/null; then bad "session scripts hard-code /home paths"; else ok "session scripts do not hard-code /home"; fi

# 3. No hard-coded per-user dot directories in the shell's main process (comments and tests excluded).
#    kioskMain.ts wipes the default directories of the kiosk account on purpose.
hits=$(grep -nE "join\([^)]*'\.(config|cache|local)'|'\.local/(share|state)'|'\.config/" "$ROOT"/shell/electron/*.ts \
  | grep -v '\.test\.ts:' | grep -v '/xdgDirs\.ts:' | grep -v '/kioskMain\.ts:' | grep -vE '^[^:]+:[0-9]+:\s*(//|\*|/\*)')
if [ -z "$hits" ]; then ok "shell uses XDG base directories for user state"; else bad "hard-coded user dot directories:"; echo "$hits" | sed 's/^/#   /'; fi

# 4. The user services take their directories from the XDG variables.
for f in services/credentials/src/main.ts services/sync/src/main.ts; do
  if grep -q 'XDG_CONFIG_HOME\|XDG_STATE_HOME\|XDG_DATA_HOME' "$ROOT/$f"; then ok "$f reads XDG directories"; else bad "$f ignores XDG directories"; fi
done

echo "1..$n"
exit $fail

#!/bin/sh
# pam_worksuite.so against a stand-in helper through real libpam (WSOS-DIR-009). Needs gcc and libpam0g-dev.
#   PAM_INCLUDE=/path/to/include  (optional, headers outside /usr/include)
set -eu
here=$(cd "$(dirname "$0")" && pwd)
work=$(mktemp -d)
trap 'rm -rf "$work"' EXIT
make -s -C "$here" OUT="$work" pam_worksuite.so test_harness >/dev/null
mkdir -p "$work/conf" "$work/out"
cp "$here/fake-helper.sh" "$work/helper"; chmod 755 "$work/helper"
printf 'auth required %s/pam_worksuite.so helper=%s/helper timeout=5\n' "$work" "$work" > "$work/conf/wstest"
run() { WS_PASSWORD="$2" WS_CODE="${3:-}" "$work/test_harness" "$work/conf" "$1" > "$work/log" 2>&1 || true; }
fail() { echo "FAIL: $*"; cat "$work/log"; exit 1; }
sed -i "s#\${0%/\*}/out#$work/out#" "$work/helper"

run alice@example.lk good
grep -q 'result: Success' "$work/log" || fail "good password"
grep -q '^auth$' "$work/out/argv" || fail "helper argv"
grep -q 'good' "$work/out/argv" && fail "password on argv"
grep -q 'good' "$work/out/env" && fail "password in environment"
grep -q '^PAM_USER=alice@example.lk$' "$work/out/env" || fail "PAM_USER"
grep -q '^PAM_TYPE=auth$' "$work/out/env" || fail "PAM_TYPE"

: > "$work/out/stdin"
run alice@example.lk mfa 123456
grep -q 'prompt-on: Verification code: ' "$work/log" || fail "second factor prompt"
grep -q 'result: Success' "$work/log" || fail "password + code"
[ "$(cat "$work/out/stdin")" = "$(printf 'mfa\nmfa123456')" ] || fail "code joined to the password on stdin"

run alice@example.lk mfa 12ab
grep -q 'result: Authentication failure' "$work/log" || fail "bad code refused"
grep -q 'info: Enter the 6-digit code' "$work/log" || fail "bad code message"

run alice@example.lk wrong
grep -q 'result: Authentication failure' "$work/log" || fail "wrong password"

run alice@example.lk expired
grep -q 'info: Your password has expired' "$work/log" || fail "expired message"

# Local names never reach the helper: the stack goes on to pam_unix (PAM_IGNORE → no module succeeded).
: > "$work/out/argv"
run alice good
[ ! -s "$work/out/argv" ] || fail "helper ran for a local name"
grep -q 'result: Authentication failure\|result: Permission denied\|result: Error in service module\|result: Authentication service cannot retrieve' "$work/log" || true

run alice@example.lk notdir
grep -q 'result: Success' "$work/log" && fail "not-directory must not succeed"

# The helper missing → service unavailable, not success.
printf 'auth required %s/pam_worksuite.so helper=/nonexistent timeout=5\n' "$work" > "$work/conf/wstest"
run alice@example.lk good
grep -q 'result: Authentication service cannot retrieve authentication info' "$work/log" || fail "missing helper"
echo "pam_worksuite: all checks passed"

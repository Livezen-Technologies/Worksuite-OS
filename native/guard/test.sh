#!/bin/sh
# worksuite-guard (issue #38): the pure parts always (--selftest); with root and fanotify also live, against a
# protected folder in a scratch directory: an untrusted program cannot write there but can read, a system program can
# write, a burst of renames suspends the process, and a denied executable cannot start.
set -eu
here=$(cd "$(dirname "$0")" && pwd)
work=$(mktemp -d /var/tmp/ws-guard.XXXXXX)
pid=
trap '[ -n "$pid" ] && kill "$pid" 2>/dev/null; rm -rf "$work"' EXIT
make -s -C "$here" OUT="$work" worksuite-guard
"$work/worksuite-guard" --selftest
fail() { echo "FAIL: $*"; cat "$work/log" 2>/dev/null; exit 1; }

if [ "$(id -u)" != 0 ]; then echo "worksuite-guard live test: skipped (needs root)"; exit 0; fi
mkdir -p "$work/prot" "$work/bin"
echo original > "$work/prot/doc.txt"
# "Untrusted" programs: copies the guard must not trust (group/other-writable, like anything a user dropped).
cp "$(command -v tee)" "$work/bin/tee"; cp "$(command -v cat)" "$work/bin/cat"; cp /bin/true "$work/bin/evil"
chmod 0777 "$work/bin/tee" "$work/bin/cat"; chmod 0755 "$work/bin/evil"
sha=$(sha256sum "$work/bin/evil" | cut -d' ' -f1)
cat > "$work/guard.conf" <<CONF
protect $work/prot
deny-sha256 $sha
burst 40 30
mode enforce
CONF
"$work/worksuite-guard" --config "$work/guard.conf" > "$work/log" 2>&1 &
pid=$!
i=0; until grep -q '"event":"started"' "$work/log"; do
  if ! kill -0 "$pid" 2>/dev/null && grep -q 'fanotify_init' "$work/log"; then echo "worksuite-guard live test: skipped (no fanotify here)"; exit 0; fi
  i=$((i+1)); [ $i -lt 50 ] || fail "did not start"; sleep 0.1
done
if grep -q 'cannot watch' "$work/log"; then echo "worksuite-guard live test: skipped (fanotify file system marks unavailable here)"; exit 0; fi

echo encrypted | "$work/bin/tee" "$work/prot/doc.txt" >/dev/null 2>&1 && fail "untrusted program opened a protected file for writing"
[ "$(cat "$work/prot/doc.txt")" = original ] || fail "protected file changed"
# O_CREAT makes the (empty) file before the permission check; its contents are still refused.
echo encrypted | "$work/bin/tee" "$work/prot/new.txt" >/dev/null 2>&1 && fail "untrusted program wrote a new file"
[ ! -s "$work/prot/new.txt" ] || fail "new file has contents"
grep -q '"event":"write_blocked"' "$work/log" || fail "no write_blocked event"
[ "$("$work/bin/cat" "$work/prot/doc.txt")" = original ] || fail "untrusted program could not read"
touch "$work/prot/system.txt" || fail "system program could not write"
"$work/bin/evil" 2>/dev/null && fail "denied executable ran"
grep -q '"event":"exec_blocked"' "$work/log" || fail "no exec_blocked event"
true || fail "allowed executable did not run"

# Burst: one process (a system interpreter, so its writes are allowed) renaming many files is suspended.
for n in $(seq 1 60); do echo x > "$work/prot/f$n"; done
perl -e 'for (1..60) { rename("$ARGV[0]/f$_", "$ARGV[0]/f$_.locked"); select(undef, undef, undef, 0.01) }' "$work/prot" &
victim=$!
i=0; until grep -q '"event":"burst_suspended"' "$work/log"; do i=$((i+1)); [ $i -lt 100 ] || fail "burst not detected"; sleep 0.1; done
sleep 0.3
state=$(awk '{print $3}' "/proc/$(sed -n 's/.*"burst_suspended","pid":\([0-9]*\).*/\1/p' "$work/log" | head -1)/stat" 2>/dev/null || echo gone)
[ "$state" = T ] || fail "offending process not stopped (state $state)"
[ "$(ls "$work/prot" | grep -c locked)" -lt 60 ] || fail "every file was renamed"
kill -KILL "$victim" 2>/dev/null || true
echo "worksuite-guard live test: ok"

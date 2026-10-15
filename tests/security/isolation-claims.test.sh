#!/bin/sh
# WSOS-SEC-013: documentation must not claim isolation between unsandboxed apps of the same user.
# Flags sentences that claim apps/applications are isolated or sandboxed from each other unless the same line
# qualifies the claim (Flatpak, web app, partition, a negation).
set -eu
root=$(cd "$(dirname "$0")/../.." && pwd)
pat='(apps?|applications?|programs?)[^.|]{0,60}(isolated|sandboxed|cannot (see|read|access))[^.|]{0,40}(each other|one another|other apps|other applications)'
ok='[Ff]latpak|web app|partition|[Nn]ot |[Nn]o |does not|do not|SEC-013|must not'
t=$(mktemp); trap 'rm -f "$t"' EXIT
# Self-test of the matcher first.
echo 'All applications are isolated from each other.' > "$t"
grep -q -i -E "$pat" "$t" || { echo "not ok - matcher misses a claim"; exit 1; }
echo 'Flatpak apps are sandboxed from each other.' > "$t"
if grep -i -E "$pat" "$t" | grep -q -v -E "$ok"; then echo "not ok - qualified claim flagged"; exit 1; fi
find "$root/docs" "$root/README.md" "$root/live-build/README.md" -name '*.md' -type f 2>/dev/null > "$t"
hits=$(while read -r f; do grep -n -i -E "$pat" "$f" | grep -v -E "$ok" | sed "s|^|$f:|"; done < "$t" || true)
if [ -n "$hits" ]; then
  echo "not ok - isolation claim about unsandboxed apps (WSOS-SEC-013):"; echo "$hits"; exit 1
fi
echo "ok - no unqualified isolation claims in docs"

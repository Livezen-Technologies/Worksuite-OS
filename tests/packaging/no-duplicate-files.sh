#!/bin/sh
# Two WorkSuite packages must never install the same path: dpkg refuses the second one and the whole image build
# fails (worksuite-mimeapps.list was shipped by both worksuite-shell and worksuite-session once). Reads every
# debian/*.install file: "source... destination-dir/".
set -u
ROOT=$(cd "$(dirname "$0")/../.." && pwd)
D=$ROOT/packaging/debian
T=$(mktemp); trap 'rm -f "$T"' EXIT
for f in "$D"/*.install; do
  pkg=$(basename "$f" .install)
  grep -v '^[[:space:]]*#' "$f" | grep . | while read -r line; do
    set -- $line; [ $# -ge 2 ] || continue
    eval dest=\${$#}; n=$(($# - 1)); i=1
    for src in "$@"; do [ $i -le $n ] || break; i=$((i + 1))
      for s in $ROOT/$src; do echo "${dest%/}/$(basename "$s") $pkg"; done
    done
  done
done | sort > "$T"
dups=$(awk '{print $1}' "$T" | uniq -d)
if [ -z "$dups" ]; then echo "ok 1 - no path is installed by two packages"; else
  echo "not ok 1 - installed by more than one package:"; for d in $dups; do grep "^$d " "$T" | sed 's/^/#   /'; done; exit 1; fi
echo 1..1

#!/bin/sh
# Check WORKSUITE_PERF lines (serial log of tests/vm/boot-test.sh, or measure-* output) against tests/perf/gates.tsv.
#   tests/perf/gates.sh LOG PROFILE          e.g. tests/perf/gates.sh serial.log ci-amd64-tcg
# Prints one line per gate and exits 1 when any gate fails (or a required metric is missing).
set -eu
log=${1:?log}; profile=${2:?profile}
gates=${GATES:-$(dirname "$0")/gates.tsv}
grep -q "^$profile[[:space:]]" "$gates" || { echo "unknown profile $profile" >&2; exit 2; }
tr -d '\r' < "$log" | grep -ao 'WORKSUITE_PERF [a-z0-9_]* [0-9.]*' | awk -v profile="$profile" '
  FILENAME == "-" { v[$2] = $3; next }
  /^#/ || NF < 5 || $1 != profile { next }
  {
    m = $2; op = $3; lim = $4 + 0; need = $5; req = $6; for (i = 7; i <= NF; i++) req = req " " $i
    if (!(m in v)) {
      if (need == "required") { printf "FAIL %-30s missing (%s)\n", m, req; bad++ } else printf "SKIP %-30s not reported (%s)\n", m, req
      next
    }
    x = v[m] + 0
    ok = (op == "<=" && x <= lim) || (op == "<" && x < lim) || (op == "==" && x == lim) || (op == ">=" && x >= lim)
    printf "%s %-30s %s %s %s (%s)\n", ok ? "PASS" : "FAIL", m, v[m], op, $4, req
    if (!ok) bad++
  }
  END { exit (bad > 0 ? 1 : 0) }
' - "$gates"

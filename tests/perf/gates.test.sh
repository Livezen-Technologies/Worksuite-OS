#!/bin/sh
# Tests for the perf gate evaluator and the guest boot probe's parsing (stub systemd-analyze/systemctl).
set -eu
here=$(cd "$(dirname "$0")" && pwd)
t=$(mktemp -d); trap 'rm -rf "$t"' EXIT
fail=0
check() { if eval "$2"; then echo "ok - $1"; else echo "not ok - $1"; fail=1; fi; }

cat > "$t/good.log" <<'EOF'
[   12.3] systemd[1]: Started greetd.
WORKSUITE_BOOT_OK Debian GNU/Linux 13 (trixie)
WORKSUITE_PERF boot_to_greeter_s 212.40
WORKSUITE_PERF idle_mem_mib 980
WORKSUITE_PERF idle_cpu_pct 6.10
WORKSUITE_PERF login_cycles_failed 0
WORKSUITE_PERF login_sessions_leaked 0
WORKSUITE_PERF login_failed_units_new 0
EOF
check "good CI log passes" '"$here/gates.sh" "$t/good.log" ci-amd64-tcg > "$t/out"'
check "optional metrics are skipped, not failed" 'grep -q "^SKIP shell_ready_ms" "$t/out"'
sed 's/idle_mem_mib 980/idle_mem_mib 1600/' "$t/good.log" > "$t/mem.log"
check "memory over 1.5 GiB fails" '! "$here/gates.sh" "$t/mem.log" ci-amd64-tcg > "$t/out" && grep -q "^FAIL idle_mem_mib" "$t/out"'
grep -v boot_to_greeter "$t/good.log" > "$t/miss.log"
check "missing required metric fails" '! "$here/gates.sh" "$t/miss.log" ci-amd64-tcg > "$t/out" && grep -q "^FAIL boot_to_greeter_s *missing" "$t/out"'
check "same log fails the hardware gate (30 s)" '! "$here/gates.sh" "$t/good.log" hw-amd64 >/dev/null'
check "ARM has its own profile" '"$here/gates.sh" "$t/good.log" ci-arm64-tcg >/dev/null'
check "unknown profile is an error" '! "$here/gates.sh" "$t/good.log" nope 2>/dev/null'
printf 'WORKSUITE_PERF idle_cpu_pct 2\r\n' > "$t/cr.log"
check "strict < at the limit fails; CRLF tolerated" '! GATES="$t/g.tsv" sh -c "printf \"p idle_cpu_pct < 2 required X\n\" > \"$t/g.tsv\"; \"$here/gates.sh\" \"$t/cr.log\" p" >/dev/null'

# measure-boot parsing with stubs; no idle wait.
mkdir -p "$t/bin"
printf '#!/bin/sh\necho "Startup finished in 1min 2.500s (firmware) + 850ms (loader) + 3.2s (kernel) + 9.8s (userspace) = 1min 16.350s"\necho "graphical.target reached after 9.7s in userspace."\n' > "$t/bin/systemd-analyze"
printf '#!/bin/sh\necho 12500000\n' > "$t/bin/systemctl"
chmod +x "$t/bin/systemd-analyze" "$t/bin/systemctl"
PATH="$t/bin:$PATH" IDLE_SETTLE=0 IDLE_WINDOW=1 sh "$here/guest/measure-boot" > "$t/mb"
# firmware 62.5 + loader 0.85 + greetd at 12.5 s monotonic = 75.85
check "boot_to_greeter_s = firmware + loader + greetd monotonic" 'grep -q "^WORKSUITE_PERF boot_to_greeter_s 75.85$" "$t/mb"'
check "userspace_s parsed" 'grep -q "^WORKSUITE_PERF userspace_s 9.80$" "$t/mb"'
check "idle metrics reported" 'grep -q "^WORKSUITE_PERF idle_mem_mib [0-9][0-9]*$" "$t/mb" && grep -q "^WORKSUITE_PERF idle_cpu_pct [0-9][0-9.]*$" "$t/mb"'
check "probe output feeds the gate" '"$here/gates.sh" "$t/mb" ci-amd64-tcg | grep -q "^PASS boot_to_greeter_s"'
exit $fail

#!/bin/sh
# Boot a WorkSuite OS ISO in QEMU with UEFI (OVMF on amd64, AAVMF on arm64) and wait for the boot marker on the
# serial console.
#   tests/vm/boot-test.sh live-build/out/worksuite-os-1.0.0-dev-amd64.iso [timeout-seconds]
# ARCH=amd64|arm64 overrides the architecture taken from the ISO name. BOOT_LOG=path keeps the serial log.
# No network device (-nic none): the image must come up with every remote service unreachable (WSOS-ARC-004).
# Pass criteria: WORKSUITE_BOOT_OK printed, greetd active, worksuite-node runs, no failed units.
# PERF_PROFILE=ci-amd64-tcg (a profile in tests/perf/gates.tsv) also waits for the perf probes of a
# WORKSUITE_PERF=1 image (WORKSUITE_PERF_DONE) and applies those gates (WSOS-PRF-*, REL-001/002, ARM-007).
set -eu
iso=${1:?iso}; timeout=${2:-900}
here=$(cd "$(dirname "$0")" && pwd)
. "$here/qemu-arch.sh" "$iso"
log=${BOOT_LOG:-$(mktemp)}; vars=$(mktemp)
cp "$FW_VARS_TEMPLATE" "$vars"
# shellcheck disable=SC2046,SC2086
$QEMU $MACHINE -m 4096 -smp 2 \
  -drive if=pflash,format=raw,readonly=on,file="$FW_CODE" -drive if=pflash,format=raw,file="$vars" \
  $(cdrom_args "$iso") -nic none -display none -serial file:"$log" -no-reboot &
qemu=$!
trap 'kill $qemu 2>/dev/null || true; rm -f "$vars"' EXIT
end=$(( $(date +%s) + timeout ))
booted=0
while [ "$(date +%s)" -lt "$end" ]; do
  if [ $booted = 0 ] && grep -aq 'WORKSUITE_BOOT_OK' "$log"; then
    booted=1
    grep -ao 'WORKSUITE_[A-Z]* .*' "$log" | grep -v '^WORKSUITE_PERF' | tr -d '\r'
    fail=0
    grep -aq 'WORKSUITE_UNIT greetd active' "$log" || { echo "FAIL: greetd not active"; fail=1; }
    grep -aqE 'WORKSUITE_NODE 22\.' "$log" || { echo "FAIL: worksuite-node did not run"; fail=1; }
    grep -aq 'WORKSUITE_FAILED none' "$log" || { echo "FAIL: failed units"; fail=1; }
    [ $fail = 0 ] || exit 1
    echo "PASS boot ($ARCH, $ACCEL)"
    [ -n "${PERF_PROFILE:-}" ] || exit 0
  fi
  if [ $booted = 1 ] && grep -aq 'WORKSUITE_PERF_DONE' "$log"; then
    grep -ao 'WORKSUITE_PERF[A-Z_]* .*' "$log" | tr -d '\r'
    "$here/../perf/gates.sh" "$log" "$PERF_PROFILE" && { echo "PASS perf gates ($PERF_PROFILE)"; exit 0; }
    exit 1
  fi
  kill -0 $qemu 2>/dev/null || break
  sleep 5
done
if [ $booted = 1 ]; then echo "FAIL: perf probes did not finish within ${timeout}s"; else echo "FAIL: no boot marker within ${timeout}s ($ARCH, $ACCEL)"; fi
echo "Last console lines:"; tail -n 40 "$log"; exit 1

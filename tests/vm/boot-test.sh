#!/bin/sh
# Boot a WorkSuite OS ISO in QEMU with UEFI (OVMF) and wait for the boot marker on the serial console.
#   tests/vm/boot-test.sh live-build/out/worksuite-os-1.0.0-dev-amd64.iso [timeout-seconds]
# Pass criteria: WORKSUITE_BOOT_OK printed, greetd active, worksuite-node runs, no failed units.
set -eu
iso=${1:?iso}; timeout=${2:-900}
log=$(mktemp); vars=$(mktemp)
code=/usr/share/OVMF/OVMF_CODE_4M.fd; [ -f "$code" ] || code=/usr/share/OVMF/OVMF_CODE.fd
cp "$(dirname "$code")/$(basename "$code" | sed 's/CODE/VARS/')" "$vars"
accel=tcg; [ -w /dev/kvm ] && accel=kvm
qemu-system-x86_64 -machine q35,accel=$accel -m 4096 -smp 2 \
  -drive if=pflash,format=raw,readonly=on,file="$code" -drive if=pflash,format=raw,file="$vars" \
  -cdrom "$iso" -boot d -display none -serial file:"$log" -no-reboot &
qemu=$!
trap 'kill $qemu 2>/dev/null || true; rm -f "$vars"' EXIT
end=$(( $(date +%s) + timeout ))
while [ "$(date +%s)" -lt "$end" ]; do
  if grep -q '^WORKSUITE_BOOT_OK' "$log"; then
    grep '^WORKSUITE_' "$log"
    fail=0
    grep -q '^WORKSUITE_UNIT greetd active' "$log" || { echo "FAIL: greetd not active"; fail=1; }
    grep -qE '^WORKSUITE_NODE 22\.' "$log" || { echo "FAIL: worksuite-node did not run"; fail=1; }
    grep -q '^WORKSUITE_FAILED none' "$log" || { echo "FAIL: failed units"; fail=1; }
    [ $fail = 0 ] && echo "PASS ($accel)"; exit $fail
  fi
  kill -0 $qemu 2>/dev/null || break
  sleep 5
done
echo "FAIL: no boot marker within ${timeout}s ($accel). Last console lines:"; tail -n 40 "$log"; exit 1

#!/bin/sh
# Run the hardware gates (tests/hw/gates.tsv) on the machine under test, as root, from an installed WorkSuite OS.
# Prints one "gate result detail" line per gate; the operator copies the results into tests/hw/certified.tsv and keeps
# the output as evidence. SYSFS=dir and SKIP_SUSPEND=1 are for testing this script.
set -u
sys=${SYSFS:-/sys}
say() { printf '%s\t%s\t%s\n' "$1" "$2" "$3"; }

if [ -d "$sys/firmware/efi" ]; then say uefi pass "efi firmware"; else say uefi fail "not booted through UEFI"; fi

gpu=fail; gdetail="no DRM card with a hardware driver"
for c in "$sys"/class/drm/card[0-9]*; do
  case $(basename "$c") in *-*) continue ;; esac
  d=$(basename "$(readlink "$c/device/driver" 2>/dev/null)" 2>/dev/null)
  case $d in ''|simpledrm|simple-framebuffer|efifb) ;; *) gpu=pass; gdetail="driver $d" ;; esac
done
say gpu $gpu "$gdetail"

wifi=fail; wdetail="no wireless interface"
for n in "$sys"/class/net/*; do
  [ -d "$n/wireless" ] || [ -e "$n/phy80211" ] || continue
  i=$(basename "$n")
  if [ -n "${SYSFS:-}" ]; then wifi=pass; wdetail="$i (scan not run under SYSFS)"; break; fi
  if command -v nmcli >/dev/null && [ "$(nmcli -t -f SSID device wifi list ifname "$i" --rescan yes 2>/dev/null | grep -c .)" -gt 0 ]; then wifi=pass; wdetail="$i scans"; else wdetail="$i found but no scan results"; fi
done
say wifi $wifi "$wdetail"

if [ "${SKIP_SUSPEND:-0}" = 1 ]; then say suspend skip "SKIP_SUSPEND=1"
else
  before=$(cat "$sys/power/suspend_stats/fail" 2>/dev/null || echo x); ok=0
  for _ in 1 2 3; do rtcwake -m mem -s 20 >/dev/null 2>&1 && ok=$((ok + 1)); sleep 5; done
  after=$(cat "$sys/power/suspend_stats/fail" 2>/dev/null || echo y)
  if [ $ok = 3 ] && [ "$before" = "$after" ]; then say suspend pass "3/3 cycles"; else say suspend fail "$ok/3 cycles, fail count $before -> $after"; fi
fi

if [ -z "${SYSFS:-}" ] && command -v wpctl >/dev/null && wpctl status 2>/dev/null | sed -n '/Sinks:/,/Sources:/p' | grep -q '[0-9]\.'; then say audio pass "PipeWire sink"
else say audio fail "no PipeWire output sink"; fi

st=fail; sdetail="no internal disk"
for b in "$sys"/block/*; do
  n=$(basename "$b"); case $n in loop*|ram*|zram*|dm-*|sr*|md*) continue ;; esac
  [ "$(cat "$b/removable" 2>/dev/null)" = 0 ] && [ "$(cat "$b/size" 2>/dev/null || echo 0)" -gt 0 ] && { st=pass; sdetail=$n; break; }
done
say storage $st "$sdetail"

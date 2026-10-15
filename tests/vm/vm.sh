#!/bin/sh
# Drive a QEMU VM by hand or from a script: boot, screenshot, keys. One VM per DIR. amd64 or arm64 (UEFI both),
# chosen by ARCH or the ISO name (tests/vm/qemu-arch.sh).
#   tests/vm/vm.sh start DIR ISO [disk-size]   UEFI, 4 GiB RAM, virtio disk DIR/disk.qcow2 (/dev/vda), ISO first
#   tests/vm/vm.sh boot-disk DIR               same VM without the ISO (after an install)
#   tests/vm/vm.sh shot DIR NAME               DIR/NAME.png
#   tests/vm/vm.sh keys DIR KEY...             QEMU key names: tab ret spc esc up down shift-tab ctrl-a …
#   tests/vm/vm.sh click DIR X Y              left click at screen pixel X,Y (virtio tablet, absolute)
#   tests/vm/vm.sh type DIR TEXT               types [A-Za-z0-9 .@_=/-] and most shell punctuation
#   tests/vm/vm.sh console DIR LINE         send LINE to the serial console (log in as user/live on the live ISO)
#   tests/vm/vm.sh stop DIR
set -eu
cmd=${1:?}; dir=${2:?}
mon() { printf '%s\n' "$1" | socat - "UNIX-CONNECT:$dir/monitor.sock" >/dev/null; }
here=$(cd "$(dirname "$0")" && pwd)
# amd64 or arm64 (WSOS-ARM-008): from ARCH, else the ISO name, else what this VM was started as, else the host.
run() {
  [ -z "${ARCH:-}" ] && [ -f "$dir/arch" ] && ARCH=$(cat "$dir/arch")
  . "$here/qemu-arch.sh" "${iso:-}"
  echo "$ARCH" > "$dir/arch"
  [ -f "$dir/vars.fd" ] || cp "$FW_VARS_TEMPLATE" "$dir/vars.fd"
  extra="-vga virtio"; [ "$ARCH" = amd64 ] && extra="-cpu Nehalem -vga virtio"; [ "$ARCH" = arm64 ] && extra=""
  # shellcheck disable=SC2086
  $QEMU $MACHINE -m 4096 -smp 4 $extra \
    -drive if=pflash,format=raw,readonly=on,file="$FW_CODE" -drive if=pflash,format=raw,file="$dir/vars.fd" \
    -drive if=virtio,format=qcow2,file="$dir/disk.qcow2" "$@" \
    -display none -monitor "unix:$dir/monitor.sock,server,nowait" -qmp "unix:$dir/qmp.sock,server=on,wait=off" -chardev "socket,id=s0,path=$dir/serial.sock,server=on,wait=off,logfile=$dir/serial.log" -serial chardev:s0 \
    -device virtio-tablet-pci -device virtio-keyboard-pci -nic user,model=virtio-net-pci -daemonize -pidfile "$dir/qemu.pid"
}
# amd64 boots the CD first with -boot; arm64 uses bootindex on the scsi-cd (qemu-arch.sh).
cdrom_args_for() { if [ "$ARCH" = arm64 ]; then echo "-device virtio-scsi-pci,id=scsi0 -drive if=none,id=cd0,media=cdrom,readonly=on,format=raw,file=$1 -device scsi-cd,drive=cd0,bootindex=0"; else echo "-cdrom $1 -boot order=dc"; fi; }
case "$cmd" in
start) mkdir -p "$dir"; [ -f "$dir/disk.qcow2" ] || qemu-img create -f qcow2 "$dir/disk.qcow2" "${4:-40G}" >/dev/null
       iso=${3:?iso}; [ -n "${ARCH:-}" ] || case "$iso" in *-arm64*.iso) ARCH=arm64 ;; *-amd64*.iso) ARCH=amd64 ;; *) case "$(uname -m)" in aarch64|arm64) ARCH=arm64 ;; *) ARCH=amd64 ;; esac ;; esac
       # shellcheck disable=SC2046
       run $(cdrom_args_for "$iso") ;;
boot-disk) run ;;
shot) p="$dir/${3:?name}.ppm"; rm -f "$p"; mon "screendump $p"
      # QEMU writes the PPM asynchronously: wait until it exists and its size stops changing.
      n=0; last=-1; while [ $n -lt 50 ]; do s=$(stat -c %s "$p" 2>/dev/null || echo 0)
        [ "$s" -gt 0 ] && [ "$s" = "$last" ] && break; last=$s; n=$((n+1)); sleep 0.2; done
      convert "$p" "$dir/$3.png" 2>/dev/null || pnmtopng "$p" > "$dir/$3.png" 2>/dev/null \
        || python3 -c 'import sys; from PIL import Image; Image.open(sys.argv[1]).save(sys.argv[2])' "$p" "$dir/$3.png"
      rm -f "$p"; echo "$dir/$3.png" ;;
click) # Absolute position on the virtio tablet through QMP. The monitor's mouse_move is relative and goes to the
       # PS/2 mouse, whose accelerated motion parks the pointer in a screen corner (clicks miss, the cursor vanishes).
       x=${3:?x}; y=${4:?y}; W=${VM_W:-1280}; H=${VM_H:-800}
       ax=$((x * 32767 / (W - 1))); ay=$((y * 32767 / (H - 1)))
       ev() { printf '{"execute":"qmp_capabilities"}\n{"execute":"input-send-event","arguments":{"events":[%s]}}\n' "$1" \
                | socat -t 1 - "UNIX-CONNECT:$dir/qmp.sock" >/dev/null; }
       ev "{\"type\":\"abs\",\"data\":{\"axis\":\"x\",\"value\":$ax}},{\"type\":\"abs\",\"data\":{\"axis\":\"y\",\"value\":$ay}}"
       sleep 0.3; ev '{"type":"btn","data":{"down":true,"button":"left"}}'
       sleep 0.15; ev '{"type":"btn","data":{"down":false,"button":"left"}}' ;;
keys) shift 2; for k in "$@"; do mon "sendkey $k"; sleep 0.3; done ;;
type) t=${3:?text}; i=0
      while [ $i -lt ${#t} ]; do c=$(printf %s "$t" | cut -c$((i+1))); i=$((i+1))
        case "$c" in
          [a-z0-9]) k=$c ;; [A-Z]) k="shift-$(printf %s "$c" | tr A-Z a-z)" ;; ' ') k=spc ;; .) k=dot ;; @) k=shift-2 ;; _) k=shift-minus ;; -) k=minus ;; =) k=equal ;; /) k=slash ;; ,) k=comma ;; ';') k=semicolon ;; '|') k=shift-backslash ;; '>') k=shift-dot ;; '<') k=shift-comma ;; :) k=shift-semicolon ;; '(') k=shift-9 ;; ')') k=shift-0 ;; '"') k=shift-apostrophe ;; "'") k=apostrophe ;;
          '&') k=shift-7 ;; '!') k=shift-1 ;; '$') k=shift-4 ;; '*') k=shift-8 ;; '#') k=shift-3 ;; '+') k=shift-equal ;; '%') k=shift-5 ;;
          '?') k=shift-slash ;; '[') k=bracket_left ;; ']') k=bracket_right ;; '{') k=shift-bracket_left ;; '}') k=shift-bracket_right ;; '~') k=shift-grave_accent ;; '\\') k=backslash ;;
          *) echo "cannot type '$c'" >&2; exit 2 ;;
        esac; mon "sendkey $k"; sleep 0.15; done ;;
console) printf '%s\r' "${3:?line}" | socat -t 2 - "UNIX-CONNECT:$dir/serial.sock" >/dev/null ;;
stop) [ -f "$dir/qemu.pid" ] && kill "$(cat "$dir/qemu.pid")" 2>/dev/null || true ;;
*) echo "unknown command $cmd" >&2; exit 2 ;;
esac

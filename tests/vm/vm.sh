#!/bin/sh
# Drive a QEMU VM by hand or from a script: boot, screenshot, keys. One VM per DIR.
#   tests/vm/vm.sh start DIR ISO [disk-size]   UEFI, 4 GiB RAM, virtio disk DIR/disk.qcow2 (/dev/vda), ISO first
#   tests/vm/vm.sh boot-disk DIR               same VM without the ISO (after an install)
#   tests/vm/vm.sh shot DIR NAME               DIR/NAME.png
#   tests/vm/vm.sh keys DIR KEY...             QEMU key names: tab ret spc esc up down shift-tab ctrl-a …
#   tests/vm/vm.sh click DIR X Y              left click at screen pixel X,Y (virtio tablet, absolute)
#   tests/vm/vm.sh type DIR TEXT               types [A-Za-z0-9 .@_=/-]
#   tests/vm/vm.sh console DIR LINE         send LINE to the serial console (log in as user/live on the live ISO)
#   tests/vm/vm.sh stop DIR
set -eu
cmd=${1:?}; dir=${2:?}
mon() { printf '%s\n' "$1" | socat - "UNIX-CONNECT:$dir/monitor.sock" >/dev/null; }
run() {
  code=/usr/share/OVMF/OVMF_CODE_4M.fd; [ -f "$code" ] || code=/usr/share/OVMF/OVMF_CODE.fd
  [ -f "$dir/vars.fd" ] || cp "$(dirname "$code")/$(basename "$code" | sed 's/CODE/VARS/')" "$dir/vars.fd"
  accel=tcg; [ -w /dev/kvm ] && accel=kvm
  qemu-system-x86_64 -machine q35,accel=$accel -m 4096 -smp 4 -cpu max \
    -drive if=pflash,format=raw,readonly=on,file="$code" -drive if=pflash,format=raw,file="$dir/vars.fd" \
    -drive if=virtio,format=qcow2,file="$dir/disk.qcow2" "$@" \
    -vga virtio -display none -monitor "unix:$dir/monitor.sock,server,nowait" -chardev "socket,id=s0,path=$dir/serial.sock,server=on,wait=off,logfile=$dir/serial.log" -serial chardev:s0 \
    -device virtio-tablet-pci -device virtio-keyboard-pci -nic user,model=virtio-net-pci -daemonize -pidfile "$dir/qemu.pid"
}
case "$cmd" in
start) mkdir -p "$dir"; [ -f "$dir/disk.qcow2" ] || qemu-img create -f qcow2 "$dir/disk.qcow2" "${4:-40G}" >/dev/null
       run -cdrom "${3:?iso}" -boot order=dc ;;
boot-disk) run ;;
shot) mon "screendump $dir/${3:?name}.ppm"; sleep 1; convert "$dir/$3.ppm" "$dir/$3.png" 2>/dev/null || pnmtopng "$dir/$3.ppm" > "$dir/$3.png"; rm -f "$dir/$3.ppm"; echo "$dir/$3.png" ;;
click) mon "mouse_move ${3:?x} ${4:?y}"; sleep 0.3; mon 'mouse_button 1'; sleep 0.15; mon 'mouse_button 0' ;;
keys) shift 2; for k in "$@"; do mon "sendkey $k"; sleep 0.3; done ;;
type) t=${3:?text}; i=0
      while [ $i -lt ${#t} ]; do c=$(printf %s "$t" | cut -c$((i+1))); i=$((i+1))
        case "$c" in
          [a-z0-9]) k=$c ;; [A-Z]) k="shift-$(printf %s "$c" | tr A-Z a-z)" ;; ' ') k=spc ;; .) k=dot ;; @) k=shift-2 ;; _) k=shift-minus ;; -) k=minus ;; =) k=equal ;; /) k=slash ;; ,) k=comma ;; ';') k=semicolon ;; '|') k=shift-backslash ;; '>') k=shift-dot ;; '<') k=shift-comma ;;
          *) echo "cannot type '$c'" >&2; exit 2 ;;
        esac; mon "sendkey $k"; sleep 0.15; done ;;
console) printf '%s\r' "${3:?line}" | socat -t 2 - "UNIX-CONNECT:$dir/serial.sock" >/dev/null ;;
stop) [ -f "$dir/qemu.pid" ] && kill "$(cat "$dir/qemu.pid")" 2>/dev/null || true ;;
*) echo "unknown command $cmd" >&2; exit 2 ;;
esac

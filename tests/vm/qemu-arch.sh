# Sourced by the VM scripts: QEMU binary, machine, UEFI firmware and CD-ROM arguments per architecture
# (WSOS-ARM-002/008: ARM boots via UEFI only). Input: ARCH (amd64|arm64; default from the ISO name in $1, else the
# host). Output variables: QEMU, MACHINE (args), FW_CODE, FW_VARS_TEMPLATE, ACCEL, and the function cdrom_args ISO.
# shellcheck shell=sh
qemu_arch_detect() {
  case "${1:-}" in *-arm64*.iso) echo arm64; return ;; *-amd64*.iso) echo amd64; return ;; esac
  case "$(uname -m)" in aarch64|arm64) echo arm64 ;; *) echo amd64 ;; esac
}
ARCH=${ARCH:-$(qemu_arch_detect "${1:-}")}
host=$(uname -m)
ACCEL=tcg
case "$ARCH" in
amd64)
  QEMU=qemu-system-x86_64
  [ "$host" = x86_64 ] && [ -w /dev/kvm ] && ACCEL=kvm
  MACHINE="-machine q35,accel=$ACCEL"
  FW_CODE=/usr/share/OVMF/OVMF_CODE_4M.fd; [ -f "$FW_CODE" ] || FW_CODE=/usr/share/OVMF/OVMF_CODE.fd
  FW_VARS_TEMPLATE=$(dirname "$FW_CODE")/$(basename "$FW_CODE" | sed 's/CODE/VARS/')
  cdrom_args() { echo "-cdrom $1 -boot d"; }
  ;;
arm64)
  QEMU=qemu-system-aarch64
  [ "$host" = aarch64 ] && [ -w /dev/kvm ] && ACCEL=kvm
  # cortex-a72 under TCG (max is slower to emulate); host CPU under KVM. virtio-gpu gives the greeter a DRM device.
  cpu=cortex-a72; [ "$ACCEL" = kvm ] && cpu=host
  MACHINE="-machine virt,accel=$ACCEL -cpu $cpu -device virtio-gpu-pci -device qemu-xhci -device usb-kbd -device usb-tablet"
  # AAVMF (Debian qemu-efi-aarch64): 64 MiB pflash images.
  FW_CODE=/usr/share/AAVMF/AAVMF_CODE.fd
  FW_VARS_TEMPLATE=/usr/share/AAVMF/AAVMF_VARS.fd
  cdrom_args() { echo "-device virtio-scsi-pci,id=scsi0 -drive if=none,id=cd0,media=cdrom,readonly=on,format=raw,file=$1 -device scsi-cd,drive=cd0,bootindex=0"; }
  ;;
*) echo "unsupported ARCH=$ARCH" >&2; exit 2 ;;
esac
command -v "$QEMU" >/dev/null || { echo "$QEMU missing (amd64: qemu-system-x86 ovmf; arm64: qemu-system-arm qemu-efi-aarch64)" >&2; exit 2; }
[ -f "$FW_CODE" ] || { echo "UEFI firmware $FW_CODE missing" >&2; exit 2; }

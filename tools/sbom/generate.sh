#!/bin/sh
# Release SBOM (WSOS-SEC-011): SPDX 2.3 JSON for one architecture's ISO, next to it in live-build/out/.
#   tools/sbom/generate.sh amd64
# Inputs: live-build/out/worksuite-os-*-$ARCH.packages (image package list from lb), packaging/out/*.deb,
# the shell and service npm lockfiles. When syft is installed it also writes a filesystem-level SPDX of the ISO.
set -eu
arch=${1:?arch}
root=$(cd "$(dirname "$0")/../.." && pwd)
out="$root/live-build/out"
list=$(ls "$out"/worksuite-os-*-"$arch".packages 2>/dev/null | head -n1)
[ -n "$list" ] || { echo "no $out/worksuite-os-*-$arch.packages; build the ISO first" >&2; exit 1; }
base=$(basename "$list" .packages)
set --
for d in "$root"/packaging/out/*_all.deb "$root"/packaging/out/*_"$arch".deb; do [ -f "$d" ] && set -- "$@" "$d"; done
node "$root/tools/sbom/spdx.mjs" --name "$base" --arch "$arch" --packages "$list" \
  --npm "$root/shell/package-lock.json" --npm "$root/services/package-service/package-lock.json" \
  ${1:+--deb "$@"} > "$out/$base.spdx.json"
echo "wrote $out/$base.spdx.json ($(grep -c '"SPDXID": "SPDXRef-deb\|"SPDXID": "SPDXRef-npm' "$out/$base.spdx.json") packages)"
if command -v syft >/dev/null; then
  iso="$out/$base.iso"
  [ -f "$iso" ] && syft scan "file:$iso" -o "spdx-json=$out/$base.syft.spdx.json" -q && echo "wrote $out/$base.syft.spdx.json"
fi

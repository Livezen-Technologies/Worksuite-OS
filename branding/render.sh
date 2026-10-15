#!/bin/sh
# Renders the branding SVGs to the PNGs Plymouth and GRUB need. Usage: render.sh <outdir>
set -eu
here=$(dirname "$0"); out=$1
mkdir -p "$out/plymouth" "$out/grub" "$out/icons"
rsvg-convert -w 120 -h 152 "$here/logo-dark.svg" -o "$out/plymouth/logo.png"
for f in ring-track ring-arc; do rsvg-convert -w 120 -h 120 "$here/plymouth/$f.svg" -o "$out/plymouth/$f.png"; done
rsvg-convert -w 48 -h 48 "$here/plymouth/mark.svg" -o "$out/plymouth/mark.png"
rsvg-convert "$here/plymouth/progress-track.svg" -o "$out/plymouth/progress-track.png"
rsvg-convert "$here/plymouth/progress-bar.svg" -o "$out/plymouth/progress-bar.png"
sh "$here/grub/render.sh" "$out/grub"                  # G13 boot menu: artwork, row icons, selection pill, IBM Plex fonts
for s in 16 24 32 48 64 128 256 512; do
  rsvg-convert -w $s -h $s "$here/icons/worksuite.svg" -o "$out/icons/worksuite-$s.png"
done
rsvg-convert -w 3840 -h 2160 "$here/wallpaper.svg" -o "$out/wallpaper.png"

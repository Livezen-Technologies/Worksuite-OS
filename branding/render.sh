#!/bin/sh
# Renders the branding SVGs to the PNGs Plymouth and GRUB need. Usage: render.sh <outdir>
set -eu
here=$(dirname "$0"); out=$1
mkdir -p "$out/plymouth" "$out/grub" "$out/icons"
rsvg-convert -w 120 -h 152 "$here/logo-dark.svg" -o "$out/plymouth/logo.png"
rsvg-convert "$here/plymouth/progress-track.svg" -o "$out/plymouth/progress-track.png"
rsvg-convert "$here/plymouth/progress-bar.svg" -o "$out/plymouth/progress-bar.png"
rsvg-convert -w 80 -h 101 "$here/logo-dark.svg" -o "$out/grub/logo.png"
python3 "$here/grub/make-pixmaps.py" "$out/grub"      # rounded 9-slice pieces: menu selection, countdown bar
for f in "DejaVuSans 6" "DejaVuSans 14" "DejaVuSans 16" "DejaVuSans-Bold 16"; do set -- $f    # smooth menu fonts (GRUB loads every .pf2 in the theme)
  grub-mkfont -s "$2" -o "$out/grub/$(echo "$1" | tr A-Z a-z)-$2.pf2" "/usr/share/fonts/truetype/dejavu/$1.ttf"
done
for s in 16 24 32 48 64 128 256 512; do
  rsvg-convert -w $s -h $s "$here/icons/worksuite.svg" -o "$out/icons/worksuite-$s.png"
done
rsvg-convert -w 3840 -h 2160 "$here/wallpaper.svg" -o "$out/wallpaper.png"

#!/bin/sh
# Renders the branding SVGs to the PNGs Plymouth and GRUB need. Usage: render.sh <outdir>
set -eu
here=$(dirname "$0"); out=$1
mkdir -p "$out/plymouth" "$out/grub" "$out/icons"
rsvg-convert -w 120 -h 152 "$here/logo-dark.svg" -o "$out/plymouth/logo.png"
# Each splash asset at 1x and @2x (HiDPI heads, worksuite.script picks one device scale for every head).
for k in 1 2; do
  sfx=; [ $k = 2 ] && sfx=@2x
  for f in ring-track ring-arc; do rsvg-convert -w $((120*k)) -h $((120*k)) "$here/plymouth/$f.svg" -o "$out/plymouth/$f$sfx.png"; done
  rsvg-convert -w $((48*k)) -h $((48*k)) "$here/plymouth/mark.svg" -o "$out/plymouth/mark$sfx.png"
  rsvg-convert -w $((420*k)) -h $((4*k)) "$here/plymouth/progress-track.svg" -o "$out/plymouth/progress-track$sfx.png"
  rsvg-convert -w $((420*k)) -h $((4*k)) "$here/plymouth/progress-bar.svg" -o "$out/plymouth/progress-bar$sfx.png"
  rsvg-convert -w $((96*k)) -h $((4*k)) "$here/plymouth/progress-shimmer.svg" -o "$out/plymouth/progress-shimmer$sfx.png"   # light sweep over the fill
  rsvg-convert -w $((420*k)) -h $((44*k)) "$here/plymouth/field.svg" -o "$out/plymouth/field$sfx.png"   # disk-unlock passphrase field
done
sh "$here/grub/render.sh" "$out/grub"                  # G13 boot menu: artwork, row icons, selection pill, IBM Plex fonts
for s in 16 24 32 48 64 128 256 512; do
  rsvg-convert -w $s -h $s "$here/icons/worksuite.svg" -o "$out/icons/worksuite-$s.png"
done
rsvg-convert -w 3840 -h 2160 "$here/wallpaper.svg" -o "$out/wallpaper.png"

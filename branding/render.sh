#!/bin/sh
# Renders the branding SVGs to the PNGs Plymouth and GRUB need. Usage: render.sh <outdir>
set -eu
here=$(dirname "$0"); out=$1
mkdir -p "$out/plymouth" "$out/grub" "$out/icons"
rsvg-convert -w 120 -h 120 "$here/logo-dark.svg" -o "$out/plymouth/logo.png"
# Each splash asset at 1x and @2x (HiDPI heads, worksuite.script picks one device scale for every head).
for k in 1 2; do
  sfx=; [ $k = 2 ] && sfx=@2x
  # Loader cells (worksuite.script, "assemble"): cyan and navy are 32 of the loader's 128 units, blue 64, drawn 120 px.
  for f in cyan navy; do rsvg-convert -w $((30*k)) -h $((30*k)) "$here/plymouth/cell-$f.svg" -o "$out/plymouth/cell-$f$sfx.png"; done
  rsvg-convert -w $((60*k)) -h $((60*k)) "$here/plymouth/cell-blue.svg" -o "$out/plymouth/cell-blue$sfx.png"
  rsvg-convert -w $((420*k)) -h $((4*k)) "$here/plymouth/progress-track.svg" -o "$out/plymouth/progress-track$sfx.png"
  rsvg-convert -w $((420*k)) -h $((4*k)) "$here/plymouth/progress-bar.svg" -o "$out/plymouth/progress-bar$sfx.png"
  rsvg-convert -w $((96*k)) -h $((4*k)) "$here/plymouth/progress-shimmer.svg" -o "$out/plymouth/progress-shimmer$sfx.png"   # light sweep over the fill
  rsvg-convert -w $((420*k)) -h $((44*k)) "$here/plymouth/field.svg" -o "$out/plymouth/field$sfx.png"   # disk-unlock passphrase field
done
# Vendor logos (Debian's vendor-logos alternative: GDM's sign-in logo and the places Debian shows its own): the
# worksuite wordmark with its "OS" tag, pre-made from the supplied artwork (vendor-logos/source/README.md) at the
# sizes Debian ships, and the mark as a vector rendered at the same sizes.
mkdir -p "$out/vendor-logos"
cp "$here"/vendor-logos/logo-text*.png "$here"/vendor-logos/logo-text*.svg "$here/vendor-logos/logo.svg" "$out/vendor-logos/"
for h in 64 128 256; do rsvg-convert -w $h -h $h "$here/vendor-logos/logo.svg" -o "$out/vendor-logos/logo-$h.png"; done
sh "$here/grub/render.sh" "$out/grub"                  # G13 boot menu: artwork, row icons, selection pill, IBM Plex fonts
for s in 16 24 32 48 64 128 256 512; do
  rsvg-convert -w $s -h $s "$here/icons/worksuite.svg" -o "$out/icons/worksuite-$s.png"
done
rsvg-convert -w 3840 -h 2160 "$here/wallpaper.svg" -o "$out/wallpaper.png"

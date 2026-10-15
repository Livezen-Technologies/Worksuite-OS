#!/bin/sh
# Render the installed-system GRUB theme with the bundled IBM Plex fonts (branding/fonts/ibm-plex, OFL).
#   branding/grub/render.sh OUTDIR
# Writes OUTDIR/background.png, background-failed.png (1280x800), icons/<class>.png, select_*.png and the .pf2 fonts.
set -eu
here=$(cd "$(dirname "$0")" && pwd); out=${1:?out dir}
fonts="$here/../fonts/ibm-plex"
tmp=$(mktemp -d); trap 'rm -rf "$tmp"' EXIT
cat > "$tmp/fonts.conf" <<CONF
<?xml version="1.0"?><!DOCTYPE fontconfig SYSTEM "fonts.dtd">
<fontconfig><dir>$fonts</dir><cachedir>$tmp/cache</cachedir><include ignore_missing="yes">/etc/fonts/fonts.conf</include></fontconfig>
CONF
export FONTCONFIG_FILE="$tmp/fonts.conf"
mkdir -p "$out/icons"
sed -e '/<!--banner-->/,/<!--\/banner-->/d' -e 's/@PY@/142/' "$here/background.svg" > "$tmp/bg.svg"
sed -e 's/@PY@/212/' "$here/background.svg" > "$tmp/bg-failed.svg"
rsvg-convert -w 1280 -h 800 "$tmp/bg.svg" -o "$out/background.png"
rsvg-convert -w 1280 -h 800 "$tmp/bg-failed.svg" -o "$out/background-failed.png"
grep -v '^#' "$here/icons.txt" | while read -r class path; do
  [ -n "$class" ] || continue
  printf '<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="#C9D6EE" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="%s"/></svg>' "$path" > "$tmp/i.svg"
  rsvg-convert -w 20 -h 20 "$tmp/i.svg" -o "$out/icons/$class.png"
done
python3 "$here/make-pixmaps.py" "$out" live                 # blue selection pill, radius 10
grub-mkfont -s 15 -o "$out/ibmplexsans-15.pf2" "$fonts/IBMPlexSans-Regular.ttf" 2>/dev/null
grub-mkfont -s 15 -b -o "$out/ibmplexsans-semibold-15.pf2" "$fonts/IBMPlexSans-SemiBold.ttf" 2>/dev/null
grub-mkfont -s 13 -o "$out/ibmplexsans-13.pf2" "$fonts/IBMPlexSans-Regular.ttf" 2>/dev/null
grub-mkfont -s 13 -b -o "$out/ibmplexsans-semibold-13.pf2" "$fonts/IBMPlexSans-SemiBold.ttf" 2>/dev/null

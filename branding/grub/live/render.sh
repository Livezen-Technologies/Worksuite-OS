#!/bin/sh
# Render the live boot menu artwork with the bundled IBM Plex fonts (branding/fonts/ibm-plex, OFL).
#   branding/grub/live/render.sh THEME_DIR [BUILD_DATE]
# Writes THEME_DIR/../splash.png (1280x800), THEME_DIR/icons/ws-*.png (menu rows) and the GRUB .pf2 fonts.
set -eu
here=$(cd "$(dirname "$0")" && pwd); out=${1:?theme dir}; date=${2:-$(date -u +%Y-%m-%d)}
fonts="$here/../../fonts/ibm-plex"
tmp=$(mktemp -d); trap 'rm -rf "$tmp"' EXIT
cat > "$tmp/fonts.conf" <<CONF
<?xml version="1.0"?><!DOCTYPE fontconfig SYSTEM "fonts.dtd">
<fontconfig><dir>$fonts</dir><cachedir>$tmp/cache</cachedir><include ignore_missing="yes">/etc/fonts/fonts.conf</include></fontconfig>
CONF
export FONTCONFIG_FILE="$tmp/fonts.conf"
mkdir -p "$out/icons"
sed "s/@DATE@/$date/" "$here/background.svg" > "$tmp/bg.svg"
rsvg-convert -w 1280 -h 800 "$tmp/bg.svg" -o "$out/../splash.png"
python3 "$here/../make-pixmaps.py" "$out" live                 # blue selection pill
for r in ws-install ws-safe ws-utils; do rsvg-convert -w 400 -h 44 "$here/$r.svg" -o "$out/icons/$r.png"; done
grub-mkfont -s 13 -o "$out/ibmplexmono-13.pf2" "$fonts/IBMPlexMono-Regular.ttf"
grub-mkfont -s 16 -o "$out/ibmplexsans-16.pf2" "$fonts/IBMPlexSans-Regular.ttf"

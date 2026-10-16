#!/bin/sh
# Compiles installer/lang/*.ts into the Calamares branding's lang/ directory (calamares-worksuite_<lang>.qm),
# where Calamares loads branding translations for the selected language. Run by packaging/debian/rules.
set -eu
here=$(cd "$(dirname "$0")" && pwd)
out="$here/../branding/worksuite/lang"
python3 "$here/extract.py" --check
lrelease=""
for c in lrelease /usr/lib/qt6/bin/lrelease /usr/lib/qt5/bin/lrelease lrelease-qt6 lrelease-qt5; do
  if command -v "$c" >/dev/null 2>&1; then lrelease=$c; break; fi
done
[ -n "$lrelease" ] || { echo "lrelease not found (qt6-l10n-tools)" >&2; exit 1; }
mkdir -p "$out"
for ts in "$here"/calamares-worksuite_*.ts; do
  "$lrelease" -silent "$ts" -qm "$out/$(basename "$ts" .ts).qm"
done

#!/bin/sh
# Fetch the WorkSuite POS .deb into live-build/config/packages.chroot/ for live-build/build.sh.
#
# The deb is built by the "Build" workflow (build.yml) of github.com/Livezen-Technologies/worksuite-pos, artifact
# "worksuite-pos-Linux": release/<version>/*.AppImage, *.deb (WorkSuite-POS-<version>-amd64.deb, -arm64.deb) and *.rpm
# (build/electron-builder.config.cjs). The package is "worksuite-pos"; it installs "/opt/WorkSuite POS",
# /usr/bin/worksuite-pos and /usr/share/applications/worksuite-pos.desktop, Depends libsecret-1-0, libnotify4, libxss1,
# libnss3 and Recommends cups-client (receipts and the cash drawer print through CUPS). Sources, as for Desktop
# (tools/fetch-desktop.sh):
#
#   WORKSUITE_POS_URL=https://.../x.deb  [WORKSUITE_POS_SHA256=<hex> | WORKSUITE_POS_SHA256_URL=<url>]
#       Download a published deb. A SHA256 is required: given, or read from the checksum URL (default <url>.sha256).
#   otherwise: the GitHub Actions artifact via gh. GH_TOKEN must be a token with actions:read on
#       Livezen-Technologies/worksuite-pos (CI: the WORKSUITE_POS_TOKEN secret, or WORKSUITE_OFFICE_TOKEN when that
#       token also covers worksuite-pos). WORKSUITE_POS_RUN=<id> picks a run; the default is the latest successful
#       build.yml run on main.
#
#   WORKSUITE_POS_DIR=<dir>: pick from the .debs already in <dir> (an unpacked artifact; tests/image/fetch-pos.sh).
#
# The pick goes by the control fields (dpkg-deb -f Package/Architecture), never the file name. ARCH (default amd64)
# selects the package. Saved as worksuite-pos_<version>_<arch>.deb. Its updater only replaces AppImage installs
# (ucInstallType: no install type for a .deb), so on WorkSuite OS the package manager updates it.
set -eu
here=$(cd "$(dirname "$0")" && pwd)
: "${ARCH:=amd64}"
repo=Livezen-Technologies/worksuite-pos
want=worksuite-pos
dest=${WORKSUITE_POS_DEST:-"$here/../live-build/config/packages.chroot"}
mkdir -p "$dest"
tmp=$(mktemp -d)
trap 'rm -rf "$tmp"' EXIT

if [ -n "${WORKSUITE_POS_DIR:-}" ]; then
  candidates=$(find "$WORKSUITE_POS_DIR" -name '*.deb' | sort)
elif [ -n "${WORKSUITE_POS_URL:-}" ]; then
  curl -fsSL --retry 3 -o "$tmp/pos.deb" "$WORKSUITE_POS_URL"
  sum=${WORKSUITE_POS_SHA256:-}
  if [ -z "$sum" ]; then
    sum=$(curl -fsSL --retry 3 "${WORKSUITE_POS_SHA256_URL:-$WORKSUITE_POS_URL.sha256}" | awk '{print $1; exit}') || sum=
  fi
  [ -n "$sum" ] || { echo "fetch-pos: no SHA256 for $WORKSUITE_POS_URL" >&2; exit 1; }
  echo "$sum  $tmp/pos.deb" | sha256sum -c - >/dev/null || { echo "fetch-pos: checksum mismatch" >&2; exit 1; }
  candidates="$tmp/pos.deb"
else
  command -v gh >/dev/null || { echo "fetch-pos: gh is needed (or set WORKSUITE_POS_URL)" >&2; exit 1; }
  [ -n "${GH_TOKEN:-${GITHUB_TOKEN:-}}" ] || { echo "fetch-pos: set GH_TOKEN (the WORKSUITE_POS_TOKEN secret)" >&2; exit 1; }
  run=${WORKSUITE_POS_RUN:-}
  if [ -z "$run" ]; then
    run=$(gh run list -R "$repo" --workflow build.yml --branch main --status success --limit 1 \
      --json databaseId --jq '.[0].databaseId')
    [ -n "$run" ] || { echo "fetch-pos: no successful build.yml run in $repo" >&2; exit 1; }
  fi
  echo "fetch-pos: run $run of $repo, artifact worksuite-pos-Linux"
  gh run download "$run" -R "$repo" -n worksuite-pos-Linux -D "$tmp/art"
  candidates=$(find "$tmp/art" -name '*.deb' | sort)
fi

pick=
for d in $candidates; do
  pkg=$(dpkg-deb -f "$d" Package) || continue
  case "$(dpkg-deb -f "$d" Architecture)" in "$ARCH" | all) ;; *) continue ;; esac
  if [ "$pkg" = "$want" ]; then pick=$d; break; fi
done
[ -n "$pick" ] || { echo "fetch-pos: no $ARCH $want .deb among: $candidates" >&2
  for d in $candidates; do echo "  $(basename "$d"): $(dpkg-deb -f "$d" Package Architecture Version 2>&1 | tr '\n' ' ')" >&2; done
  exit 1; }
ver=$(dpkg-deb -f "$pick" Version)
rm -f "$dest"/worksuite-pos_*.deb
out="$dest/worksuite-pos_${ver}_$ARCH.deb"
cp "$pick" "$out"
echo "fetch-pos: $want $ver -> $out ($(sha256sum "$out" | cut -d' ' -f1))"

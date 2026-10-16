#!/bin/sh
# Fetch the WorkSuite Desktop .deb into live-build/config/packages.chroot/ for live-build/build.sh.
#
# The deb is built by the "Build" workflow (build.yml) of github.com/Livezen-Technologies/worksuite-desktop, job
# "package" (ubuntu-latest, electron-builder --linux), artifact "worksuite-Linux": release/<version>/*.AppImage, *.deb
# (WorkSuite-<version>-amd64.deb, WorkSuite-<version>-arm64.deb) and *.rpm. The package is "worksuite" (named apart from WorkSuite OS's own worksuite-desktop metapackage); it
# installs /opt/WorkSuite, /usr/bin/worksuite and /usr/share/applications/worksuite.desktop. Two sources, as for
# Office (tools/fetch-office.sh):
#
#   WORKSUITE_DESKTOP_URL=https://.../x.deb  [WORKSUITE_DESKTOP_SHA256=<hex> | WORKSUITE_DESKTOP_SHA256_URL=<url>]
#       Download a published deb. A SHA256 is required: given, or read from the checksum URL (default <url>.sha256).
#   otherwise: the GitHub Actions artifact via gh. GH_TOKEN must be a token with actions:read on
#       Livezen-Technologies/worksuite-desktop (CI: the WORKSUITE_DESKTOP_TOKEN secret, or WORKSUITE_OFFICE_TOKEN when
#       that token also covers worksuite-desktop). WORKSUITE_DESKTOP_RUN=<id> picks a run; the default is the latest
#       successful build.yml run on main.
#
# ARCH (default amd64) selects the package. Saved as worksuite-app_<version>_<arch>.deb. In WorkSuite OS the
# package manager updates it; the app's own updater is off there (its OS mode, docs/WORKSUITE_OS.md in that repo).
set -eu
here=$(cd "$(dirname "$0")" && pwd)
: "${ARCH:=amd64}"
repo=Livezen-Technologies/worksuite-desktop
dest="$here/../live-build/config/packages.chroot"
mkdir -p "$dest"
tmp=$(mktemp -d)
trap 'rm -rf "$tmp"' EXIT

if [ -n "${WORKSUITE_DESKTOP_URL:-}" ]; then
  curl -fsSL --retry 3 -o "$tmp/desktop.deb" "$WORKSUITE_DESKTOP_URL"
  sum=${WORKSUITE_DESKTOP_SHA256:-}
  if [ -z "$sum" ]; then
    sum=$(curl -fsSL --retry 3 "${WORKSUITE_DESKTOP_SHA256_URL:-$WORKSUITE_DESKTOP_URL.sha256}" | awk '{print $1; exit}') || sum=
  fi
  [ -n "$sum" ] || { echo "fetch-desktop: no SHA256 for $WORKSUITE_DESKTOP_URL" >&2; exit 1; }
  echo "$sum  $tmp/desktop.deb" | sha256sum -c - >/dev/null || { echo "fetch-desktop: checksum mismatch" >&2; exit 1; }
  candidates="$tmp/desktop.deb"
else
  command -v gh >/dev/null || { echo "fetch-desktop: gh is needed (or set WORKSUITE_DESKTOP_URL)" >&2; exit 1; }
  [ -n "${GH_TOKEN:-${GITHUB_TOKEN:-}}" ] || { echo "fetch-desktop: set GH_TOKEN (the WORKSUITE_DESKTOP_TOKEN secret)" >&2; exit 1; }
  run=${WORKSUITE_DESKTOP_RUN:-}
  if [ -z "$run" ]; then
    run=$(gh run list -R "$repo" --workflow build.yml --branch main --status success --limit 1 \
      --json databaseId --jq '.[0].databaseId')
    [ -n "$run" ] || { echo "fetch-desktop: no successful build.yml run in $repo" >&2; exit 1; }
  fi
  echo "fetch-desktop: run $run of $repo, artifact worksuite-Linux"
  gh run download "$run" -R "$repo" -n worksuite-Linux -D "$tmp/art"
  candidates=$(find "$tmp/art" -name '*.deb' | sort)
fi

pick=
for d in $candidates; do
  pkg=$(dpkg-deb -f "$d" Package)
  parch=$(dpkg-deb -f "$d" Architecture)
  [ "$pkg" = worksuite ] || continue
  case "$parch" in "$ARCH" | all) pick=$d; break ;; esac
done
[ -n "$pick" ] || { echo "fetch-desktop: no $ARCH worksuite .deb among: $candidates" >&2; exit 1; }
ver=$(dpkg-deb -f "$pick" Version)
rm -f "$dest"/worksuite-app_*.deb
out="$dest/worksuite-app_${ver}_$ARCH.deb"
cp "$pick" "$out"
echo "fetch-desktop: worksuite $ver -> $out ($(sha256sum "$out" | cut -d' ' -f1))"

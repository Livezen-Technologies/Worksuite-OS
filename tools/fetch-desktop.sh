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
#   WORKSUITE_DESKTOP_DIR=<dir>: pick from the .debs already in <dir> (an unpacked artifact; tests/image/fetch-desktop.sh).
#
# The pick goes by the control fields (dpkg-deb -f Package/Architecture), never the file name. Builds before
# worksuite-desktop's deb packageName (0.2.x up to early October 2026, e.g. WorkSuite-0.2.74-amd64.deb) are package
# "worksuite-desktop", the OS metapackage's name: such a deb (Architecture not all, Version below 1.0~, which the
# metapackage never is) is the same app, so its control file is rewritten to Package: worksuite (its docs moved to /usr/share/doc/worksuite) with
# Replaces/Breaks worksuite-desktop (<< 1.0~), as the newer builds declare themselves.
#
# ARCH (default amd64) selects the package. Saved as worksuite-app_<version>_<arch>.deb. In WorkSuite OS the
# package manager updates it; the app's own updater is off there (its OS mode, docs/WORKSUITE_OS.md in that repo).
set -eu
here=$(cd "$(dirname "$0")" && pwd)
: "${ARCH:=amd64}"
repo=Livezen-Technologies/worksuite-desktop
dest=${WORKSUITE_DESKTOP_DEST:-"$here/../live-build/config/packages.chroot"}
mkdir -p "$dest"
tmp=$(mktemp -d)
trap 'rm -rf "$tmp"' EXIT

if [ -n "${WORKSUITE_DESKTOP_DIR:-}" ]; then
  candidates=$(find "$WORKSUITE_DESKTOP_DIR" -name '*.deb' | sort)
elif [ -n "${WORKSUITE_DESKTOP_URL:-}" ]; then
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

# rename_legacy IN OUT: IN as package worksuite. Its docs move from /usr/share/doc/worksuite-desktop to
# /usr/share/doc/worksuite: the OS metapackage worksuite-desktop (>= 1.0) owns the old path, and dpkg refused to
# install the renamed app over it ("trying to overwrite .../worksuite-desktop/changelog.gz").
rename_legacy() {
  w="$tmp/legacy"; rm -rf "$w"; mkdir -p "$w"
  dpkg-deb -R "$1" "$w/pkg"
  if [ -d "$w/pkg/usr/share/doc/worksuite-desktop" ]; then
    rm -rf "$w/pkg/usr/share/doc/worksuite"
    mv "$w/pkg/usr/share/doc/worksuite-desktop" "$w/pkg/usr/share/doc/worksuite"
    [ -f "$w/pkg/DEBIAN/md5sums" ] && sed -i 's#  usr/share/doc/worksuite-desktop/#  usr/share/doc/worksuite/#' "$w/pkg/DEBIAN/md5sums"
  fi
  sed -i -e 's/^Package: .*/Package: worksuite/' -e '/^Replaces:/d' -e '/^Breaks:/d' "$w/pkg/DEBIAN/control"
  printf 'Replaces: worksuite-desktop (<< 1.0~)\nBreaks: worksuite-desktop (<< 1.0~)\n' >> "$w/pkg/DEBIAN/control"
  rm -f "$2"; dpkg-deb --root-owner-group -Zxz -b "$w/pkg" "$2" >/dev/null
  rm -rf "$w"
  [ "$(dpkg-deb -f "$2" Package)" = worksuite ]
  ! dpkg-deb -c "$2" | grep -q ' ./usr/share/doc/worksuite-desktop/'
}

pick=
legacy=
for d in $candidates; do
  pkg=$(dpkg-deb -f "$d" Package) || continue
  parch=$(dpkg-deb -f "$d" Architecture)
  case "$parch" in "$ARCH" | all) ;; *) continue ;; esac
  if [ "$pkg" = worksuite ]; then pick=$d; break; fi
  # The old name: only the app (arch-specific, 0.x), never the OS metapackage (all, 1.0.0~dev1 and up).
  if [ "$pkg" = worksuite-desktop ] && [ "$parch" != all ] && [ -z "$legacy" ] &&
    dpkg --compare-versions "$(dpkg-deb -f "$d" Version)" lt 1.0~; then legacy=$d; fi
done
if [ -z "$pick" ] && [ -n "$legacy" ]; then
  echo "fetch-desktop: $(basename "$legacy") is the old package name worksuite-desktop; renaming it to worksuite" >&2
  rename_legacy "$legacy" "$tmp/renamed.deb"
  pick=$tmp/renamed.deb
fi
[ -n "$pick" ] || { echo "fetch-desktop: no $ARCH worksuite .deb among: $candidates" >&2
  for d in $candidates; do echo "  $(basename "$d"): $(dpkg-deb -f "$d" Package Architecture Version 2>&1 | tr '\n' ' ')" >&2; done
  exit 1; }
ver=$(dpkg-deb -f "$pick" Version)
rm -f "$dest"/worksuite-app_*.deb
out="$dest/worksuite-app_${ver}_$ARCH.deb"
cp "$pick" "$out"
echo "fetch-desktop: worksuite $ver -> $out ($(sha256sum "$out" | cut -d' ' -f1))"

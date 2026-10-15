#!/bin/sh
# Fetch the WorkSuite Office .deb into live-build/config/packages.chroot/ for live-build/build.sh.
#
# The deb is built by the "Build WorkSuite Office (Windows/Linux)" workflow (build.yml) of
# github.com/Livezen-Technologies/worksuite-office, artifact "linux-packages-amd64" (*.deb, *.rpm, *.tar.xz).
# That repo has no GitHub releases, and its publish.yml submits builds to the download.worksuitecloud.com Update
# Center through an authenticated API (no fixed per-file URL), so there are two sources:
#
#   WORKSUITE_OFFICE_URL=https://.../x.deb  [WORKSUITE_OFFICE_SHA256=<hex> | WORKSUITE_OFFICE_SHA256_URL=<url>]
#       Download a published deb. A SHA256 is required: given, or read from the checksum URL (default <url>.sha256).
#   otherwise: the GitHub Actions artifact via gh. GH_TOKEN must be a token with actions:read on
#       Livezen-Technologies/worksuite-office (the WORKSUITE_OFFICE_TOKEN secret in CI). WORKSUITE_OFFICE_RUN=<id>
#       picks a run; the default is the latest successful build.yml run on main.
#
# ARCH (default amd64) selects the package. Saved as worksuite-office_<version>_<arch>.deb.
set -eu
here=$(cd "$(dirname "$0")" && pwd)
: "${ARCH:=amd64}"
repo=Livezen-Technologies/worksuite-office
dest="$here/../live-build/config/packages.chroot"
mkdir -p "$dest"
tmp=$(mktemp -d)
trap 'rm -rf "$tmp"' EXIT

if [ -n "${WORKSUITE_OFFICE_URL:-}" ]; then
  curl -fsSL --retry 3 -o "$tmp/office.deb" "$WORKSUITE_OFFICE_URL"
  sum=${WORKSUITE_OFFICE_SHA256:-}
  if [ -z "$sum" ]; then
    sum=$(curl -fsSL --retry 3 "${WORKSUITE_OFFICE_SHA256_URL:-$WORKSUITE_OFFICE_URL.sha256}" | awk '{print $1; exit}') || sum=
  fi
  [ -n "$sum" ] || { echo "fetch-office: no SHA256 for $WORKSUITE_OFFICE_URL" >&2; exit 1; }
  echo "$sum  $tmp/office.deb" | sha256sum -c - >/dev/null || { echo "fetch-office: checksum mismatch" >&2; exit 1; }
  candidates="$tmp/office.deb"
else
  command -v gh >/dev/null || { echo "fetch-office: gh is needed (or set WORKSUITE_OFFICE_URL)" >&2; exit 1; }
  [ -n "${GH_TOKEN:-${GITHUB_TOKEN:-}}" ] || { echo "fetch-office: set GH_TOKEN (the WORKSUITE_OFFICE_TOKEN secret)" >&2; exit 1; }
  run=${WORKSUITE_OFFICE_RUN:-}
  if [ -z "$run" ]; then
    run=$(gh run list -R "$repo" --workflow build.yml --branch main --status success --limit 1 \
      --json databaseId --jq '.[0].databaseId')
    [ -n "$run" ] || { echo "fetch-office: no successful build.yml run in $repo" >&2; exit 1; }
  fi
  echo "fetch-office: run $run of $repo, artifact linux-packages-$ARCH"
  gh run download "$run" -R "$repo" -n "linux-packages-$ARCH" -D "$tmp/art"
  candidates=$(find "$tmp/art" -name '*.deb' | sort)
fi

# The editors package (worksuite-desktopeditors, ONLYOFFICE's onlyoffice-desktopeditors rebranded); skip help/debug.
pick=
for d in $candidates; do
  pkg=$(dpkg-deb -f "$d" Package)
  parch=$(dpkg-deb -f "$d" Architecture)
  case "$pkg" in *-help | *-dbg | *-dbgsym) continue ;; esac
  case "$parch" in "$ARCH" | all) pick=$d; break ;; esac
done
[ -n "$pick" ] || { echo "fetch-office: no $ARCH editors .deb among: $candidates" >&2; exit 1; }
ver=$(dpkg-deb -f "$pick" Version)
rm -f "$dest"/worksuite-office*.deb
out="$dest/worksuite-office_${ver}_$ARCH.deb"
cp "$pick" "$out"
echo "fetch-office: $(dpkg-deb -f "$out" Package) $ver -> $out ($(sha256sum "$out" | cut -d' ' -f1))"

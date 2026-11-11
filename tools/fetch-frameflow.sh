#!/bin/sh
# Fetch the Worksuite FrameFlow .deb into live-build/config/packages.chroot/ for live-build/build.sh.
#
# The deb is built by the "Desktop Build" workflow (desktop-build.yml) of github.com/Livezen-Technologies/worksuite-frameflow
# (public), job "Linux" (electron-builder --linux), artifact "Worksuite-FrameFlow-Linux": electron/dist/*.AppImage and
# *.deb (Worksuite-FrameFlow-<version>-linux-amd64.deb). Tags v* also attach the deb to a GitHub release and publish it
# to the download center (download.worksuitecloud.com/frameflow/<channel>/). The package is "worksuite-frameflow"; it
# installs "/opt/Worksuite FrameFlow", /usr/bin/worksuite-frameflow and /usr/share/applications/worksuite-frameflow.desktop.
# Sources, as for Desktop (tools/fetch-desktop.sh):
#
#   WORKSUITE_FRAMEFLOW_URL=https://.../x.deb  [WORKSUITE_FRAMEFLOW_SHA256=<hex> | WORKSUITE_FRAMEFLOW_SHA256_URL=<url>]
#       Download a published deb. A SHA256 is required: given, or read from the checksum URL (default <url>.sha256).
#   otherwise: the GitHub Actions artifact via gh. GH_TOKEN may be any token (the repository is public; artifact
#       downloads still need an authenticated gh, CI's GITHUB_TOKEN does). WORKSUITE_FRAMEFLOW_RUN=<id> picks a run;
#       the default is the latest successful desktop-build.yml run on main.
#
#   WORKSUITE_FRAMEFLOW_DIR=<dir>: pick from the .debs already in <dir> (an unpacked artifact; tests/image/fetch-frameflow.sh).
#
# The pick goes by the control fields (dpkg-deb -f Package/Architecture), never the file name. ARCH (default amd64)
# selects the package. Saved as worksuite-frameflow_<version>_<arch>.deb. Its updater does not replace a .deb install
# (it points at the download center); on WorkSuite OS the package manager updates it.
set -eu
here=$(cd "$(dirname "$0")" && pwd)
: "${ARCH:=amd64}"
repo=Livezen-Technologies/worksuite-frameflow
want=worksuite-frameflow
dest=${WORKSUITE_FRAMEFLOW_DEST:-"$here/../live-build/config/packages.chroot"}
mkdir -p "$dest"
tmp=$(mktemp -d)
trap 'rm -rf "$tmp"' EXIT

if [ -n "${WORKSUITE_FRAMEFLOW_DIR:-}" ]; then
  candidates=$(find "$WORKSUITE_FRAMEFLOW_DIR" -name '*.deb' | sort)
elif [ -n "${WORKSUITE_FRAMEFLOW_URL:-}" ]; then
  curl -fsSL --retry 3 -o "$tmp/frameflow.deb" "$WORKSUITE_FRAMEFLOW_URL"
  sum=${WORKSUITE_FRAMEFLOW_SHA256:-}
  if [ -z "$sum" ]; then
    sum=$(curl -fsSL --retry 3 "${WORKSUITE_FRAMEFLOW_SHA256_URL:-$WORKSUITE_FRAMEFLOW_URL.sha256}" | awk '{print $1; exit}') || sum=
  fi
  [ -n "$sum" ] || { echo "fetch-frameflow: no SHA256 for $WORKSUITE_FRAMEFLOW_URL" >&2; exit 1; }
  echo "$sum  $tmp/frameflow.deb" | sha256sum -c - >/dev/null || { echo "fetch-frameflow: checksum mismatch" >&2; exit 1; }
  candidates="$tmp/frameflow.deb"
else
  command -v gh >/dev/null || { echo "fetch-frameflow: gh is needed (or set WORKSUITE_FRAMEFLOW_URL)" >&2; exit 1; }
  [ -n "${GH_TOKEN:-${GITHUB_TOKEN:-}}" ] || { echo "fetch-frameflow: set GH_TOKEN (any token; the repository is public)" >&2; exit 1; }
  run=${WORKSUITE_FRAMEFLOW_RUN:-}
  if [ -z "$run" ]; then
    run=$(gh run list -R "$repo" --workflow desktop-build.yml --branch main --status success --limit 1 \
      --json databaseId --jq '.[0].databaseId')
    [ -n "$run" ] || { echo "fetch-frameflow: no successful desktop-build.yml run in $repo" >&2; exit 1; }
  fi
  echo "fetch-frameflow: run $run of $repo, artifact Worksuite-FrameFlow-Linux"
  gh run download "$run" -R "$repo" -n Worksuite-FrameFlow-Linux -D "$tmp/art"
  candidates=$(find "$tmp/art" -name '*.deb' | sort)
fi

pick=
for d in $candidates; do
  pkg=$(dpkg-deb -f "$d" Package) || continue
  case "$(dpkg-deb -f "$d" Architecture)" in "$ARCH" | all) ;; *) continue ;; esac
  if [ "$pkg" = "$want" ]; then pick=$d; break; fi
done
[ -n "$pick" ] || { echo "fetch-frameflow: no $ARCH $want .deb among: $candidates" >&2
  for d in $candidates; do echo "  $(basename "$d"): $(dpkg-deb -f "$d" Package Architecture Version 2>&1 | tr '\n' ' ')" >&2; done
  exit 1; }
ver=$(dpkg-deb -f "$pick" Version)
rm -f "$dest"/worksuite-frameflow_*.deb
out="$dest/worksuite-frameflow_${ver}_$ARCH.deb"
cp "$pick" "$out"
echo "fetch-frameflow: $want $ver -> $out ($(sha256sum "$out" | cut -d' ' -f1))"

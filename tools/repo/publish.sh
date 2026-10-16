#!/bin/sh
# Build or update the WorkSuite APT repository and sign it (WSOS-AUP-002). Suites per ring:
# trixie-dev | trixie-pilot | trixie-stable. Promote a build by publishing the same .debs to the next suite.
#   GNUPGHOME=KEYS/gnupg tools/repo/publish.sh REPO SUITE DEB...
# REPO is the static tree served at https://<host>/os/apt (worksuite-server serve --apt-dir REPO, or any web server).
set -eu
repo=${1:?repo dir}; suite=${2:?suite}; shift 2
case "$suite" in trixie-dev|trixie-pilot|trixie-stable) ;; *) echo "suite must be trixie-dev, trixie-pilot or trixie-stable" >&2; exit 2 ;; esac
# With no .deb arguments the suite is only re-signed (Valid-Until is 14 days: re-run at least weekly).
: "${GNUPGHOME:?set GNUPGHOME to the directory holding the archive signing key}"
mkdir -p "$repo/pool/main" "$repo/lists"
list="$repo/lists/$suite"; touch "$list"
for deb in "$@"; do
  pkg=$(dpkg-deb -f "$deb" Package); ver=$(dpkg-deb -f "$deb" Version); arch=$(dpkg-deb -f "$deb" Architecture)
  dest="pool/main/$(printf %s "$pkg" | cut -c1)/$pkg/$(basename "$deb")"
  mkdir -p "$repo/$(dirname "$dest")"; cp "$deb" "$repo/$dest"
  # One version per package and architecture in a suite; the pool keeps older files for rollback directives.
  grep -v "^$pkg $arch " "$list" > "$list.new" || true
  echo "$pkg $arch $ver $dest" >> "$list.new"; sort -o "$list" "$list.new"; rm -f "$list.new"
done
fpr=$(gpg --batch --list-secret-keys --with-colons | awk -F: '/^fpr/ {print $10; exit}')
[ -n "$fpr" ] || { echo "no secret key in $GNUPGHOME" >&2; exit 1; }
dist="$repo/dists/$suite"; rm -rf "$dist"
for arch in amd64 arm64; do
  d="$dist/main/binary-$arch"; mkdir -p "$d"
  (cd "$repo" && awk -v a="$arch" '$2 == a || $2 == "all" {print $4}' "lists/$suite" | while read -r f; do
     apt-ftparchive packages "$f"; done) > "$d/Packages"
  gzip -9nk "$d/Packages"; xz -9k "$d/Packages"
done
apt-ftparchive -o APT::FTPArchive::Release::Origin=WorkSuite -o APT::FTPArchive::Release::Label=WorkSuite \
  -o APT::FTPArchive::Release::Suite="$suite" -o APT::FTPArchive::Release::Codename="$suite" \
  -o APT::FTPArchive::Release::Architectures="amd64 arm64" -o APT::FTPArchive::Release::Components=main \
  -o APT::FTPArchive::Release::Acquire-By-Hash=no \
  -o APT::FTPArchive::Release::Valid-Until="$(date -u -d '+14 days' '+%a, %d %b %Y %H:%M:%S UTC')" \
  release "$dist" > "$dist/Release.tmp"
mv "$dist/Release.tmp" "$dist/Release"
gpg --batch --yes --pinentry-mode loopback --passphrase "${WORKSUITE_KEY_PASSPHRASE:-}" -u "$fpr" --digest-algo SHA512 --clearsign -o "$dist/InRelease" "$dist/Release"
gpg --batch --yes --pinentry-mode loopback --passphrase "${WORKSUITE_KEY_PASSPHRASE:-}" -u "$fpr" --digest-algo SHA512 -abs -o "$dist/Release.gpg" "$dist/Release"
echo "published $suite: $(wc -l < "$list") package(s), signed by $fpr"

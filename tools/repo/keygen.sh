#!/bin/sh
# Create the WorkSuite signing keys (WSOS-SEC-011). Run on an offline machine; keep OUT safe (or import it into an HSM).
#   tools/repo/keygen.sh OUT [--name "WorkSuite OS Archive Signing Key"]
# OUT/gnupg      private OpenPGP key that signs the APT repository's InRelease/Release.gpg
# OUT/archive.gpg   its public key (binary) → packaging/keyring/worksuite-archive-keyring.gpg
# The Ed25519 keys for commands, policies and manifests live in worksuite-server (keys-export → packaging/keyring/ed25519/…).
set -eu
out=${1:?output directory}; name=${3:-WorkSuite OS Archive Signing Key}
[ ! -e "$out/gnupg" ] || { echo "$out/gnupg exists; refusing to overwrite a key" >&2; exit 1; }
mkdir -p "$out/gnupg"; chmod 700 "$out" "$out/gnupg"
export GNUPGHOME="$out/gnupg"
gpg --batch --quiet --pinentry-mode loopback --passphrase "${WORKSUITE_KEY_PASSPHRASE:-}" \
  --quick-generate-key "$name <archive@worksuitecloud.com>" ed25519 sign 3y
fpr=$(gpg --batch --list-secret-keys --with-colons | awk -F: '/^fpr/ {print $10; exit}')
gpg --batch --export "$fpr" > "$out/archive.gpg"
echo "$fpr" > "$out/fingerprint"
echo "archive signing key $fpr; public key: $out/archive.pgp"

#!/bin/sh
# Copy the Update Center's release public keys (the keys that sign OS manifests) into
# packaging/keyring/ed25519/release/<key_id>.pem, from where worksuite-archive-keyring installs them to
# /usr/share/worksuite/keys/release. Public keys only; review the diff before committing.
#   tools/repo/fetch-release-keys.sh [https://download.worksuitecloud.com]
set -eu
host=${1:-https://download.worksuitecloud.com}
case "$host" in https://*) ;; *) echo "host must be https://" >&2; exit 2 ;; esac
dir=$(cd "$(dirname "$0")/../.." && pwd)/packaging/keyring/ed25519/release
mkdir -p "$dir"
curl -fsS "$host/api/v1/os/keys" | node -e '
  const fs = require("fs"); const out = process.argv[1]; let n = 0;
  for (const k of JSON.parse(fs.readFileSync(0, "utf8")).keys) {
    if (!/^[A-Za-z0-9._-]+$/.test(k.key_id) || !/^-----BEGIN PUBLIC KEY-----\n[A-Za-z0-9+\/=\n]+-----END PUBLIC KEY-----\n?$/.test(k.public_pem)) throw new Error("bad key " + k.key_id);
    fs.writeFileSync(`${out}/${k.key_id}.pem`, k.public_pem); n++; console.log(`${out}/${k.key_id}.pem`);
  }
  if (!n) throw new Error("no keys");' "$dir"

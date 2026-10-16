#!/bin/sh
# Signed APT repository end to end with real apt, no root: keygen → publish → serve (worksuite-server --apt-dir) →
# apt-get update/install simulation/download; then a tampered InRelease and a wrong key must be refused with the
# errors the package service maps to SignatureInvalid (services/package-service/src/service.ts).
set -eu
root=$(cd "$(dirname "$0")/../.." && pwd)
t=$(mktemp -d); trap 'kill $srv 2>/dev/null || true; rm -rf "$t"' EXIT
export no_proxy='*' NO_PROXY='*'
ok() { echo "ok - $1"; }
fail() { echo "FAIL - $1"; [ -f "$t/apt.log" ] && tail -5 "$t/apt.log"; exit 1; }

"$root/tools/repo/keygen.sh" "$t/keys" >/dev/null 2>&1
"$root/tools/repo/keygen.sh" "$t/other" >/dev/null 2>&1

probe() {   # probe VERSION → .deb
  d="$t/build/$1"; mkdir -p "$d/DEBIAN" "$d/usr/share/doc/worksuite-repo-probe"
  printf 'Package: worksuite-repo-probe\nVersion: %s\nArchitecture: all\nMaintainer: WorkSuite <os@worksuitecloud.com>\nDescription: repository probe\n' "$1" > "$d/DEBIAN/control"
  echo "$1" > "$d/usr/share/doc/worksuite-repo-probe/version"
  dpkg-deb -Zxz --root-owner-group -b "$d" "$t/probe_$1_all.deb" >/dev/null
  echo "$t/probe_$1_all.deb"
}
GNUPGHOME="$t/keys/gnupg" "$root/tools/repo/publish.sh" "$t/repo" trixie-stable "$(probe 1.0)" >/dev/null

port=$((20000 + $$ % 20000))
node --no-warnings "$root/services/server/src/main.ts" serve --db "$t/server.db" --public-url "http://127.0.0.1:$port" \
  --listen "127.0.0.1:$port" --apt-dir "$t/repo" > "$t/server.log" 2>&1 &
srv=$!
for i in $(seq 1 50); do curl -fs "http://127.0.0.1:$port/.well-known/worksuite-desktop" >/dev/null 2>&1 && break; sleep 0.1; done

a="$t/apt"; mkdir -p "$a/etc/sources.list.d" "$a/etc/preferences.d" "$a/etc/apt.conf.d" "$a/etc/trusted.gpg.d" "$a/state/lists/partial" "$a/cache/archives/partial"
: > "$a/status"
apt() {
  cmd=$1; shift
  "$cmd" -o Dir::Etc="$a/etc" -o Dir::State="$a/state" -o Dir::Cache="$a/cache" -o Dir::State::status="$a/status" \
    -o Debug::NoLocking=1 -o APT::Architecture=amd64 -o APT::Architectures::=amd64 -o Acquire::Languages=none \
    -o APT::Sandbox::User="$(id -un)" "$@"
}
source() {   # source KEYRING
  printf 'Types: deb\nURIs: http://127.0.0.1:%s/os/apt\nSuites: trixie-stable\nComponents: main\nSigned-By: %s\n' "$port" "$1" > "$a/etc/sources.list.d/worksuite.sources"
}
source "$t/keys/archive.gpg"

apt apt-get update > "$t/apt.log" 2>&1 || fail "apt-get update against the signed repository"
ok "apt verified InRelease and fetched the index"
apt apt-cache policy worksuite-repo-probe | grep -q 'Candidate: 1.0' || fail "candidate 1.0"
ok "candidate is 1.0"

GNUPGHOME="$t/keys/gnupg" "$root/tools/repo/publish.sh" "$t/repo" trixie-stable "$(probe 1.1)" >/dev/null
apt apt-get update > "$t/apt.log" 2>&1 || fail "update after publishing 1.1"
apt apt-get -s install worksuite-repo-probe | grep -q '^Inst worksuite-repo-probe (1.1 ' || fail "1.1 offered"
ok "after publishing 1.1, apt offers 1.1"
(cd "$t" && apt apt-get download worksuite-repo-probe > "$t/apt.log" 2>&1) || fail "download (hash checked against the signed index)"
[ "$(dpkg-deb -f "$t"/worksuite-repo-probe_1.1_all.deb Version)" = 1.1 ] || fail "downloaded 1.1"
ok "download matches the signed index"

# Tampered InRelease: change the signed text, keep the signature.
cp "$t/repo/dists/trixie-stable/InRelease" "$t/InRelease.good"
sed -i 's/^Label: WorkSuite$/Label: Evil/' "$t/repo/dists/trixie-stable/InRelease"
rm -rf "$a"/state/lists/*_dists_* 2>/dev/null || true
if apt apt-get update > "$t/apt.log" 2>&1 && ! grep -qE '^(W|E):' "$t/apt.log"; then fail "tampered InRelease accepted"; fi
grep -Eq 'NO_PUBKEY|not signed|InRelease.*(invalid|is not valid)|EXPKEYSIG|BADSIG|BAD signature|not valid' "$t/apt.log" || fail "tampered InRelease: unexpected error text"
ok "tampered InRelease is refused"
cp "$t/InRelease.good" "$t/repo/dists/trixie-stable/InRelease"
apt apt-get update > "$t/apt.log" 2>&1 || fail "update after restoring the good InRelease"

# An attacker who controls the mirror re-signs it with their own key to push 1.2: refused, and the device keeps
# the last verified index (still 1.1).
GNUPGHOME="$t/other/gnupg" "$root/tools/repo/publish.sh" "$t/repo" trixie-stable "$(probe 1.2)" >/dev/null
apt apt-get update > "$t/apt.log" 2>&1 || true
grep -Eq 'NO_PUBKEY|not signed|InRelease.*(invalid|is not valid)|EXPKEYSIG|BADSIG' "$t/apt.log" || fail "foreign key: expected a signature error the package service recognises"
apt apt-cache policy worksuite-repo-probe > "$t/policy.txt"; cat "$t/policy.txt" >> "$t/apt.log"; grep -q "Candidate: 1.1" "$t/policy.txt" || fail "1.2 from a foreign key must not become installable"
ok "a repository re-signed with another key is refused; 1.2 is not offered"

# The server never serves outside the repository.
[ "$(curl -s -o /dev/null -w '%{http_code}' "http://127.0.0.1:$port/os/apt/dists/../../server.db")" = 404 ] || fail "path traversal"
[ "$(curl -s -o /dev/null -w '%{http_code}' --path-as-is "http://127.0.0.1:$port/os/apt/pool/%2e%2e/%2e%2e/server.db")" = 404 ] || fail "encoded path traversal"
ok "no path traversal"
echo PASS

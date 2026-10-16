#!/bin/sh
# OS ↔ server end to end in QEMU. Three steps:
#   tests/vm/server-e2e.sh prepare DIR        test CA + ws.test certificate, server DB, keys, enrollment token
#   WORKSUITE_TEST_SERVER=DIR live-build/build.sh   (inside Debian trixie) → worksuite-os-…-test.iso
#   tests/vm/server-e2e.sh run DIR ISO [timeout-seconds]
# The guest reaches the host's 127.0.0.1:8443 as 10.0.2.2:8443 (QEMU user networking); the test image maps ws.test
# to 10.0.2.2 and trusts the test CA. Release images never contain any of this.
set -eu
here=$(cd "$(dirname "$0")" && pwd)
server_js="$here/../../services/server/src/main.ts"
cmd=${1:?prepare|run}; dir=${2:?dir}
srv() { node --no-warnings "$server_js" "$@" --db "$dir/server.db"; }

case "$cmd" in
prepare)
  mkdir -p "$dir"
  openssl req -x509 -newkey ec -pkeyopt ec_paramgen_curve:P-256 -nodes -days 30 -subj "/CN=WorkSuite test CA" \
    -keyout "$dir/ca.key" -out "$dir/ca.crt" 2>/dev/null
  openssl req -newkey ec -pkeyopt ec_paramgen_curve:P-256 -nodes -subj "/CN=ws.test" -keyout "$dir/tls.key" -out "$dir/tls.csr" 2>/dev/null
  printf 'subjectAltName=DNS:ws.test\nextendedKeyUsage=serverAuth\n' > "$dir/ext.cnf"
  openssl x509 -req -in "$dir/tls.csr" -CA "$dir/ca.crt" -CAkey "$dir/ca.key" -CAcreateserial -days 30 -extfile "$dir/ext.cnf" -out "$dir/tls.crt" 2>/dev/null
  srv init --org "Livezen Technologies" >/dev/null
  printf '%s\n' "$(od -An -tx1 -N16 /dev/urandom | tr -d ' \n')" | srv user-add --org 1 --email e2e@ws.test --name "E2E User" >/dev/null
  printf '{"update_ring":"stable","update_mode":"notify","update_mirror":"https://ws.test:8443","app_allowlist":[]}\n' > "$dir/policy.json"
  srv policy-set --org 1 "$dir/policy.json" >/dev/null
  printf '{"release_id":"r-1.0.1","version":"1.0.1","min_version":"1.0.0~dev1","ring":"stable","arch":"%s"}\n' "${ARCH:-amd64}" > "$dir/release.json"
  srv release-publish "$dir/release.json" >/dev/null
  srv enroll-token --org 1 --hours 48 > "$dir/token"
  srv keys-export "$dir/keys" >/dev/null
  echo "prepared $dir (CA, ws.test certificate, server DB, keys, token)"
  ;;
run)
  iso=${3:?iso}; timeout=${4:-2700}
  log="$dir/serial.log"; : > "$log"
  node --no-warnings "$server_js" serve --db "$dir/server.db" --public-url https://ws.test:8443 --listen 127.0.0.1:8443 \
    --tls-cert "$dir/tls.crt" --tls-key "$dir/tls.key" > "$dir/server.log" 2>&1 &
  server=$!
  . "$(dirname "$0")/qemu-arch.sh" "$iso"
  vars=$(mktemp); cp "$FW_VARS_TEMPLATE" "$vars"
  # shellcheck disable=SC2046,SC2086
  $QEMU $MACHINE -m 4096 -smp 2 \
    -drive if=pflash,format=raw,readonly=on,file="$FW_CODE" -drive if=pflash,format=raw,file="$vars" \
    $(cdrom_args "$iso") -display none -serial file:"$log" -no-reboot \
    -fw_cfg name=opt/worksuite/token,file="$dir/token" -fw_cfg name=opt/worksuite/server,string=https://ws.test:8443/ &
  qemu=$!
  trap 'kill $qemu $server 2>/dev/null || true; rm -f "$vars"' EXIT
  q() { node --no-warnings -e "const {DatabaseSync}=require('node:sqlite');const d=new DatabaseSync(process.argv[1]);const r=d.prepare(process.argv[2]).get();console.log(r?Object.values(r)[0]:'')" "$dir/server.db" "$1" 2>/dev/null; }
  end=$(( $(date +%s) + timeout )); queued=
  while [ "$(date +%s)" -lt "$end" ]; do
    # Queue a signed command as soon as the device has enrolled.
    dev=$(q "SELECT id FROM devices ORDER BY enrolled_at DESC LIMIT 1")
    if [ -n "$dev" ] && [ -z "$queued" ]; then srv command --device "$dev" --name RequestLock >/dev/null; queued=1; echo "device $dev enrolled; queued RequestLock"; fi
    grep -aq 'WORKSUITE_E2E_DONE\|WORKSUITE_E2E_ENROLL_FAILED\|WORKSUITE_E2E skipped' "$log" && break
    kill -0 $qemu 2>/dev/null || break
    sleep 5
  done
  grep -ao 'WORKSUITE_E2E[A-Z_]*.*' "$log" | tr -d '\r'
  fail=0
  [ -n "$dev" ] || { echo "FAIL: no device enrolled"; fail=1; }
  [ "$(q "SELECT state FROM commands ORDER BY rowid DESC LIMIT 1")" = completed ] || { echo "FAIL: command not completed"; fail=1; }
  [ -n "$(q "SELECT heartbeat FROM devices WHERE heartbeat IS NOT NULL")" ] || { echo "FAIL: no heartbeat"; fail=1; }
  grep -aq 'WORKSUITE_E2E_POLICY 1 notify' "$log" || { echo "FAIL: signed policy not applied"; fail=1; }
  grep -aEq 'WORKSUITE_E2E_UPDATE (available|waiting) 1.0.1' "$log" || { echo "FAIL: update not offered from the signed manifest"; fail=1; }   # notify mode: waiting_for_user
  [ $fail = 0 ] && echo "PASS ($accel)"
  [ $fail = 0 ] || { echo "--- server log"; tail -20 "$dir/server.log"; echo "--- last console lines"; tail -30 "$log" | tr -d '\r'; }
  exit $fail
  ;;
*) echo "usage: $0 prepare|run DIR [ISO]" >&2; exit 2 ;;
esac

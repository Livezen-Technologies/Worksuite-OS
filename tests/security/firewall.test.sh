#!/bin/sh
# Default firewall (docs/security/hardening.md): the shipped /etc/nftables.conf parses, is inbound default-deny,
# never flushes the whole ruleset (the device agent's VPN kill switch lives in its own table), and the image enables it.
set -eu
root=$(cd "$(dirname "$0")/../.." && pwd)
conf="$root/live-build/config/includes.chroot/etc/nftables.conf"
fail() { echo "not ok - $1"; exit 1; }
grep -q 'hook input priority filter; policy drop;' "$conf" || fail "input chain is not default-deny"
grep -q 'hook output priority filter; policy accept;' "$conf" || fail "output chain does not allow"
grep -q 'ct state { established, related } accept' "$conf" || fail "established/related not accepted"
! grep -qE '^[[:space:]]*flush ruleset' "$conf" || fail "nftables.conf flushes the whole ruleset (kills the VPN kill switch)"
grep -q 'worksuite_vpn_killswitch' "$root/services/device-agent/src/vpn.ts" && ! grep -qE '^(table|delete table) .*worksuite_vpn_killswitch' "$conf" \
  || fail "firewall and VPN kill switch must use different tables"
grep -qx 'include "/etc/worksuite/nftables.d/\*.nft"' "$conf" || fail "policy table (device agent) not included at boot"
grep -q 'worksuite_policy' "$root/services/device-agent/src/security.ts" && ! grep -qE '^(table|delete table) .*worksuite_policy' "$conf" \
  || fail "default firewall and organization policy must use different tables"
grep -qx 'systemctl enable nftables.service' "$root/live-build/config/hooks/normal/0100-worksuite-defaults.hook.chroot" || fail "nftables.service not enabled"
if command -v nft >/dev/null 2>&1 && [ "$(id -u)" = 0 ]; then
  nft -c -f "$conf" || fail "nft -c rejects nftables.conf"
  echo "ok - nftables.conf parses"
fi
echo "ok - default firewall"

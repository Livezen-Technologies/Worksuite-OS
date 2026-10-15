// Managed WireGuard VPN (WSOS-INT-001). Pure: key generation, the signed per-device config → NetworkManager keyfile,
// the nftables kill switch, and which user-imported VPNs policy removes. host.ts applies the result as root.
//
//   /etc/NetworkManager/system-connections/worksuite-vpn.nmconnection   root:root 0600 (NM refuses anything else);
//       the only place the private key is written besides the agent's 0700 state dir. Never sent anywhere.
//   nft table inet worksuite_vpn_killswitch                             kill switch (only while the config asks for it)
import { createPrivateKey, createPublicKey, generateKeyPairSync } from 'node:crypto';
import type { Policy } from './state.ts';

export const VPN_CONNECTION_ID = 'WorkSuite VPN';
/** Fixed so the agent always replaces its own connection and never touches others. */
export const VPN_CONNECTION_UUID = '6f1d9a52-3c47-4b8e-9a0d-57e2c1b4f0a3';
export const VPN_INTERFACE = 'wsvpn0';
export const VPN_KEYFILE = '/etc/NetworkManager/system-connections/worksuite-vpn.nmconnection';
export const KILLSWITCH_TABLE = 'worksuite_vpn_killswitch';

/** Signed by the server like policies; see api-contracts/openapi.yaml VpnConfig. */
export interface VpnConfig {
  device_id: string;
  enabled: boolean;
  version: string;
  issued_at: string;
  device_public_key?: string;
  interface?: { address: string[]; dns: string[]; dns_search: string[]; mtu?: number };
  peer?: { public_key: string; endpoint: string; allowed_ips: string[]; persistent_keepalive?: number };
  always_on?: boolean;
  kill_switch?: boolean;
  key_rotation_days?: number;
  signature: string;
  [k: string]: unknown;
}

const WG_KEY = /^[A-Za-z0-9+/]{42}[AEIMQUYcgkosw480]=$/;
export const isWgKey = (v: unknown): v is string => typeof v === 'string' && WG_KEY.test(v);

/** Curve25519 keypair in WireGuard's base64 form (same as `wg genkey | wg pubkey`). */
export function wgKeyPair(): { privateKey: string; publicKey: string } {
  const { privateKey, publicKey } = generateKeyPairSync('x25519');
  const b64 = (u: string | undefined) => Buffer.from(u!, 'base64url').toString('base64');
  return { privateKey: b64(privateKey.export({ format: 'jwk' }).d), publicKey: b64(publicKey.export({ format: 'jwk' }).x) };
}

export function wgPublicKey(privateKey: string): string {
  if (!isWgKey(privateKey)) throw new Error('BAD_WG_KEY');
  // PKCS#8 wrapper for a raw X25519 private key (RFC 8410).
  const der = Buffer.concat([Buffer.from('302e020100300506032b656e04220420', 'hex'), Buffer.from(privateKey, 'base64')]);
  const pub = createPublicKey(createPrivateKey({ key: der, format: 'der', type: 'pkcs8' }));
  return Buffer.from(pub.export({ format: 'jwk' }).x!, 'base64url').toString('base64');
}

const CIDR = /^([0-9.]+|[0-9a-f:]+)\/\d{1,3}$/i;
const IP = /^([0-9.]+|[0-9a-f:]+)$/i;
const HOST_PORT = /^(\[[0-9a-f:]+\]|[A-Za-z0-9.-]{1,253}):(\d{1,5})$/i;
const DOMAIN = /^[A-Za-z0-9.-]{1,253}$/;

/** Structural check of a verified config before it becomes a root-owned file. Throws on anything unexpected. */
export function checkVpnConfig(c: VpnConfig): void {
  if (!c.enabled) return;
  const i = c.interface, p = c.peer;
  const ok = !!i && !!p && isWgKey(p.public_key) && HOST_PORT.test(p.endpoint)
    && Array.isArray(i.address) && i.address.length > 0 && i.address.every((a) => CIDR.test(a))
    && Array.isArray(p.allowed_ips) && p.allowed_ips.length > 0 && p.allowed_ips.every((a) => CIDR.test(a))
    && (i.dns ?? []).every((d) => IP.test(d)) && (i.dns_search ?? []).every((d) => DOMAIN.test(d))
    && (i.mtu === undefined || (Number.isInteger(i.mtu) && i.mtu >= 1280 && i.mtu <= 1500))
    && (p.persistent_keepalive === undefined || (Number.isInteger(p.persistent_keepalive) && p.persistent_keepalive >= 0 && p.persistent_keepalive <= 65535));
  if (!ok) throw new Error('VPN_CONFIG_INVALID');
}

export interface VpnPlan {
  config: VpnConfig;
  /** Connect at boot and keep reconnecting: config always_on or policy vpn_required. */
  autoconnect: boolean;
  kill_switch: boolean;
  endpoint: { host: string; port: number };
}

/** Signed config + policy → what the host applies; null = no managed VPN (connection and kill switch removed). */
export function vpnPlan(cfg: VpnConfig | null | undefined, policy: Policy | null | undefined): VpnPlan | null {
  if (!cfg || !cfg.enabled) return null;
  checkVpnConfig(cfg);
  const m = HOST_PORT.exec(cfg.peer!.endpoint)!;
  return {
    config: cfg,
    autoconnect: cfg.always_on === true || policy?.vpn_required === true,
    kill_switch: cfg.kill_switch === true,
    endpoint: { host: m[1].replace(/^\[|\]$/g, ''), port: Number(m[2]) },
  };
}

const isV6 = (cidr: string) => cidr.includes(':');

/** NetworkManager keyfile (nm-settings-keyfile(5)) for a wireguard connection. Contains the private key: write 0600. */
export function renderNmConnection(plan: VpnPlan, privateKey: string): string {
  if (!isWgKey(privateKey)) throw new Error('BAD_WG_KEY');
  const { interface: i, peer: p } = plan.config as Required<VpnConfig>;
  const v4 = i.address.filter((a) => !isV6(a)), v6 = i.address.filter(isV6);
  const full = p.allowed_ips.includes('0.0.0.0/0');
  const list = (xs: string[]) => xs.map((x) => `${x};`).join('');
  const lines = [
    '# Written by worksuite-device-agent from the signed VPN config. Local changes are replaced.',
    '[connection]',
    `id=${VPN_CONNECTION_ID}`,
    `uuid=${VPN_CONNECTION_UUID}`,
    'type=wireguard',
    `interface-name=${VPN_INTERFACE}`,
    `autoconnect=${plan.autoconnect}`,
    ...(plan.autoconnect ? ['autoconnect-priority=100', 'autoconnect-retries=0'] : []),
    '',
    '[wireguard]',
    `private-key=${privateKey}`,
    'private-key-flags=0',
    ...(i.mtu ? [`mtu=${i.mtu}`] : []),
    '',
    `[wireguard-peer.${p.public_key}]`,
    `endpoint=${p.endpoint}`,
    `allowed-ips=${list(p.allowed_ips)}`,
    ...(p.persistent_keepalive ? [`persistent-keepalive=${p.persistent_keepalive}`] : []),
    '',
    '[ipv4]',
    ...(v4.length ? ['method=manual', ...v4.map((a, n) => `address${n + 1}=${a}`)] : ['method=disabled']),
    ...(i.dns.filter((d) => !d.includes(':')).length ? [`dns=${list(i.dns.filter((d) => !d.includes(':')))}`] : []),
    ...(i.dns_search.length ? [`dns-search=${list(i.dns_search)}`] : []),
    // Full tunnel: the tunnel's DNS is used exclusively, so queries do not leak to the local network's resolver.
    ...(full && i.dns.length ? ['dns-priority=-50'] : []),
    '',
    '[ipv6]',
    ...(v6.length ? ['method=manual', ...v6.map((a, n) => `address${n + 1}=${a}`)] : ['addr-gen-mode=default', 'method=disabled']),
    ...(i.dns.filter((d) => d.includes(':')).length ? [`dns=${list(i.dns.filter((d) => d.includes(':')))}`] : []),
    '',
    '[proxy]',
    '',
  ];
  return lines.join('\n');
}

/**
 * nftables kill switch: outbound traffic only through the tunnel, plus the WireGuard handshake to the endpoint's
 * resolved addresses, loopback, DHCP and IPv6 neighbour discovery (so the underlying link still comes up).
 * Everything else is dropped, including DNS outside the tunnel. Loaded with `nft -f` (atomic).
 */
export function renderKillSwitch(endpointIps: string[], port: number): string {
  if (!endpointIps.length) throw new Error('NO_ENDPOINT_ADDRESS');
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('BAD_PORT');
  const v4 = endpointIps.filter((a) => /^[0-9.]+$/.test(a)), v6 = endpointIps.filter((a) => /^[0-9a-f:]+$/i.test(a) && a.includes(':'));
  if (v4.length + v6.length !== endpointIps.length) throw new Error('BAD_ENDPOINT_ADDRESS');
  return [
    '# Written by worksuite-device-agent: managed VPN kill switch. Removed when the VPN config no longer asks for it.',
    `table inet ${KILLSWITCH_TABLE}`,
    `delete table inet ${KILLSWITCH_TABLE}`,
    `table inet ${KILLSWITCH_TABLE} {`,
    '  chain output {',
    '    type filter hook output priority filter; policy drop;',
    '    oifname "lo" accept',
    `    oifname "${VPN_INTERFACE}" accept`,
    ...(v4.length ? [`    ip daddr { ${v4.join(', ')} } udp dport ${port} accept`] : []),
    ...(v6.length ? [`    ip6 daddr { ${v6.join(', ')} } udp dport ${port} accept`] : []),
    '    udp sport 68 udp dport 67 accept',
    '    udp sport 546 udp dport 547 accept',
    '    icmpv6 type { nd-router-solicit, nd-neighbor-solicit, nd-neighbor-advert } accept',
    '  }',
    '}',
    '',
  ].join('\n');
}

export interface NmConnection { name: string; uuid: string; type: string; active: boolean }

/** policy user_vpn=block: every VPN profile except the managed one is removed (WireGuard and NM VPN plugins). */
export function userVpnsToRemove(conns: NmConnection[], policy: Policy | null | undefined): NmConnection[] {
  if (policy?.user_vpn !== 'block') return [];
  return conns.filter((c) => (c.type === 'wireguard' || c.type === 'vpn') && c.uuid !== VPN_CONNECTION_UUID);
}

/** `nmcli -t -f NAME,UUID,TYPE,ACTIVE connection show` ('\:' and '\\' escaped in terse mode); VPN types only. */
export function parseNmConnections(text: string): NmConnection[] {
  const split = (line: string) => {
    const out: string[] = []; let cur = '';
    for (let i = 0; i < line.length; i++) {
      if (line[i] === '\\' && i + 1 < line.length) { cur += line[++i]; continue; }
      if (line[i] === ':') { out.push(cur); cur = ''; continue; }
      cur += line[i];
    }
    out.push(cur);
    return out;
  };
  return text.split('\n').filter((l) => l.trim()).map(split)
    .map(([name, uuid, type, active]) => ({ name, uuid, type, active: active === 'yes' }))
    .filter((c) => c.type === 'wireguard' || c.type === 'vpn');
}

const DAY = 86_400_000;
/** Device-side key rotation: a new keypair once the key is older than the config's key_rotation_days. */
export function rotationDue(cfg: VpnConfig | null | undefined, keyCreatedAt: number | undefined, now: number): boolean {
  const days = cfg?.enabled ? cfg.key_rotation_days : undefined;
  return !!days && !!keyCreatedAt && now - keyCreatedAt >= days * DAY;
}

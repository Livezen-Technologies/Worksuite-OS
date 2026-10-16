// Managed WireGuard VPN (WSOS-INT-001). The organization's gateway settings live here; each device registers only its
// WireGuard *public* key (the private key is generated on the device and never leaves it) and gets a tunnel address
// from the org's pool. The per-device config is signed like policies ("<key_id>:<base64 Ed25519>").
import type { DatabaseSync } from 'node:sqlite';
import { tx } from './db.ts';
import { HttpError, invalid } from './http.ts';
import { activeKey, signFlat } from './signing.ts';

export interface VpnSettings {
  endpoint: string;                 // host:port of the org's WireGuard gateway
  server_public_key: string;        // gateway's WireGuard public key
  address_pool: string;             // IPv4 CIDR the device addresses come from; .1 is the gateway
  allowed_ips: string[];            // routed through the tunnel (0.0.0.0/0 = full tunnel)
  dns?: string[];
  dns_search?: string[];
  always_on?: boolean;              // autoconnect at boot and reconnect
  kill_switch?: boolean;            // only tunnel traffic (and the endpoint) leaves the device; needs a full tunnel
  persistent_keepalive?: number;
  mtu?: number;
  key_rotation_days?: number;       // device generates a new keypair this often
}

const WG_KEY = /^[A-Za-z0-9+/]{42}[AEIMQUYcgkosw480]=$/;   // base64 of exactly 32 bytes
export const isWgKey = (v: unknown): v is string => typeof v === 'string' && WG_KEY.test(v);

const IPV4 = /^(25[0-5]|2[0-4]\d|1?\d?\d)(\.(25[0-5]|2[0-4]\d|1?\d?\d)){3}$/;
const ipToInt = (ip: string) => ip.split('.').reduce((a, o) => a * 256 + Number(o), 0);
const intToIp = (n: number) => [24, 16, 8, 0].map((s) => Math.floor(n / 2 ** s) % 256).join('.');
function cidr(v: unknown, family: 'v4' | 'any' = 'any'): v is string {
  if (typeof v !== 'string') return false;
  const [ip, len, extra] = v.split('/');
  if (extra !== undefined || len === undefined || !/^\d{1,3}$/.test(len)) return false;
  if (IPV4.test(ip)) return Number(len) <= 32;
  return family === 'any' && /^[0-9a-f:]+$/i.test(ip) && ip.includes(':') && Number(len) <= 128;
}
const ipAddr = (v: unknown) => typeof v === 'string' && (IPV4.test(v) || (/^[0-9a-f:]+$/i.test(v) && v.includes(':')));
const HOST_PORT = /^(?:\[[0-9a-f:]+\]|[A-Za-z0-9.-]{1,253}):(\d{1,5})$/i;
const DOMAIN = /^[A-Za-z0-9.-]{1,253}$/;

export function validateVpnSettings(body: unknown): VpnSettings {
  if (!body || typeof body !== 'object' || Array.isArray(body)) throw invalid('vpn', 'must be an object');
  const b = body as Record<string, unknown>;
  const known = new Set(['endpoint', 'server_public_key', 'address_pool', 'allowed_ips', 'dns', 'dns_search', 'always_on', 'kill_switch', 'persistent_keepalive', 'mtu', 'key_rotation_days']);
  for (const k of Object.keys(b)) if (!known.has(k)) throw invalid(k, 'unknown VPN field');
  const ep = typeof b.endpoint === 'string' ? HOST_PORT.exec(b.endpoint) : null;
  if (!ep || Number(ep[1]) < 1 || Number(ep[1]) > 65535) throw invalid('endpoint', 'host:port');
  if (!isWgKey(b.server_public_key)) throw invalid('server_public_key', 'WireGuard public key (base64, 32 bytes)');
  if (!cidr(b.address_pool, 'v4')) throw invalid('address_pool', 'IPv4 CIDR');
  const poolLen = Number((b.address_pool as string).split('/')[1]);
  if (poolLen > 30 || poolLen < 8) throw invalid('address_pool', 'prefix /8 to /30');
  if (!Array.isArray(b.allowed_ips) || !b.allowed_ips.length || b.allowed_ips.length > 64 || !b.allowed_ips.every((c) => cidr(c))) throw invalid('allowed_ips', 'array of CIDRs');
  const list = (k: string, ok: (v: unknown) => boolean, max = 8) => {
    if (b[k] === undefined) return undefined;
    if (!Array.isArray(b[k]) || (b[k] as unknown[]).length > max || !(b[k] as unknown[]).every(ok)) throw invalid(k, 'invalid list');
    return b[k] as string[];
  };
  const bool = (k: string) => { if (b[k] !== undefined && typeof b[k] !== 'boolean') throw invalid(k, 'boolean'); return b[k] as boolean | undefined; };
  const int = (k: string, min: number, max: number) => {
    if (b[k] === undefined) return undefined;
    if (!Number.isInteger(b[k]) || (b[k] as number) < min || (b[k] as number) > max) throw invalid(k, `integer ${min}..${max}`);
    return b[k] as number;
  };
  const out: VpnSettings = {
    endpoint: b.endpoint as string, server_public_key: b.server_public_key as string, address_pool: b.address_pool as string,
    allowed_ips: b.allowed_ips as string[], dns: list('dns', ipAddr), dns_search: list('dns_search', (v) => typeof v === 'string' && DOMAIN.test(v)),
    always_on: bool('always_on'), kill_switch: bool('kill_switch'),
    persistent_keepalive: int('persistent_keepalive', 0, 65535), mtu: int('mtu', 1280, 1500), key_rotation_days: int('key_rotation_days', 1, 365),
  };
  // A kill switch on a split tunnel would leave only the tunnel's subnets reachable: refuse rather than surprise.
  if (out.kill_switch && !out.allowed_ips.some((c) => c === '0.0.0.0/0')) throw invalid('kill_switch', 'needs a full tunnel (allowed_ips includes 0.0.0.0/0)');
  for (const k of Object.keys(out) as (keyof VpnSettings)[]) if (out[k] === undefined) delete out[k];
  return out;
}

export function getVpnSettings(db: DatabaseSync, orgId: number): { version: number; settings: VpnSettings } | null {
  const row = db.prepare('SELECT version, body FROM vpn_settings WHERE org_id = ?').get(orgId) as { version: number; body: string } | undefined;
  return row ? { version: row.version, settings: JSON.parse(row.body) as VpnSettings } : null;
}

/** null removes the org's VPN: devices remove their managed connection on the next refresh. */
export function setVpnSettings(db: DatabaseSync, orgId: number, s: VpnSettings | null): number {
  return tx(db, () => {
    const cur = db.prepare('SELECT version, body FROM vpn_settings WHERE org_id = ?').get(orgId) as { version: number; body: string } | undefined;
    const version = (cur?.version ?? 0) + 1;
    if (!s) { db.prepare('DELETE FROM vpn_settings WHERE org_id = ?').run(orgId); db.prepare('DELETE FROM vpn_peers WHERE org_id = ?').run(orgId); return version; }
    // A new pool invalidates existing addresses; devices keep their keys and get a new address.
    if (cur && (JSON.parse(cur.body) as VpnSettings).address_pool !== s.address_pool) db.prepare('UPDATE vpn_peers SET address = NULL WHERE org_id = ?').run(orgId);
    db.prepare('INSERT INTO vpn_settings (org_id, version, body) VALUES (?, ?, ?) ON CONFLICT(org_id) DO UPDATE SET version = excluded.version, body = excluded.body')
      .run(orgId, version, JSON.stringify(s));
    return version;
  });
}

/** Lowest free host address in the pool; .1 (network + 1) is the gateway, network and broadcast are skipped. */
function allocate(db: DatabaseSync, orgId: number, pool: string): string {
  const [net, len] = pool.split('/');
  const size = 2 ** (32 - Number(len));
  const base = ipToInt(net) - (ipToInt(net) % size);
  const used = new Set((db.prepare('SELECT address FROM vpn_peers WHERE org_id = ? AND address IS NOT NULL').all(orgId) as { address: string }[]).map((r) => r.address));
  for (let i = 2; i < size - 1; i++) {
    const a = intToIp(base + i);
    if (!used.has(a)) return a;
  }
  throw new HttpError(409, 'VPN_POOL_EXHAUSTED', 'no free address in the VPN pool');
}

/** Device registers (or rotates) its WireGuard public key; the address is assigned on the next config fetch. */
export function registerPeer(db: DatabaseSync, orgId: number, deviceId: string, publicKey: string): void {
  if (!isWgKey(publicKey)) throw invalid('public_key', 'WireGuard public key (base64, 32 bytes)');
  // Not wrapped in tx: enrolment calls this inside its own transaction; public_key is UNIQUE either way.
  const taken = db.prepare('SELECT device_id FROM vpn_peers WHERE public_key = ? AND device_id != ?').get(publicKey, deviceId);
  if (taken) throw new HttpError(409, 'VPN_KEY_IN_USE', 'this WireGuard key belongs to another device');
  db.prepare(`INSERT INTO vpn_peers (device_id, org_id, public_key, address, updated) VALUES (?, ?, ?, NULL, ?)
    ON CONFLICT(device_id) DO UPDATE SET public_key = excluded.public_key, updated = excluded.updated`).run(deviceId, orgId, publicKey, Date.now());
}

export function removePeer(db: DatabaseSync, deviceId: string): boolean {
  return db.prepare('DELETE FROM vpn_peers WHERE device_id = ?').run(deviceId).changes > 0;
}

/** Peers for the gateway (wg set / wg syncconf): active devices only. */
export function gatewayPeers(db: DatabaseSync, orgId: number) {
  return db.prepare(`SELECT p.device_id, d.hostname, p.public_key, p.address, p.updated FROM vpn_peers p JOIN devices d ON d.id = p.device_id
    WHERE p.org_id = ? AND d.revoked = 0 AND p.address IS NOT NULL ORDER BY p.address`).all(orgId) as
    { device_id: string; hostname: string; public_key: string; address: string; updated: number }[];
}

/**
 * The signed per-device config. No org VPN → `{enabled: false}` (signed too, so the device can trust the removal).
 * No registered key → 409 VPN_PEER_KEY_REQUIRED: the device generates a keypair and PUTs the public half.
 */
export function deviceVpnConfig(db: DatabaseSync, orgId: number, deviceId: string, now = Date.now()) {
  const key = activeKey(db);
  const cfg = getVpnSettings(db, orgId);
  const issued_at = new Date(now).toISOString();
  if (!cfg) return signFlat(key, { device_id: deviceId, enabled: false, version: '0', issued_at });
  const peer = tx(db, () => {
    const p = db.prepare('SELECT public_key, address FROM vpn_peers WHERE device_id = ?').get(deviceId) as { public_key: string; address: string | null } | undefined;
    if (!p) return undefined;
    if (!p.address) { p.address = allocate(db, orgId, cfg.settings.address_pool); db.prepare('UPDATE vpn_peers SET address = ? WHERE device_id = ?').run(p.address, deviceId); }
    return p;
  });
  if (!peer) throw new HttpError(409, 'VPN_PEER_KEY_REQUIRED', 'register this device\'s WireGuard public key first');
  const s = cfg.settings;
  return signFlat(key, {
    device_id: deviceId, enabled: true, version: String(cfg.version), issued_at,
    device_public_key: peer.public_key,
    interface: { address: [`${peer.address}/32`], dns: s.dns ?? [], dns_search: s.dns_search ?? [], ...(s.mtu ? { mtu: s.mtu } : {}) },
    peer: { public_key: s.server_public_key, endpoint: s.endpoint, allowed_ips: s.allowed_ips, persistent_keepalive: s.persistent_keepalive ?? 25 },
    always_on: s.always_on ?? false, kill_switch: s.kill_switch ?? false,
    ...(s.key_rotation_days ? { key_rotation_days: s.key_rotation_days } : {}),
  });
}

// The model catalog: shape checks (Desktop's zod schema, written out), the Ed25519 envelope check (Desktop's
// LAI-MOD-002) and the organization policy filter. Every failure is an error code; the shell words it.
import { createPublicKey, verify as verifySignature } from 'node:crypto';
import { LOCAL_AI_TIERS, type AIPolicy, type LocalAICatalog, type LocalModel } from './types.ts';

export class AIError extends Error {
  readonly code: string;
  constructor(code: string, detail?: string) {
    super(detail ? `${code}: ${detail}` : code);
    this.code = code;
  }
}
export const codeOf = (e: unknown): string => (e instanceof AIError ? e.code : 'internal_error');

/** Where model files may come from when the catalog names no hosts (Desktop's CDN). */
export const DEFAULT_HOSTS = ['cdn.worksuite.app'];

const ID = /^[a-z0-9][a-z0-9._-]{1,63}$/;
const VERSION = /^[0-9A-Za-z._-]{1,32}$/;
const SHA = /^([0-9a-f]{64})?$/;
const HOST = /^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?(\.[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)+$/;

const str = (v: unknown, max: number, min = 0): v is string => typeof v === 'string' && v.length >= min && v.length <= max;
const int = (v: unknown, min: number): v is number => Number.isInteger(v) && (v as number) >= min;
const tiers = (v: unknown): v is LocalModel['tiers'] => Array.isArray(v) && v.every((t) => (LOCAL_AI_TIERS as readonly string[]).includes(t));
function httpsUrl(v: unknown): v is string {
  if (!str(v, 2048, 9)) return false;
  try { return new URL(v).protocol === 'https:'; } catch { return false; }
}

function model(raw: unknown, i: number): LocalModel {
  const bad = (field: string): never => { throw new AIError('catalog_invalid', `models[${i}].${field}`); };
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) bad('');
  const m = raw as Record<string, unknown>;
  if (!str(m.id, 64) || !ID.test(m.id)) bad('id');
  if (!str(m.version, 32) || !VERSION.test(m.version as string)) bad('version');
  if (!str(m.name, 80, 1)) bad('name');
  if (!str(m.family ?? '', 40)) bad('family');
  if (m.purpose !== 'chat' && m.purpose !== 'embedding' && m.purpose !== 'router') bad('purpose');
  if (!httpsUrl(m.url)) bad('url');
  if (!str(m.sha256, 64) || !SHA.test(m.sha256 as string)) bad('sha256');
  if (!int(m.bytes, 0) || ((m.sha256 as string) !== '' && (m.bytes as number) === 0)) bad('bytes');
  if (m.approxBytes !== undefined && !int(m.approxBytes, 1)) bad('approxBytes');
  if (!str(m.quantization ?? '', 20)) bad('quantization');
  if (!int(m.contextLength, 1)) bad('contextLength');
  if (!int(m.minMemoryBytes, 1)) bad('minMemoryBytes');
  if (!tiers(m.tiers) || !(m.tiers as unknown[]).length) bad('tiers');
  if (m.recommendedFor !== undefined && !tiers(m.recommendedFor)) bad('recommendedFor');
  const lic = m.license as Record<string, unknown> | undefined;
  if (!lic || !str(lic.id, 40) || !str(lic.name, 120, 1) || !httpsUrl(lic.url)) bad('license');
  if (m.notice !== undefined && !str(m.notice, 2000)) bad('notice');
  if (m.languages !== undefined && !(Array.isArray(m.languages) && m.languages.length <= 60 && m.languages.every((l) => str(l, 12)))) bad('languages');
  if (m.toolCalling !== undefined && typeof m.toolCalling !== 'boolean') bad('toolCalling');
  return {
    id: m.id as string, version: m.version as string, name: m.name as string, family: (m.family as string) ?? '', purpose: m.purpose as LocalModel['purpose'],
    url: m.url as string, sha256: m.sha256 as string, bytes: m.bytes as number, ...(m.approxBytes ? { approxBytes: m.approxBytes as number } : {}),
    quantization: (m.quantization as string) ?? '', contextLength: m.contextLength as number, minMemoryBytes: m.minMemoryBytes as number,
    tiers: m.tiers as LocalModel['tiers'], recommendedFor: (m.recommendedFor as LocalModel['tiers']) ?? [],
    license: { id: lic!.id as string, name: lic!.name as string, url: lic!.url as string }, ...(m.notice ? { notice: m.notice as string } : {}),
    languages: (m.languages as string[]) ?? [], toolCalling: (m.toolCalling as boolean) ?? false,
  };
}

/** A catalog body: its shape, its expiry, and every model file on an allowed host. */
export function parseCatalog(raw: unknown, now = Date.now()): LocalAICatalog {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new AIError('catalog_invalid');
  const c = raw as Record<string, unknown>;
  if (c.schema !== 1) throw new AIError('catalog_invalid', 'schema');
  if (!str(c.issuedAt, 40) || Number.isNaN(Date.parse(c.issuedAt))) throw new AIError('catalog_invalid', 'issuedAt');
  if (!str(c.expiresAt, 40) || Number.isNaN(Date.parse(c.expiresAt))) throw new AIError('catalog_invalid', 'expiresAt');
  if (Date.parse(c.expiresAt) <= now) throw new AIError('catalog_expired');
  if (c.hosts !== undefined && !(Array.isArray(c.hosts) && c.hosts.length <= 10 && c.hosts.every((h) => str(h, 253) && HOST.test(h)))) throw new AIError('catalog_invalid', 'hosts');
  if (!Array.isArray(c.models) || c.models.length > 100) throw new AIError('catalog_invalid', 'models');
  const models = c.models.map(model);
  if (new Set(models.map((m) => m.id)).size !== models.length) throw new AIError('catalog_invalid', 'duplicate id');
  const hosts = (c.hosts as string[] | undefined) ?? DEFAULT_HOSTS;
  for (const m of models) if (!hosts.includes(new URL(m.url).hostname)) throw new AIError('host_not_allowed', m.id);
  return { schema: 1, issuedAt: c.issuedAt, expiresAt: c.expiresAt, ...(c.hosts ? { hosts } : {}), models };
}

/** Desktop's signed envelope `{ body, signature, keyId }`: Ed25519 by a pinned key, then the body as above. */
export function verifyEnvelope(raw: unknown, keys: Record<string, string>, now = Date.now()): LocalAICatalog {
  const env = raw as { body?: unknown; signature?: unknown; keyId?: unknown } | null;
  if (!env || !str(env.body, 512 * 1024) || !str(env.signature, 100) || !/^[A-Za-z0-9+/=]{80,100}$/.test(env.signature) || !str(env.keyId, 40) || !/^[a-z0-9-]{1,40}$/.test(env.keyId)) {
    throw new AIError('catalog_invalid', 'envelope');
  }
  const key = keys[env.keyId];
  if (!key) throw new AIError('catalog_unknown_key');
  const ok = verifySignature(null, Buffer.from(env.body, 'utf8'), createPublicKey({ key: Buffer.from(key, 'base64'), format: 'der', type: 'spki' }), Buffer.from(env.signature, 'base64'));
  if (!ok) throw new AIError('catalog_bad_signature');
  let body: unknown;
  try { body = JSON.parse(env.body); } catch { throw new AIError('catalog_invalid', 'body'); }
  return parseCatalog(body, now);
}

/** The organization's AI policy file, as the device agent writes it. Missing = not managed. Unreadable = off. */
export function parsePolicy(text: string | null): AIPolicy {
  if (text === null) return { managed: false, enabled: true, models: null };
  try {
    const p = JSON.parse(text) as { enabled?: unknown; models?: unknown };
    const models = Array.isArray(p.models) ? p.models.filter((x): x is string => typeof x === 'string' && ID.test(x)).slice(0, 100) : null;
    return { managed: true, enabled: p.enabled !== false, models };
  } catch {
    // A policy file that cannot be read must not open up what it may have closed.
    return { managed: true, enabled: false, models: [] };
  }
}

export const allowedBy = (policy: AIPolicy, id: string): boolean => policy.enabled && (policy.models === null || policy.models.includes(id));

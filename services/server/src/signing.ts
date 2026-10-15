// Ed25519 signing for policies, commands and release manifests. Same canonical JSON as the clients
// (services/device-agent/src/commands.ts, services/package-service/src/updates.ts): sorted keys, no whitespace.
import { createPrivateKey, generateKeyPairSync, randomBytes, sign } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';

export function canonical(v: unknown): string {
  if (v === null || typeof v !== 'object') return JSON.stringify(v);
  if (Array.isArray(v)) return `[${v.map(canonical).join(',')}]`;
  const o = v as Record<string, unknown>;
  return `{${Object.keys(o).sort().filter((k) => o[k] !== undefined).map((k) => `${JSON.stringify(k)}:${canonical(o[k])}`).join(',')}}`;
}

export interface SigningKey { key_id: string; public_pem: string; private_pem: string }

export function createKey(db: DatabaseSync): SigningKey {
  const { publicKey, privateKey } = generateKeyPairSync('ed25519');
  const k = {
    key_id: `ws-${new Date().toISOString().slice(0, 10).replaceAll('-', '')}-${randomBytes(3).toString('hex')}`,
    public_pem: publicKey.export({ type: 'spki', format: 'pem' }).toString(),
    private_pem: privateKey.export({ type: 'pkcs8', format: 'pem' }).toString(),
  };
  db.prepare('INSERT INTO signing_keys (key_id, private_pem, public_pem, created) VALUES (?, ?, ?, ?)').run(k.key_id, k.private_pem, k.public_pem, Date.now());
  return k;
}

/** Newest key signs; older keys stay exportable so devices keep trusting them during rotation. */
export function activeKey(db: DatabaseSync): SigningKey {
  const k = db.prepare('SELECT key_id, public_pem, private_pem FROM signing_keys ORDER BY created DESC, rowid DESC LIMIT 1').get() as SigningKey | undefined;
  return k ?? createKey(db);
}

const sig = (k: SigningKey, body: Record<string, unknown>) =>
  sign(null, Buffer.from(canonical(body)), createPrivateKey(k.private_pem)).toString('base64');

/** Policies and manifests: `signature: "<key_id>:<base64>"`. */
export function signFlat<T extends Record<string, unknown>>(k: SigningKey, body: T): T & { signature: string } {
  const { signature: _s, ...rest } = body;
  return { ...(rest as T), signature: `${k.key_id}:${sig(k, rest)}` };
}

/** Command envelopes: `signature: {alg, key_id, value}`. */
export function signEnvelope<T extends Record<string, unknown>>(k: SigningKey, body: T) {
  const { signature: _s, ...rest } = body;
  return { ...rest, signature: { alg: 'ed25519' as const, key_id: k.key_id, value: sig(k, rest) } };
}

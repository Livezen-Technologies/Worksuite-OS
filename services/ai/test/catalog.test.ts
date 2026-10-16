import { test } from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync, sign } from 'node:crypto';
import { AIError, allowedBy, parseCatalog, parsePolicy, verifyEnvelope } from '../src/catalog.ts';
import { autoThreads } from '../src/hardware.ts';
import { tierFor } from '../src/types.ts';
import { catalogBody } from './helpers.ts';

const code = (fn: () => unknown) => { try { fn(); } catch (e) { return (e as AIError).code; } return 'no error'; };
const withModel = (over: Record<string, unknown>) => catalogBody({}, [{ ...(catalogBody().models[0] as object), ...over }]);

test('a catalog with pinned models parses', () => {
  const c = parseCatalog(catalogBody());
  assert.equal(c.models[0]!.id, 'qwen3.5-0.8b-q4');
  assert.deepEqual(c.models[0]!.recommendedFor, ['minimal', 'basic']);
});

test('model files only over https, from an allowed host, with a SHA-256', () => {
  assert.equal(code(() => parseCatalog(withModel({ url: 'http://cdn.worksuite.app/m.gguf' }))), 'catalog_invalid');
  assert.equal(code(() => parseCatalog(withModel({ url: 'https://evil.example/m.gguf' }))), 'host_not_allowed');
  assert.equal(parseCatalog({ ...withModel({ url: 'https://models.example.org/m.gguf' }), hosts: ['models.example.org'] }).models.length, 1);
  assert.equal(code(() => parseCatalog(withModel({ sha256: 'abc' }))), 'catalog_invalid');
  assert.equal(code(() => parseCatalog(withModel({ sha256: 'A'.repeat(64) }))), 'catalog_invalid');
  // A checksum without a size cannot be verified.
  assert.equal(code(() => parseCatalog(withModel({ bytes: 0 }))), 'catalog_invalid');
  // Not published yet: listed, never downloaded.
  assert.equal(parseCatalog(withModel({ sha256: '', bytes: 0, approxBytes: 5e8 })).models[0]!.sha256, '');
});

test('expired, malformed and duplicate catalogs are refused', () => {
  assert.equal(code(() => parseCatalog(catalogBody({ expiresAt: '2020-01-01T00:00:00Z' }))), 'catalog_expired');
  assert.equal(code(() => parseCatalog(catalogBody({ schema: 2 }))), 'catalog_invalid');
  assert.equal(code(() => parseCatalog([])), 'catalog_invalid');
  const m = catalogBody().models[0];
  assert.equal(code(() => parseCatalog(catalogBody({}, [m, m]))), 'catalog_invalid');
  assert.equal(code(() => parseCatalog(withModel({ id: '../etc' }))), 'catalog_invalid');
  assert.equal(code(() => parseCatalog(withModel({ tiers: ['huge'] }))), 'catalog_invalid');
});

test("Desktop's signed envelope: a pinned key's signature, else refused", () => {
  const { publicKey, privateKey } = generateKeyPairSync('ed25519');
  const keys = { 'ws-2026': publicKey.export({ type: 'spki', format: 'der' }).toString('base64') };
  const body = JSON.stringify(catalogBody());
  const env = { body, signature: sign(null, Buffer.from(body), privateKey).toString('base64'), keyId: 'ws-2026' };
  assert.equal(verifyEnvelope(env, keys).models.length, 1);
  assert.equal(code(() => verifyEnvelope({ ...env, body: body.replace('Qwen3.5 0.8B', 'Qwen3.5 0.8B!') }, keys)), 'catalog_bad_signature');
  assert.equal(code(() => verifyEnvelope({ ...env, keyId: 'other' }, keys)), 'catalog_unknown_key');
  assert.equal(code(() => verifyEnvelope({ body }, keys)), 'catalog_invalid');
});

test('policy: missing = unmanaged, off, allow-list, unreadable = closed', () => {
  assert.deepEqual(parsePolicy(null), { managed: false, enabled: true, models: null });
  assert.deepEqual(parsePolicy('{"enabled":false}'), { managed: true, enabled: false, models: null });
  const p = parsePolicy('{"enabled":true,"models":["qwen3.5-2b-q4","../x"]}');
  assert.deepEqual(p.models, ['qwen3.5-2b-q4']);
  assert.equal(allowedBy(p, 'qwen3.5-2b-q4'), true);
  assert.equal(allowedBy(p, 'qwen3.5-9b-q4'), false);
  assert.deepEqual(parsePolicy('not json'), { managed: true, enabled: false, models: [] });
});

test("tiers (Desktop's thresholds) and the auto thread count", () => {
  const GB = 1024 ** 3;
  assert.equal(tierFor(4 * GB, 0, false), 'minimal');
  assert.equal(tierFor(8 * GB, 0, false), 'basic');
  assert.equal(tierFor(8 * GB, 8 * GB, 'vulkan'), 'good');
  assert.equal(tierFor(32 * GB, 0, false), 'strong');
  assert.deepEqual([1, 2, 4, 8, 16, 64].map(autoThreads), [1, 1, 3, 6, 12, 16]);
});

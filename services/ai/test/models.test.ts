import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, readFile, stat, writeFile, appendFile } from 'node:fs/promises';
import { join } from 'node:path';
import { LocalAIModelManager } from '../src/models.ts';
import { restrictedFetch } from '../src/fetch.ts';
import type { AIPolicy } from '../src/types.ts';
import { MODEL_BYTES, SHA, catalogBody, fileFetch, tmpRoot, unmanaged } from './helpers.ts';

const ID = 'qwen3.5-0.8b-q4';
async function setup(opts: { fetch?: ReturnType<typeof fileFetch>; policy?: AIPolicy; catalog?: unknown } = {}) {
  const t = await tmpRoot(opts.catalog);
  const f = opts.fetch ?? fileFetch();
  let policy = opts.policy ?? unmanaged;
  const m = new LocalAIModelManager({ root: t.root, systemRoot: t.systemRoot, catalogFiles: [join(t.dir, 'missing.json'), t.catalogFile], policy: () => policy, fetch: f.fn });
  await m.init();
  return { m, t, f, setPolicy: (p: AIPolicy) => { policy = p; } };
}
const view = async (m: LocalAIModelManager) => (await m.list(null)).find((v) => v.model.id === ID)!;

test('downloads over https, verifies the SHA-256, installs and becomes the default', async () => {
  const { m, t, f } = await setup();
  assert.equal((await view(m)).state, 'available');
  await m.install(ID);
  const v = await view(m);
  assert.equal(v.state, 'installed');
  assert.equal(v.isDefault, true);
  assert.equal(f.calls[0]!.url, 'https://cdn.worksuite.app/local-ai/models/qwen3.5-0.8b-q4.gguf');
  const file = join(t.root, 'models', ID, '1', 'model.gguf');
  assert.deepEqual(await readFile(file), MODEL_BYTES);
  assert.equal((await stat(file)).mode & 0o777, 0o600);
  assert.equal(await m.path(ID), file);
});

test('a file that does not match its pinned hash is thrown away, never installed', async () => {
  const bad = Buffer.from(MODEL_BYTES); bad[10] = 0x41;
  const { m, t } = await setup({ fetch: fileFetch(bad) });
  await m.install(ID);
  const v = await view(m);
  assert.equal(v.state, 'failed');
  assert.equal(v.error, 'mismatch');
  await assert.rejects(stat(join(t.root, 'models', ID, '1', 'model.gguf.part')));
  assert.equal(await m.path(ID), null);
});

test('a dropped download is kept, then resumed with a Range request', async () => {
  const first = fileFetch(MODEL_BYTES, { failAfter: 1000 });
  const { m, t } = await setup({ fetch: first });
  await m.install(ID);
  let v = await view(m);
  assert.equal(v.state, 'failed');
  assert.equal(v.error, 'connection');
  assert.equal((await stat(join(t.root, 'models', ID, '1', 'model.gguf.part'))).size, 1000);
  const resumed = new LocalAIModelManager({ root: t.root, catalogFiles: [t.catalogFile], policy: () => unmanaged, fetch: fileFetch().fn });
  await resumed.init();
  assert.equal((await view(resumed)).state, 'paused');
  const f2 = fileFetch();
  const r2 = new LocalAIModelManager({ root: t.root, catalogFiles: [t.catalogFile], policy: () => unmanaged, fetch: f2.fn });
  await r2.init();
  await r2.install(ID);
  assert.equal(f2.calls[0]!.range, 'bytes=1000-');
  v = await view(r2);
  assert.equal(v.state, 'installed');
});

test('pause keeps the partial file; discard deletes it', async () => {
  const { m, t } = await setup({ fetch: fileFetch(MODEL_BYTES, { failAfter: 100 }) });
  await m.install(ID);
  await m.cancel(ID, false);
  assert.equal((await stat(join(t.root, 'models', ID, '1', 'model.gguf.part'))).size, 100);
  await m.cancel(ID, true);
  await assert.rejects(stat(join(t.root, 'models', ID, '1', 'model.gguf.part')));
  assert.equal((await view(m)).state, 'available');
});

test('a server that ignores the range starts again from the beginning', async () => {
  const t = await tmpRoot();
  await mkdir(join(t.root, 'models', ID, '1'), { recursive: true });
  await writeFile(join(t.root, 'models', ID, '1', 'model.gguf.part'), MODEL_BYTES.subarray(0, 50));
  const m = new LocalAIModelManager({ root: t.root, catalogFiles: [t.catalogFile], policy: () => unmanaged, fetch: fileFetch(MODEL_BYTES, { ignoreRange: true }).fn });
  await m.init();
  await m.install(ID);
  assert.equal((await view(m)).state, 'installed');
});

test('a model whose checksum is not published is listed but never downloaded', async () => {
  const body = catalogBody({}, [{ ...(catalogBody().models[0] as object), sha256: '', bytes: 0, approxBytes: 530_000_000 }]);
  const { m, f } = await setup({ catalog: body });
  assert.equal((await view(m)).state, 'unpublished');
  assert.throws(() => m.install(ID), /unpublished/);
  assert.equal(f.calls.length, 0);
});

test('the file is hashed again before loading: a changed file is refused', async () => {
  const { m, t } = await setup();
  await m.install(ID);
  await appendFile(join(t.root, 'models', ID, '1', 'model.gguf'), 'tampered');
  await assert.rejects(m.path(ID), /mismatch_installed/);
  assert.equal(await m.check(ID), false);
});

test('organization policy hides and refuses models, and AI off refuses all', async () => {
  const { m, setPolicy } = await setup();
  setPolicy({ managed: true, enabled: true, models: ['qwen3.5-2b-q4'] });
  assert.equal((await m.list(null)).length, 0);
  assert.throws(() => m.install(ID), /model_not_allowed/);
  setPolicy({ managed: true, enabled: false, models: null });
  assert.throws(() => m.install(ID), /model_not_allowed/);
});

test("an administrator's model for everyone is used, and survives this person's Remove", async () => {
  const { m, t } = await setup();
  await mkdir(join(t.systemRoot, ID, '1'), { recursive: true });
  await writeFile(join(t.systemRoot, ID, '1', 'model.gguf'), MODEL_BYTES);
  const v = await view(m);
  assert.equal(v.state, 'installed');
  assert.equal(v.system, true);
  assert.equal(await m.path(ID), join(t.systemRoot, ID, '1', 'model.gguf'));
  await m.remove(ID);
  assert.equal((await view(m)).state, 'installed');
});

test('settings persist, with an atomic 0600 file', async () => {
  const { m, t } = await setup();
  await m.setUserSettings({ threads: 6, gpu: false, enabled: false });
  const again = new LocalAIModelManager({ root: t.root, catalogFiles: [t.catalogFile], policy: () => unmanaged, fetch: fileFetch().fn });
  await again.init();
  assert.deepEqual(again.userSettings(), { enabled: false, threads: 6, gpu: false });
  assert.equal((await stat(join(t.root, 'settings.json'))).mode & 0o777, 0o600);
  assert.equal(SHA.length, 64);
});

test('downloads reach only the allowed hosts, redirects included', async () => {
  const seen: string[] = [];
  const base = (async (url: string) => {
    seen.push(url);
    if (url.includes('/redirect-ok')) return new Response(null, { status: 302, headers: { location: 'https://cdn.worksuite.app/final' } });
    if (url.includes('/redirect-bad')) return new Response(null, { status: 302, headers: { location: 'https://tracker.example/x' } });
    return new Response('ok');
  }) as unknown as typeof fetch;
  const f = restrictedFetch(() => ['cdn.worksuite.app'], base);
  assert.equal(await (await f('https://cdn.worksuite.app/redirect-ok')).text(), 'ok');
  await assert.rejects(f('https://cdn.worksuite.app/redirect-bad'), /host_not_allowed/);
  await assert.rejects(f('http://cdn.worksuite.app/x'), /host_not_allowed/);
  await assert.rejects(f('https://example.com/x'), /host_not_allowed/);
  assert.ok(!seen.some((u) => u.includes('tracker.example') || u.includes('example.com')));
});

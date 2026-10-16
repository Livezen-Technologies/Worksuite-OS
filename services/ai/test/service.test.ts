import { test } from 'node:test';
import assert from 'node:assert/strict';
import { statSync } from 'node:fs';
import { join } from 'node:path';
import { LocalAIModelManager } from '../src/models.ts';
import { LocalAIRuntime } from '../src/runtime.ts';
import { AIService, LIMITS, validateAsk } from '../src/server.ts';
import type { AIPolicy } from '../src/types.ts';
import { FakeEngine, client, fileFetch, tmpRoot, unmanaged } from './helpers.ts';

const ID = 'qwen3.5-0.8b-q4';
async function service(opts: { policy?: AIPolicy; install?: boolean; loadError?: string; slow?: number } = {}) {
  const t = await tmpRoot();
  let policy = opts.policy ?? unmanaged;
  const engines: FakeEngine[] = [];
  let svc: AIService | null = null;
  const models = new LocalAIModelManager({ root: t.root, catalogFiles: [t.catalogFile], policy: () => policy, fetch: fileFetch().fn, onChange: () => svc?.changed() });
  await models.init();
  const runtime = new LocalAIRuntime({ spawn: async () => { const e = new FakeEngine(); e.loadError = opts.loadError ?? null; e.slow = opts.slow ?? 0; engines.push(e); return e; }, models, modelsRoot: t.root, options: () => ({ gpu: false, threads: 2 }), idleMs: 60_000 });
  svc = new AIService({ models, runtime, policy: () => policy });
  if (opts.install !== false) { await models.install(ID); await models.testEnded(ID, null); }
  const path = join(t.dir, 'ai.sock');
  const server = svc.serve(path);
  await new Promise((r) => setTimeout(r, 30));
  const c = await client(path);
  return { c, path, server, engines, models, runtime, setPolicy: (p: AIPolicy) => { policy = p; }, end: () => { c.close(); server.close(); } };
}
const ask = (id: string, content = 'What is on my calendar?', extra: Record<string, unknown> = {}) => ({ id, messages: [{ role: 'system', content: 'Be brief.' }, { role: 'user', content }], ...extra });

test('the socket is 0600 and answers Status', async () => {
  const s = await service();
  assert.equal(statSync(s.path).mode & 0o777, 0o600);
  const r = await s.c.call('Status');
  assert.equal((r.result as { runtime: string }).runtime, 'off');
  assert.equal((r.result as { policy: AIPolicy }).policy.managed, false);
  s.end();
});

test('Ask streams chunks, then done; the model was hash-checked and loaded first', async () => {
  const s = await service();
  const r = await s.c.call('Ask', ask('req-00000001'));
  assert.equal(r.result, true);
  const chunks: string[] = [];
  for (;;) {
    const m = (await s.c.next((l) => 'stream' in l)).stream as { type: string; text: string };
    if (m.type === 'chunk') chunks.push(m.text);
    else { assert.equal(m.type, 'done'); assert.equal(m.text, 'Hello from this computer.'); break; }
  }
  assert.deepEqual(chunks, ['Hello', ' from', ' this', ' computer.']);
  const e = s.engines[0]!;
  assert.deepEqual(e.posted[0], { type: 'init', opts: { gpu: false, threads: 2 } });
  assert.equal(e.posted[1]!.type, 'load');
  s.end();
});

test('CancelAsk stops an answer part-way, marked cancelled', async () => {
  const s = await service();
  await s.c.call('Ask', ask('req-00000002'));
  await s.c.next((l) => 'stream' in l);
  s.engines[0]!.slow = 30;
  await s.c.call('Ask', ask('req-00000003'));
  await s.c.call('CancelAsk', { id: 'req-00000003' });
  const done = await s.c.next((l) => (l.stream as { id?: string; type?: string })?.id === 'req-00000003' && (l.stream as { type: string }).type === 'done');
  assert.equal((done.stream as { cancelled: boolean }).cancelled, true);
  s.end();
});

test('a client that hangs up cancels its answer', async () => {
  const s = await service();
  await s.c.call('Ask', ask('req-00000004'));
  await s.c.next((l) => (l.stream as { type?: string })?.type === 'done');
  s.engines[0]!.slow = 50;
  await s.c.call('Ask', ask('req-00000005'));
  s.c.close();
  await new Promise((r) => setTimeout(r, 120));
  assert.ok(s.engines[0]!.cancelled.has('req-00000005'));
  s.server.close();
});

test('malformed and oversized requests are refused', async () => {
  const s = await service();
  s.c.raw('not json\n');
  assert.equal((await s.c.next((l) => l.error === 'bad_request')).error, 'bad_request');
  assert.equal((await s.c.call('Shutdown')).error, 'bad_request');
  assert.equal((await s.c.call('Status', [1])).error, 'invalid_argument');
  for (const p of [
    { id: 'x', messages: [{ role: 'user', content: 'hi' }] },
    { id: 'req-00000010', messages: [] },
    { id: 'req-00000011', messages: [{ role: 'root', content: 'hi' }] },
    { id: 'req-00000012', messages: [{ role: 'user', content: 'hi', extra: 1 }] },
    { id: 'req-00000013', messages: [{ role: 'assistant', content: 'hi' }] },
    { id: 'req-00000014', messages: [{ role: 'user', content: 'hi' }], maxTokens: 100000 },
    { id: 'req-00000015', messages: [{ role: 'user', content: 'hi' }], temperature: 9 },
    { id: 'req-00000016', messages: [{ role: 'user', content: 'hi' }], tools: [] },
    { id: 'req-00000017', messages: Array.from({ length: LIMITS.messages + 1 }, () => ({ role: 'user', content: 'hi' })) },
  ]) { const r = await s.c.call("Ask", p); assert.equal(r.error, "invalid_argument", JSON.stringify(p).slice(0, 80)); }
  assert.equal((await s.c.call('Ask', ask('req-00000018', 'x'.repeat(LIMITS.content + 1)))).error, 'too_large');
  assert.equal((await s.c.call('Install', { id: '../../etc' })).error, 'invalid_argument');
  assert.equal((await s.c.call('SetSettings', { threads: -1 })).error, 'invalid_argument');
  assert.equal((await s.c.call('SetSettings', { shell: 'x' })).error, 'invalid_argument');
  // A line beyond the limit closes the connection.
  s.c.raw('{"method":"Status","params":{"x":"' + 'a'.repeat(LIMITS.line + 10) + '"}}\n');
  assert.equal((await s.c.next((l) => l.error === 'too_large')).error, 'too_large');
  s.end();
});

test('validateAsk keeps only what is allowed', () => {
  assert.deepEqual(validateAsk({ id: 'abcdefgh', messages: [{ role: 'user', content: 'hi' }], maxTokens: 10 }), { id: 'abcdefgh', messages: [{ role: 'user', content: 'hi' }], maxTokens: 10 });
});

test('off by the organization or by the person: nothing is asked or downloaded', async () => {
  const s = await service();
  s.setPolicy({ managed: true, enabled: false, models: null });
  assert.equal((await s.c.call('Ask', ask('req-00000020'))).error, 'disabled_by_policy');
  assert.equal((await s.c.call('Install', { id: ID })).error, 'disabled_by_policy');
  s.setPolicy(unmanaged);
  await s.c.call('SetSettings', { enabled: false });
  assert.equal((await s.c.call('Ask', ask('req-00000021'))).error, 'disabled');
  assert.equal(s.engines.length, 0);
  s.end();
});

test('no model yet: Ask says so, it does not make an answer up', async () => {
  const s = await service({ install: false });
  assert.equal((await s.c.call('Ask', ask('req-00000030'))).error, 'no_model');
  s.end();
});

test('the engine crashing fails the answer; out of memory is told apart; 4 crashes stop it', async () => {
  const s = await service({ slow: 500 });
  for (let i = 0; i < 4; i++) {
    const id = `req-0000004${i}`;
    assert.equal((await s.c.call('Ask', ask(id))).result, true);
    const why = i === 1 ? 'oom' : 'exit';
    s.engines.at(-1)!.crash(why);
    const err = await s.c.next((l) => (l.stream as { id?: string })?.id === id && (l.stream as { type: string }).type !== 'chunk');
    assert.deepEqual(err.stream, { id, type: 'error', code: why === 'oom' ? 'out_of_memory' : 'crashed' });
  }
  const st = (await s.c.call('Status')).result as { runtime: string; error: string };
  assert.equal(st.runtime, 'error');
  assert.equal(st.error, 'crash_loop');
  assert.equal((await s.c.call('Ask', ask('req-00000050'))).error, 'crash_loop');
  await s.c.call('Restart');
  assert.equal(((await s.c.call('Status')).result as { runtime: string }).runtime, 'off');
  s.end();
});

test('a model that will not load fails its test with the reason, and is not offered', async () => {
  const s = await service({ loadError: 'out_of_memory' });
  assert.equal((await s.c.call('Test', { id: ID })).result, false);
  const v = ((await s.c.call('Models')).result as { readiness: string; readinessError: string }[])[0]!;
  assert.equal(v.readiness, 'failed');
  assert.equal(v.readinessError, 'out_of_memory');
  assert.equal((await s.c.call('Ask', ask('req-00000070'))).error, 'model_not_ready');
  s.end();
});

test('Watch tells a client when something changed', async () => {
  const s = await service();
  await s.c.call('Watch');
  await s.c.call('SetSettings', { threads: 4 });
  await s.c.next((l) => l.changed === true);
  s.end();
});

test('prompts and answers are never written to the logs', async () => {
  const out: string[] = [];
  const keep = { log: console.log, error: console.error, warn: console.warn, write: process.stderr.write.bind(process.stderr), owrite: process.stdout.write.bind(process.stdout) };
  console.log = console.error = console.warn = (...a: unknown[]) => { out.push(a.join(' ')); };
  process.stderr.write = ((c: string) => { out.push(String(c)); return true; }) as typeof process.stderr.write;
  try {
    const s = await service();
    await s.c.call('Ask', ask('req-00000060', 'SECRET-QUESTION-42'));
    await s.c.next((l) => (l.stream as { type?: string })?.type === 'done');
    s.end();
  } finally {
    Object.assign(console, { log: keep.log, error: keep.error, warn: keep.warn });
    process.stderr.write = keep.write;
  }
  assert.ok(!out.join('\n').includes('SECRET-QUESTION-42'));
  assert.ok(!out.join('\n').includes('from this computer'));
});

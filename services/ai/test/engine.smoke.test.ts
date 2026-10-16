// Real llama.cpp, end to end: worksuite-ai with the engine as a child process, a GGUF model hash-checked and loaded,
// an answer streamed and a second one cancelled. Needs a model, so it runs only when one is named:
//   python3 tools/make-tiny-gguf.py /tmp/tiny.gguf     (a random-weight model of ~0.5 MB; its answer is gibberish)
//   WORKSUITE_AI_SMOKE_MODEL=/tmp/tiny.gguf npm test
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { copyFile, mkdir, mkdtemp, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { LocalAIModelManager, sha256 } from '../src/models.ts';
import { LocalAIRuntime } from '../src/runtime.ts';
import { childEngine } from '../src/links.ts';
import { AIService } from '../src/server.ts';
import { catalogBody, client, unmanaged } from './helpers.ts';

const model = process.env.WORKSUITE_AI_SMOKE_MODEL;

test('real inference with llama.cpp through node-llama-cpp', { skip: !model && 'set WORKSUITE_AI_SMOKE_MODEL to a .gguf file', timeout: 120_000 }, async () => {
  // Short paths: a Unix socket path has to fit in 108 bytes.
  const dir = await mkdtemp('/tmp/wsai-');
  const root = join(dir, 'root');
  const id = 'smoke-model';
  await mkdir(join(root, 'models', id, '1'), { recursive: true });
  await copyFile(model!, join(root, 'models', id, '1', 'model.gguf'));
  const base = catalogBody().models[0] as Record<string, unknown>;
  await writeFile(join(dir, 'catalog.json'), JSON.stringify(catalogBody({}, [{ ...base, id, sha256: await sha256(model!), bytes: (await stat(model!)).size }])));
  let svc: AIService | null = null;
  const models = new LocalAIModelManager({ root, catalogFiles: [join(dir, 'catalog.json')], policy: () => unmanaged, fetch: () => Promise.reject(new Error('no network in this test')), onChange: () => svc?.changed() });
  await models.init();
  const entry = fileURLToPath(new URL('../src/engine-main.ts', import.meta.url));
  const runtime = new LocalAIRuntime({ spawn: childEngine(join(dir, 'e.sock'), entry), models, modelsRoot: root, options: () => ({ gpu: false, threads: 2 }) });
  svc = new AIService({ models, runtime, policy: () => unmanaged });
  const server = svc.serve(join(dir, 'ai.sock'));
  await new Promise((r) => setTimeout(r, 50));
  const c = await client(join(dir, 'ai.sock'));
  assert.equal((await c.call('SetDefault', { id })).result, true);
  assert.equal((await c.call('Test', { id }, )).result, true);
  assert.equal((await c.call('Ask', { id: 'smoke-000001', messages: [{ role: 'user', content: 'Say hello' }], maxTokens: 16 })).result, true);
  const done = await c.next((l) => (l.stream as { type?: string })?.type === 'done', 60_000);
  assert.ok((done.stream as { tokens: number }).tokens > 0);
  await c.call('Ask', { id: 'smoke-000002', messages: [{ role: 'user', content: 'Count' }], maxTokens: 4000 });
  await c.call('CancelAsk', { id: 'smoke-000002' });
  const stopped = await c.next((l) => (l.stream as { id?: string; type?: string })?.id === 'smoke-000002' && (l.stream as { type: string }).type === 'done', 60_000);
  assert.equal((stopped.stream as { cancelled: boolean }).cancelled, true);
  c.close();
  await runtime.stop();
  server.close();
});

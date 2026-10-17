import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createConnection, type Socket } from 'node:net';
import type { FromWorker, ToWorker } from '../src/protocol.ts';
import type { WorkerLink } from '../src/runtime.ts';
import type { AIPolicy } from '../src/types.ts';

export const MODEL_BYTES = Buffer.from('GGUF' + 'x'.repeat(4096));
export const SHA = createHash('sha256').update(MODEL_BYTES).digest('hex');

export function catalogBody(over: Record<string, unknown> = {}, models?: unknown[]) {
  return {
    schema: 1, issuedAt: '2026-10-01T00:00:00Z', expiresAt: '2099-01-01T00:00:00Z',
    models: models ?? [{
      id: 'qwen3.5-0.8b-q4', version: '1', name: 'Qwen3.5 0.8B', family: 'qwen3.5', purpose: 'chat',
      url: 'https://cdn.worksuite.app/local-ai/models/qwen3.5-0.8b-q4.gguf', sha256: SHA, bytes: MODEL_BYTES.length,
      quantization: 'Q4_K_M', contextLength: 262144, minMemoryBytes: 1_610_612_736, tiers: ['minimal', 'basic', 'good', 'strong'], recommendedFor: ['minimal', 'basic'],
      license: { id: 'Apache-2.0', name: 'Apache License 2.0', url: 'https://www.apache.org/licenses/LICENSE-2.0' }, languages: ['en', 'si', 'ta'], toolCalling: true,
    }],
    ...over,
  };
}

export async function tmpRoot(catalog: unknown = catalogBody()) {
  const dir = await mkdtemp(join(tmpdir(), 'wsai-'));
  const file = join(dir, 'catalog.json');
  await writeFile(file, JSON.stringify(catalog));
  await mkdir(join(dir, 'root'), { recursive: true });
  return { dir, root: join(dir, 'root'), catalogFile: file, systemRoot: join(dir, 'system') };
}

export const unmanaged: AIPolicy = { managed: false, enabled: true, models: null };

/** A fetch answering the model file (whole, or from a Range), counting calls. */
export function fileFetch(body = MODEL_BYTES, opts: { failAfter?: number; ignoreRange?: boolean } = {}) {
  const calls: { url: string; range?: string }[] = [];
  const fn = async (url: string, init?: { headers?: Record<string, string>; signal?: AbortSignal }) => {
    const range = init?.headers?.Range;
    calls.push({ url, range });
    const from = range && !opts.ignoreRange ? Number(/bytes=(\d+)-/.exec(range)![1]) : 0;
    const part = body.subarray(from);
    const cut = opts.failAfter;
    let sent = false;
    const stream = new ReadableStream<Uint8Array>({
      // The first part arrives; the connection drops on the next read (an error empties the queue, so not at once).
      pull(c) {
        if (sent) { c.error(new Error('socket hang up')); return; }
        sent = true;
        if (cut !== undefined && cut < part.length) { c.enqueue(new Uint8Array(part.subarray(0, cut))); return; }
        c.enqueue(new Uint8Array(part)); c.close();
      },
    });
    return new Response(stream, { status: from ? 206 : 200 });
  };
  return { fn, calls };
}

/** The engine, faked: answers as llama.cpp would, word by word, and stops when cancelled. */
export class FakeEngine implements WorkerLink {
  listeners: ((m: FromWorker) => void)[] = [];
  exits: ((w: 'exit' | 'oom') => void)[] = [];
  posted: ToWorker[] = [];
  loaded: string | null = null;
  cancelled = new Set<string>();
  answer = ['Hello', ' from', ' this', ' computer.'];
  loadError: string | null = null;
  slow = 0;
  emit(m: FromWorker) { for (const l of this.listeners) l(m); }
  post(m: ToWorker) {
    this.posted.push(m);
    queueMicrotask(async () => {
      if (m.type === 'init') this.emit({ type: 'ready', info: { gpu: false, vramBytes: 0, cpuCores: 4, mmap: true } });
      else if (m.type === 'load') { if (this.loadError) this.emit({ type: 'error', op: 'load', code: this.loadError }); else { this.loaded = m.path; this.emit({ type: 'loaded', path: m.path, contextLength: 4096 }); } }
      else if (m.type === 'cancel') this.cancelled.add(m.id);
      else if (m.type === 'generate') {
        let text = '';
        for (const w of this.answer) {
          if (this.slow) await new Promise((r) => setTimeout(r, this.slow));
          if (this.cancelled.has(m.req.id)) break;
          text += w;
          this.emit({ type: 'chunk', id: m.req.id, text: w });
        }
        this.emit({ type: 'done', id: m.req.id, text, tokens: text.length ? 4 : 0, ms: 1, cancelled: this.cancelled.has(m.req.id) });
      }
    });
  }
  onMessage(cb: (m: FromWorker) => void) { this.listeners.push(cb); }
  onExit(cb: (w: 'exit' | 'oom') => void) { this.exits.push(cb); }
  kill() { for (const e of this.exits) e('exit'); }
  crash(why: 'exit' | 'oom' = 'exit') { for (const e of this.exits) e(why); }
}

/** A line-JSON client for the service socket. */
export async function client(path: string) {
  const s: Socket = createConnection(path);
  await new Promise((r) => s.once('connect', r));
  s.setEncoding('utf8');
  let buf = '';
  const lines: unknown[] = [];
  const waiters: (() => void)[] = [];
  s.on('data', (c: string) => {
    buf += c;
    let i: number;
    while ((i = buf.indexOf('\n')) >= 0) { lines.push(JSON.parse(buf.slice(0, i))); buf = buf.slice(i + 1); }
    for (const w of waiters.splice(0)) w();
  });
  let n = 0;
  const next = async (pred: (m: Record<string, unknown>) => boolean, ms = 3000): Promise<Record<string, unknown>> => {
    const end = Date.now() + ms;
    for (;;) {
      const i = lines.findIndex((l) => pred(l as Record<string, unknown>));
      if (i >= 0) return lines.splice(i, 1)[0] as Record<string, unknown>;
      if (Date.now() > end) throw new Error('timeout waiting for a line');
      await new Promise<void>((r) => { waiters.push(r); setTimeout(r, 50); });
    }
  };
  return {
    sock: s,
    raw: (text: string) => s.write(text),
    call: async (method: string, params?: unknown) => { const id = ++n; s.write(JSON.stringify({ id, method, params }) + '\n'); return next((m) => m.id === id); },
    next,
    close: () => s.destroy(),
  };
}

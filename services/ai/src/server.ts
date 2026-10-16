// The worksuite-ai socket: $XDG_RUNTIME_DIR/worksuite/ai.sock, mode 0600, line-delimited JSON (as sync.sock and
// credentials.sock, SRS §10.3). Never a TCP port. Every request is checked before it reaches the models or llama.cpp:
// a malformed or oversized line is refused, and nothing a person asks or is answered is ever logged.
//
//   → {"id":1,"method":"Ask","params":{"id":"<8-64>","messages":[{"role":"user","content":"…"}]}}
//   ← {"id":1,"result":true}            then {"stream":{"id":"…","type":"chunk","text":"…"}} … {"stream":{…"type":"done"…}}
//   → {"id":2,"method":"CancelAsk","params":{"id":"…"}}
//   → {"method":"Watch"}                ← {"changed":true} whenever models or the runtime change
import { createServer, type Server, type Socket } from 'node:net';
import { chmodSync, mkdirSync, rmSync } from 'node:fs';
import { dirname } from 'node:path';
import { AIError, codeOf } from './catalog.ts';
import { readLines, writeLine } from './lines.ts';
import type { LocalAIModelManager } from './models.ts';
import type { LocalAIRuntime } from './runtime.ts';
import type { AIPolicy, LocalAIEvent, LocalAIRequest, LocalAIStatus, LocalMessage } from './types.ts';

export const LIMITS = {
  line: 256 * 1024,
  messages: 64,
  content: 32_000,
  total: 96_000,
  maxTokens: 4096,
  connections: 16,
} as const;

const REQ_ID = /^[A-Za-z0-9-]{8,64}$/;
const MODEL_ID = /^[a-z0-9][a-z0-9._-]{1,63}$/;
const METHODS = new Set(['Status', 'Models', 'Refresh', 'Install', 'Cancel', 'Remove', 'SetDefault', 'Check', 'Test', 'Restart', 'SetSettings', 'Ask', 'CancelAsk', 'Watch']);

const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
const onlyKeys = (o: Record<string, unknown>, keys: string[]) => Object.keys(o).every((k) => keys.includes(k));

/** An Ask request, checked: shape, roles, sizes, and the conversation ending with the question. */
export function validateAsk(p: unknown): LocalAIRequest {
  if (!isObj(p) || !onlyKeys(p, ['id', 'messages', 'maxTokens', 'temperature'])) throw new AIError('invalid_argument');
  if (typeof p.id !== 'string' || !REQ_ID.test(p.id)) throw new AIError('invalid_argument');
  if (!Array.isArray(p.messages) || p.messages.length < 1 || p.messages.length > LIMITS.messages) throw new AIError('invalid_argument');
  let total = 0;
  const messages: LocalMessage[] = p.messages.map((m) => {
    if (!isObj(m) || !onlyKeys(m, ['role', 'content'])) throw new AIError('invalid_argument');
    if (m.role !== 'system' && m.role !== 'user' && m.role !== 'assistant') throw new AIError('invalid_argument');
    if (typeof m.content !== 'string') throw new AIError('invalid_argument');
    if (m.content.length > LIMITS.content) throw new AIError('too_large');
    total += m.content.length;
    return { role: m.role, content: m.content };
  });
  if (total > LIMITS.total) throw new AIError('too_large');
  if (messages.at(-1)!.role !== 'user' || !messages.at(-1)!.content.trim()) throw new AIError('invalid_argument');
  if (p.maxTokens !== undefined && !(Number.isInteger(p.maxTokens) && (p.maxTokens as number) >= 1 && (p.maxTokens as number) <= LIMITS.maxTokens)) throw new AIError('invalid_argument');
  if (p.temperature !== undefined && !(typeof p.temperature === 'number' && p.temperature >= 0 && p.temperature <= 2)) throw new AIError('invalid_argument');
  return { id: p.id, messages, ...(p.maxTokens !== undefined ? { maxTokens: p.maxTokens as number } : {}), ...(p.temperature !== undefined ? { temperature: p.temperature as number } : {}) };
}

const modelId = (p: Record<string, unknown> | undefined): string => {
  const id = p?.id;
  if (typeof id !== 'string' || !MODEL_ID.test(id)) throw new AIError('invalid_argument');
  return id;
};

export interface ServiceDeps {
  models: LocalAIModelManager;
  runtime: LocalAIRuntime;
  policy: () => AIPolicy;
  /** Called when a setting that changes how the engine starts was changed (the engine restarts on next use). */
  onEngineOptionsChanged?: () => void;
}

export class AIService {
  private watchers = new Set<Socket>();
  private changeTimer: NodeJS.Timeout | null = null;
  private readonly d: ServiceDeps;
  constructor(d: ServiceDeps) { this.d = d; }

  /** Clients hear about a change at most every 250 ms (downloads report often). */
  changed(): void {
    if (this.changeTimer) return;
    this.changeTimer = setTimeout(() => {
      this.changeTimer = null;
      for (const w of this.watchers) writeLine(w, { changed: true });
    }, 250);
    this.changeTimer.unref?.();
  }

  async status(): Promise<LocalAIStatus> {
    return { ...this.d.runtime.snapshot(), hardware: await this.d.runtime.hardware(), ...(() => { const c = this.d.models.catalogState(); return { catalogError: c.error, catalogAt: c.at }; })(), policy: this.d.policy(), settings: this.d.models.userSettings() };
  }

  /** Off by the organization or by the person: nothing is loaded, downloaded or asked. */
  private gate(): void {
    if (!this.d.policy().enabled) throw new AIError('disabled_by_policy');
    if (!this.d.models.userSettings().enabled) throw new AIError('disabled');
  }

  private async test(id: string): Promise<boolean> {
    if (!(await this.d.models.path(id, false))) return false;
    this.d.models.testStarted(id);
    try {
      await this.d.runtime.probe(id);
      await this.d.models.testEnded(id, null);
      return true;
    } catch (e) {
      await this.d.models.testEnded(id, codeOf(e));
      return false;
    }
  }

  async dispatch(method: string, p: Record<string, unknown> | undefined, sock: Socket, sink: (ev: LocalAIEvent) => void): Promise<unknown> {
    switch (method) {
      case 'Status': return this.status();
      case 'Models': return this.d.models.list(await this.d.runtime.hardware());
      case 'Refresh': await this.d.models.refresh(); return true;
      case 'Install': {
        this.gate();
        const id = modelId(p);
        // The download goes on after this answers; progress comes to watchers. Once in place it is loaded and tried.
        const done = this.d.models.install(id);
        void done.then(async () => { if ((await this.d.models.list(null)).find((v) => v.model.id === id)?.state === 'installed') await this.test(id); }).catch(() => {});
        return true;
      }
      case 'Cancel': {
        const id = modelId(p);
        if (p!.discard !== undefined && typeof p!.discard !== 'boolean') throw new AIError('invalid_argument');
        await this.d.models.cancel(id, p!.discard === true);
        return true;
      }
      case 'Remove': {
        const id = modelId(p);
        if (this.d.runtime.snapshot().loaded === id) await this.d.runtime.stop();
        await this.d.models.remove(id);
        return true;
      }
      case 'SetDefault': {
        const id = modelId(p);
        await this.d.models.setDefault(id);
        return true;
      }
      case 'Check': return this.d.models.check(modelId(p));
      case 'Test': this.gate(); return this.test(modelId(p));
      case 'Restart': await this.d.runtime.reset(); return true;
      case 'SetSettings': {
        if (!isObj(p) || !onlyKeys(p, ['enabled', 'threads', 'gpu'])) throw new AIError('invalid_argument');
        if (p.enabled !== undefined && typeof p.enabled !== 'boolean') throw new AIError('invalid_argument');
        if (p.gpu !== undefined && typeof p.gpu !== 'boolean') throw new AIError('invalid_argument');
        if (p.threads !== undefined && !(Number.isInteger(p.threads) && (p.threads as number) >= 0 && (p.threads as number) <= 256)) throw new AIError('invalid_argument');
        const s = await this.d.models.setUserSettings(p as { enabled?: boolean; threads?: number; gpu?: boolean });
        // Threads and the GPU are fixed when llama.cpp starts; turning AI off gives the memory back.
        if (p.threads !== undefined || p.gpu !== undefined || p.enabled === false) await this.d.runtime.stop();
        this.d.onEngineOptionsChanged?.();
        return s;
      }
      case 'Ask': {
        this.gate();
        const req = validateAsk(p);
        await this.d.runtime.ask(req, sink);
        sock.once('close', () => this.d.runtime.dropSink(sink));
        return true;
      }
      case 'CancelAsk': {
        if (!isObj(p) || typeof p.id !== 'string' || !REQ_ID.test(p.id)) throw new AIError('invalid_argument');
        this.d.runtime.cancel(p.id);
        return true;
      }
      case 'Watch': this.watchers.add(sock); sock.once('close', () => this.watchers.delete(sock)); return true;
      default: throw new AIError('bad_request');
    }
  }

  /** One request line → its reply. Anything but a plain object with a known method is refused, never dereferenced. */
  async handleLine(line: string, sock: Socket, sink: (ev: LocalAIEvent) => void): Promise<unknown> {
    let req: unknown;
    try { req = JSON.parse(line); } catch { return { id: null, error: 'bad_request' }; }
    if (!isObj(req)) return { id: null, error: 'bad_request' };
    const id = typeof req.id === 'number' || (typeof req.id === 'string' && req.id.length <= 64) ? req.id : null;
    if (typeof req.method !== 'string' || !METHODS.has(req.method)) return { id, error: 'bad_request' };
    if (req.params !== undefined && !isObj(req.params)) return { id, error: 'invalid_argument' };
    try {
      return { id, result: await this.dispatch(req.method, req.params as Record<string, unknown> | undefined, sock, sink) };
    } catch (e) {
      return { id, error: codeOf(e) };
    }
  }

  serve(path: string): Server {
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    rmSync(path, { force: true });
    const server = createServer((sock) => {
      sock.on('error', () => {});
      const sink = (ev: LocalAIEvent) => writeLine(sock, { stream: ev });
      readLines(sock, LIMITS.line, (line) => {
        void this.handleLine(line, sock, sink).then((res) => writeLine(sock, res));
      }, () => { writeLine(sock, { id: null, error: 'too_large' }); sock.end(); });
    });
    server.maxConnections = LIMITS.connections;
    // umask first, then chmod: the socket is never reachable by another user, not even for an instant.
    const old = process.umask(0o177);
    server.listen(path, () => { process.umask(old); chmodSync(path, 0o600); });
    return server;
  }
}

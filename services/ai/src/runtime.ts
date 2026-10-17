// The runtime, ported from WorkSuite Desktop (electron/services/local-ai/runtime.ts, LAI-DSK / LAI-CORE): starts the
// engine on first use, loads the default model (after its hash check), streams each answer back to the client that
// asked, and handles the engine dying — its requests fail, the next request starts it again, and more than 3 crashes
// in 10 minutes stops Local AI until Settings › AI › Restart. An idle model is unloaded after 10 minutes.
//
// OS differences: the engine is its own systemd unit with no network (not an Electron utility process), the
// engine's options come from Settings › AI, and errors are codes (the shell words them in en/si/ta).
import { cpus, totalmem } from 'node:os';
import { statfs } from 'node:fs/promises';
import { AIError, codeOf } from './catalog.ts';
import type { EngineInfo, EngineOptions } from './engine.ts';
import { autoThreads, hasVulkan } from './hardware.ts';
import type { LocalAIModelManager } from './models.ts';
import type { FromWorker, ToWorker } from './protocol.ts';
import { tierFor, type LocalAIEvent, type LocalAIHardware, type LocalAIRequest, type LocalRuntimeState } from './types.ts';

export interface WorkerLink {
  post(m: ToWorker): void;
  onMessage(cb: (m: FromWorker) => void): void;
  /** `oom`: the engine was killed for using more memory than its limit. */
  onExit(cb: (why: 'exit' | 'oom') => void): void;
  kill(): void;
}

export interface RuntimeDeps {
  spawn: () => Promise<WorkerLink>;
  models: LocalAIModelManager;
  modelsRoot: string;
  options: () => EngineOptions;
  onChange?: () => void;
  idleMs?: number;
  startTimeoutMs?: number;
}

type Sink = (ev: LocalAIEvent) => void;
type Waiter = { resolve: () => void; reject: (e: Error) => void; timer: NodeJS.Timeout };

class WindowLimiter {
  private hits: number[] = [];
  private readonly max: number;
  private readonly windowMs: number;
  constructor(max: number, windowMs: number) { this.max = max; this.windowMs = windowMs; }
  /** Records a hit; false once more than `max` happened in the window. */
  hit(now = Date.now()): boolean { this.hits = [...this.hits.filter((t) => now - t < this.windowMs), now]; return this.hits.length <= this.max; }
  count(): number { return this.hits.length; }
  reset(): void { this.hits = []; }
}

export class LocalAIRuntime {
  private link: WorkerLink | null = null;
  private state: LocalRuntimeState = 'off';
  private error: string | null = null;
  private info: EngineInfo | null = null;
  private loadedPath: string | null = null;
  private loadedId: string | null = null;
  private pending = new Map<string, Sink>();
  private crashes = new WindowLimiter(3, 10 * 60_000);
  private idle: NodeJS.Timeout | null = null;
  private starting: Promise<void> | null = null;
  private loadWaiter: Waiter | null = null;
  private stopping = false;
  private probes = new Map<string, { timer: NodeJS.Timeout; done: (text: string, tokens: number) => void; fail: (code: string) => void }>();

  private readonly deps: RuntimeDeps;
  constructor(deps: RuntimeDeps) { this.deps = deps; }

  private set(state: LocalRuntimeState, error: string | null = this.error): void {
    this.state = state;
    this.error = error;
    this.deps.onChange?.();
  }

  snapshot(): { runtime: LocalRuntimeState; error: string | null; loaded: string | null } {
    return { runtime: this.state, error: this.error, loaded: this.loadedId };
  }

  /** This computer: memory, cores, GPU (Vulkan) and the tier the model advice uses. */
  async hardware(): Promise<LocalAIHardware> {
    const fs = await statfs(this.deps.modelsRoot).catch(() => null);
    const memoryBytes = totalmem();
    const gpu = this.info?.gpu ?? false;
    const vramBytes = this.info?.vramBytes ?? 0;
    const cores = cpus();
    return {
      platform: process.platform, arch: process.arch, memoryBytes, freeDiskBytes: fs ? fs.bavail * fs.bsize : null,
      cpuCores: this.info?.cpuCores ?? cores.length, cpuModel: cores[0]?.model?.trim() ?? '', gpu, vulkan: await hasVulkan(), vramBytes,
      tier: tierFor(memoryBytes, vramBytes, gpu), autoThreads: autoThreads(cores.length),
    };
  }

  private start(): Promise<void> {
    if (this.link) return Promise.resolve();
    if (this.state === 'error') return Promise.reject(new AIError(this.error ?? 'crash_loop'));
    this.starting ??= new Promise<void>((resolve, reject) => {
      this.set('starting');
      const timer = setTimeout(() => reject(new AIError('start_timeout')), this.deps.startTimeoutMs ?? 60_000);
      this.deps.spawn().then((link) => {
        this.link = link;
        link.onMessage((m) => {
          if (m.type === 'ready') { clearTimeout(timer); this.info = m.info; this.set('ready', null); resolve(); }
          else if (m.type === 'error' && m.op === 'init') { clearTimeout(timer); reject(new AIError(m.code)); }
          else this.onMessage(m);
        });
        link.onExit((why) => this.onExit(why));
        link.post({ type: 'init', opts: this.deps.options() });
      }, (e: unknown) => { clearTimeout(timer); reject(new AIError(codeOf(e) === 'internal_error' ? 'engine_unavailable' : codeOf(e))); });
    }).catch((e: unknown) => {
      if (this.state === 'starting') this.set('off');
      throw e;
    }).finally(() => { this.starting = null; });
    return this.starting;
  }

  private settleIfIdle(): void {
    if (!this.pending.size && !this.probes.size) { this.set('ready'); this.armIdle(); }
  }

  private onMessage(m: FromWorker): void {
    if (m.type === 'loaded' || m.type === 'unloaded' || (m.type === 'error' && m.op === 'load')) {
      const w = this.loadWaiter;
      this.loadWaiter = null;
      if (w) { clearTimeout(w.timer); if (m.type === 'error') w.reject(new AIError(m.code)); else w.resolve(); }
      return;
    }
    const id = (m.type === 'chunk' || m.type === 'done' || m.type === 'error') ? m.id : undefined;
    if (!id) return;
    const probe = this.probes.get(id);
    if (probe) {
      if (m.type === 'chunk') return;
      this.probes.delete(id);
      clearTimeout(probe.timer);
      if (m.type === 'done') probe.done(m.text, m.tokens);
      else if (m.type === 'error') probe.fail(m.code);
      this.settleIfIdle();
      return;
    }
    const sink = this.pending.get(id);
    if (m.type === 'chunk') { sink?.({ id, type: 'chunk', text: m.text }); return; }
    this.pending.delete(id);
    if (m.type === 'done') sink?.({ id, type: 'done', text: m.text, tokens: m.tokens, ms: m.ms, cancelled: m.cancelled });
    else if (m.type === 'error') sink?.({ id, type: 'error', code: m.code });
    this.settleIfIdle();
  }

  private onExit(why: 'exit' | 'oom'): void {
    this.link = null;
    this.loadedPath = null;
    this.loadedId = null;
    const code = why === 'oom' ? 'out_of_memory' : 'crashed';
    const w = this.loadWaiter;
    this.loadWaiter = null;
    if (w) { clearTimeout(w.timer); w.reject(new AIError(why === 'oom' ? 'out_of_memory' : 'crashed_loading')); }
    for (const [id, sink] of this.pending) sink({ id, type: 'error', code });
    this.pending.clear();
    for (const [, p] of this.probes) { clearTimeout(p.timer); p.fail(why === 'oom' ? 'out_of_memory' : 'crashed_testing'); }
    this.probes.clear();
    if (this.stopping) { this.stopping = false; this.set('off', null); return; }
    if (!this.crashes.hit()) this.set('error', 'crash_loop');
    else this.set('off', why === 'oom' ? 'out_of_memory' : null);
  }

  private armIdle(): void {
    if (this.idle) clearTimeout(this.idle);
    this.idle = setTimeout(() => void this.stop(), this.deps.idleMs ?? 10 * 60_000);
    this.idle.unref?.();
  }

  /** Ends the engine (idle, a model removed, settings changed); the next request starts it again. */
  async stop(): Promise<void> {
    if (this.idle) clearTimeout(this.idle);
    if (!this.link) return;
    this.stopping = true;
    this.link.kill();
  }

  /** Clears an error state (Settings › AI › Restart). */
  async reset(): Promise<void> {
    this.crashes.reset();
    await this.stop();
    this.set('off', null);
  }

  private async ensureLoaded(which?: string): Promise<void> {
    const id = which ?? this.deps.models.defaultModel();
    if (!id) throw new AIError('no_model');
    // The hash check happens here, before llama.cpp ever sees the file.
    const path = await this.deps.models.path(id);
    if (!path) throw new AIError('no_model');
    if (!which && !this.deps.models.usable(id)) throw new AIError('model_not_ready');
    await this.start();
    if (this.loadedPath === path) return;
    this.set('loading');
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new AIError('load_timeout')), 5 * 60_000);
      this.loadWaiter = { resolve, reject, timer };
      this.link!.post({ type: 'load', path });
    });
    this.loadedPath = path;
    this.loadedId = id;
    this.set('ready');
  }

  /** Asks the default model; the answer goes to `sink` as events. */
  async ask(req: LocalAIRequest, sink: Sink): Promise<void> {
    if (this.idle) clearTimeout(this.idle);
    try {
      await this.ensureLoaded();
    } catch (e) {
      if (this.state !== 'error') this.set(this.link ? 'ready' : 'off');
      throw e;
    }
    if (this.pending.has(req.id)) throw new AIError('invalid_argument');
    this.pending.set(req.id, sink);
    this.set('busy');
    this.link!.post({ type: 'generate', req });
  }

  cancel(id: string): void {
    if (this.pending.has(id)) this.link?.post({ type: 'cancel', id });
  }

  /** The readiness check (worksuite-desktop#55): loads the model and asks it for a word. */
  async probe(id: string, timeoutMs = 3 * 60_000): Promise<void> {
    if (this.idle) clearTimeout(this.idle);
    try {
      await this.ensureLoaded(id);
    } catch (e) {
      if (this.state !== 'error') this.set(this.link ? 'ready' : 'off');
      throw e;
    }
    const reqId = `probe-${Math.random().toString(36).slice(2, 12)}${Date.now().toString(36)}`;
    this.set('busy');
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => { this.probes.delete(reqId); this.link?.post({ type: 'cancel', id: reqId }); reject(new AIError('no_answer_timeout')); }, timeoutMs);
      this.probes.set(reqId, {
        timer,
        done: (text, tokens) => (tokens > 0 || text.trim() ? resolve() : reject(new AIError('empty_answer'))),
        fail: (code) => reject(new AIError(code)),
      });
      this.link!.post({ type: 'generate', req: { id: reqId, messages: [{ role: 'user', content: 'Reply with the single word: ready' }], maxTokens: 8, temperature: 0 } });
    });
  }

  /** A client that went away cancels what it asked. */
  dropSink(sink: Sink): void {
    for (const [id, s] of this.pending) if (s === sink) this.cancel(id);
  }
}

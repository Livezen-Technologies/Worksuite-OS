// The inference engine, ported from WorkSuite Desktop (electron/services/local-ai/engine.ts): llama.cpp through
// node-llama-cpp's native binding, in-process (no llama server, no port). It runs only in worksuite-ai-engine, the
// process with no network; this module has no knowledge of sockets so tests can drive it directly.
//
// OS additions: a thread count and a GPU switch from Settings › AI, and out-of-memory told apart from other failures.
import type { LocalAIRequest } from './types.ts';

type NodeLlama = typeof import('node-llama-cpp');
type Llama = Awaited<ReturnType<NodeLlama['getLlama']>>;
type Model = Awaited<ReturnType<Llama['loadModel']>>;

export interface EngineInfo { gpu: string | false; vramBytes: number; cpuCores: number; mmap: boolean }
export interface EngineOptions { gpu: boolean; threads: number }

/** Errors llama.cpp gives when it cannot get the memory it needs. */
export const isOutOfMemory = (e: unknown): boolean => /out of memory|failed to allocate|ENOMEM|insufficient memory|cannot allocate|VRAM|bad_alloc|too large for the available/i.test(String((e as Error)?.message ?? e));

export class LocalAIEngine {
  private lib: NodeLlama | null = null;
  private llama: Llama | null = null;
  private model: Model | null = null;
  private modelPath: string | null = null;
  private busy: Promise<unknown> = Promise.resolve();
  private opts: EngineOptions = { gpu: true, threads: 0 };

  /** Starts llama.cpp: Vulkan (or CUDA) when the GPU switch is on and one works, otherwise the CPU. */
  async init(opts: Partial<EngineOptions> = {}): Promise<EngineInfo> {
    this.opts = { ...this.opts, ...opts };
    if (!this.llama) {
      this.lib ??= await import('node-llama-cpp');
      const base = { build: 'never' as const, logLevel: this.lib.LlamaLogLevel.error, progressLogs: false, ...(this.opts.threads > 0 ? { maxThreads: this.opts.threads } : {}) };
      // Prebuilt binaries only: llama.cpp is never compiled on a person's computer.
      this.llama = await this.lib.getLlama({ ...base, gpu: this.opts.gpu ? 'auto' : false }).catch(async () => this.lib!.getLlama({ ...base, gpu: false }));
    }
    const vram = await this.llama.getVramState().catch(() => ({ total: 0 }));
    return { gpu: this.llama.gpu, vramBytes: vram.total, cpuCores: this.llama.cpuMathCores, mmap: this.llama.supportsMmap };
  }

  async load(path: string): Promise<{ contextLength: number }> {
    if (!this.llama) await this.init();
    if (this.modelPath === path && this.model) return { contextLength: this.model.trainContextSize };
    await this.unload();
    this.model = await this.llama!.loadModel({ modelPath: path, useMmap: this.llama!.supportsMmap, gpuLayers: this.opts.gpu ? 'auto' : 0 });
    this.modelPath = path;
    return { contextLength: this.model.trainContextSize };
  }

  loaded(): string | null { return this.modelPath; }

  async unload(): Promise<void> {
    const m = this.model;
    this.model = null;
    this.modelPath = null;
    if (m) await m.dispose();
  }

  /** One request at a time; `onChunk` gets the text as it comes; the signal stops it early. */
  generate(req: LocalAIRequest, onChunk: (text: string) => void, signal: AbortSignal): Promise<{ text: string; tokens: number; ms: number; cancelled: boolean }> {
    const run = async () => {
      if (!this.model || !this.lib) throw new Error('no_model');
      if (signal.aborted) return { text: '', tokens: 0, ms: 0, cancelled: true };
      const started = Date.now();
      const ctx = await this.model.createContext({ contextSize: { max: Math.min(8192, this.model.trainContextSize) }, ...(this.opts.threads > 0 ? { threads: this.opts.threads } : {}) });
      try {
        const system = req.messages.filter((m) => m.role === 'system').map((m) => m.content).join('\n\n');
        const turns = req.messages.filter((m) => m.role !== 'system');
        const last = turns.at(-1);
        if (!last || last.role !== 'user') throw new Error('invalid_argument');
        const session = new this.lib.LlamaChatSession({ contextSequence: ctx.getSequence(), systemPrompt: system || undefined });
        const history = session.getChatHistory();
        for (const t of turns.slice(0, -1)) history.push(t.role === 'user' ? { type: 'user', text: t.content } : { type: 'model', response: [t.content] });
        session.setChatHistory(history);
        let text = '';
        let tokens = 0;
        try {
          await session.prompt(last.content, {
            maxTokens: req.maxTokens ?? 1024,
            temperature: req.temperature ?? 0.6,
            signal,
            stopOnAbortSignal: true,
            onTextChunk: (c) => { text += c; onChunk(c); },
            onToken: (t) => { tokens += t.length; },
          });
        } catch (e) {
          if (!signal.aborted) throw e;
        }
        return { text, tokens, ms: Date.now() - started, cancelled: signal.aborted };
      } finally {
        await ctx.dispose();
      }
    };
    const next = this.busy.then(run, run);
    this.busy = next.catch(() => undefined);
    return next;
  }

  async dispose(): Promise<void> {
    await this.unload();
    await this.llama?.dispose();
    this.llama = null;
  }
}

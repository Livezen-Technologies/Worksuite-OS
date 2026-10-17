// The model manager, ported from WorkSuite Desktop (electron/services/local-ai/models.ts, LAI-MOD / LAI-DL / LAI-MGR).
//
// OS differences: the catalog is the packaged one (/usr/share/worksuite/ai/catalog.json, trusted as every packaged
// file is), an administrator's /etc/worksuite/ai-catalog.json in its place, or Desktop's signed CDN envelope when a
// key is pinned; the organization's policy hides and refuses models; models live under $XDG_DATA_HOME, and an
// administrator may put models for everyone under /var/lib/worksuite/ai/models; and every model file is checked
// against its pinned SHA-256 before llama.cpp may load it, not only after the download.
import { createHash } from 'node:crypto';
import { createReadStream, createWriteStream } from 'node:fs';
import { mkdir, readFile, rename, rm, stat, statfs, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { AIError, allowedBy, codeOf, parseCatalog, verifyEnvelope } from './catalog.ts';
import type { AIPolicy, AISettings, LocalAICatalog, LocalAIHardware, LocalModel, LocalModelReadiness, LocalModelState, LocalModelView } from './types.ts';

export interface ModelManagerDeps {
  /** $XDG_DATA_HOME/worksuite/ai: models/, settings.json, catalog-cache.json. */
  root: string;
  /** Read-only models an administrator installed for everyone (/var/lib/worksuite/ai/models). */
  systemRoot?: string | null;
  /** Catalog files, first readable wins (admin override, then packaged). */
  catalogFiles: string[];
  /** Desktop's signed CDN catalog: asked only when a key is pinned. */
  catalogUrl?: string | null;
  keys?: Record<string, string>;
  policy: () => AIPolicy;
  fetch: (url: string, init?: { headers?: Record<string, string>; signal?: AbortSignal }) => Promise<Response>;
  now?: () => number;
  onChange?: () => void;
}

interface Download {
  abort: AbortController;
  received: number;
  samples: Array<[number, number]>;
  state: Extract<LocalModelState, 'downloading' | 'verifying'>;
  done: Promise<void>;
}

const FREE_SPACE_MARGIN = 512 * 1024 * 1024;
const DEFAULT_SETTINGS = { enabled: true, threads: 0, gpu: true };

export class LocalAIModelManager {
  private catalog: LocalAICatalog | null = null;
  private catalogAt: string | null = null;
  private catalogError: string | null = null;
  private downloads = new Map<string, Download>();
  private failures = new Map<string, string>();
  private settings: { defaultModel: string | null; ready: Record<string, string> } & AISettings = { defaultModel: null, ready: {}, ...DEFAULT_SETTINGS };
  private testing = new Set<string>();
  private notReady = new Map<string, string>();
  /** path → "size:mtime" that last matched its SHA-256, so a model is hashed once per change, not per load. */
  private verified = new Map<string, string>();

  private readonly deps: ModelManagerDeps;
  constructor(deps: ModelManagerDeps) { this.deps = deps; }

  private now(): number { return this.deps.now?.() ?? Date.now(); }
  private changed(): void { this.deps.onChange?.(); }
  private modelsDir(): string { return join(this.deps.root, 'models'); }
  private dir(m: Pick<LocalModel, 'id' | 'version'>): string { return join(this.modelsDir(), m.id, m.version); }

  async init(): Promise<void> {
    await mkdir(this.modelsDir(), { recursive: true, mode: 0o700 });
    try {
      const s = JSON.parse(await readFile(join(this.deps.root, 'settings.json'), 'utf8')) as Record<string, unknown>;
      this.settings.defaultModel = typeof s.defaultModel === 'string' ? s.defaultModel : null;
      if (s.ready && typeof s.ready === 'object') for (const [id, v] of Object.entries(s.ready as Record<string, unknown>)) if (typeof v === 'string') this.settings.ready[id] = v;
      if (typeof s.enabled === 'boolean') this.settings.enabled = s.enabled;
      if (Number.isInteger(s.threads) && (s.threads as number) >= 0 && (s.threads as number) <= 256) this.settings.threads = s.threads as number;
      if (typeof s.gpu === 'boolean') this.settings.gpu = s.gpu;
    } catch { /* defaults */ }
    await this.refresh();
  }

  /** The packaged (or administrator's) catalog, then Desktop's signed one when a key is pinned. */
  async refresh(): Promise<void> {
    this.catalogError = null;
    let found = false;
    for (const f of this.deps.catalogFiles) {
      let text: string;
      try { text = await readFile(f, 'utf8'); } catch { continue; }
      found = true;
      try {
        const raw = JSON.parse(text) as unknown;
        // A file may hold the catalog body or a signed envelope (then a pinned key must have signed it).
        this.catalog = raw && typeof raw === 'object' && 'signature' in raw ? verifyEnvelope(raw, this.deps.keys ?? {}, this.now()) : parseCatalog(raw, this.now());
        this.catalogAt = new Date(this.now()).toISOString();
      } catch (e) {
        this.catalogError = e instanceof AIError ? e.code : 'catalog_invalid';
      }
      break;
    }
    if (!found) this.catalogError = 'catalog_missing';
    const keys = this.deps.keys ?? {};
    if (this.deps.catalogUrl && Object.keys(keys).length) {
      try {
        const res = await this.deps.fetch(this.deps.catalogUrl);
        if (!res.ok) throw new AIError('catalog_fetch_failed');
        this.catalog = verifyEnvelope(await res.json(), keys, this.now());
        this.catalogAt = new Date(this.now()).toISOString();
        this.catalogError = null;
      } catch (e) {
        this.catalogError ??= codeOf(e) === 'internal_error' ? 'catalog_fetch_failed' : codeOf(e);
      }
    }
    this.changed();
  }

  /** The hosts model files may come from (the catalog's, else Desktop's CDN). */
  allowedHosts(): string[] { return this.catalog?.hosts ?? ['cdn.worksuite.app']; }

  catalogState(): { at: string | null; error: string | null } { return { at: this.catalogAt, error: this.catalogError }; }
  userSettings(): AISettings { return { enabled: this.settings.enabled, threads: this.settings.threads, gpu: this.settings.gpu }; }

  async setUserSettings(p: Partial<AISettings>): Promise<AISettings> {
    if (p.enabled !== undefined) this.settings.enabled = p.enabled;
    if (p.threads !== undefined) this.settings.threads = p.threads;
    if (p.gpu !== undefined) this.settings.gpu = p.gpu;
    await this.saveSettings();
    this.changed();
    return this.userSettings();
  }

  /** A model the policy allows, from the catalog. */
  private find(id: string): LocalModel {
    const m = this.catalog?.models.find((x) => x.id === id);
    if (!m) throw new AIError('not_in_catalog');
    if (!allowedBy(this.deps.policy(), id)) throw new AIError('model_not_allowed');
    return m;
  }

  private async systemPath(m: LocalModel): Promise<string | null> {
    if (!this.deps.systemRoot) return null;
    const p = join(this.deps.systemRoot, m.id, m.version, 'model.gguf');
    return (await stat(p).catch(() => null))?.isFile() ? p : null;
  }
  private async installed(m: LocalModel): Promise<boolean> {
    return !!(await stat(join(this.dir(m), 'model.gguf')).catch(() => null)) || !!(await this.systemPath(m));
  }
  private async partial(m: LocalModel): Promise<number> {
    return (await stat(join(this.dir(m), 'model.gguf.part')).catch(() => null))?.size ?? 0;
  }

  /** Every catalog model the policy allows, with its state here and whether it suits this computer. */
  async list(hw: LocalAIHardware | null): Promise<LocalModelView[]> {
    const policy = this.deps.policy();
    const out: LocalModelView[] = [];
    for (const model of this.catalog?.models ?? []) {
      if (!allowedBy(policy, model.id) && policy.managed) continue;
      const d = this.downloads.get(model.id);
      const system = !d && !!(await this.systemPath(model));
      const isInstalled = !d && (await this.installed(model));
      const part = d ? d.received : await this.partial(model);
      const state: LocalModelState = d ? d.state : isInstalled ? 'installed' : !model.sha256 ? 'unpublished' : this.failures.has(model.id) ? 'failed' : part > 0 ? 'paused' : 'available';
      const fits = !hw || (model.tiers.includes(hw.tier) && model.minMemoryBytes <= Math.max(hw.memoryBytes, hw.vramBytes));
      out.push({
        model, state, received: state === 'installed' ? model.bytes : part, error: this.failures.get(model.id) ?? null, fits,
        recommended: !!hw && model.recommendedFor.includes(hw.tier), isDefault: this.settings.defaultModel === model.id,
        readiness: this.readiness(model), readinessError: this.notReady.get(model.id) ?? null,
        bytesPerSecond: d && d.state === 'downloading' ? speed(d.samples) : null, ...(system ? { system: true } : {}),
      });
    }
    return out;
  }

  /** Downloads a model (resuming a partial file), verifies it, and resolves once it is in place. */
  install(id: string): Promise<void> {
    const m = this.find(id);
    if (!m.sha256) throw new AIError('unpublished');
    const running = this.downloads.get(id);
    if (running) return running.done;
    this.failures.delete(id);
    this.notReady.delete(id);
    const abort = new AbortController();
    const d: Download = { abort, received: 0, samples: [], state: 'downloading', done: Promise.resolve() };
    d.done = this.fetchModel(m, d)
      .catch((e: unknown) => { if (!abort.signal.aborted) this.failures.set(id, codeOf(e) === 'internal_error' ? 'download_failed' : codeOf(e)); })
      .finally(() => { this.downloads.delete(id); this.changed(); });
    this.downloads.set(id, d);
    this.changed();
    return d.done;
  }

  private async fetchModel(m: LocalModel, d: Download): Promise<void> {
    // Only from a host the catalog allows (parseCatalog checked it; checked again where it matters).
    const hosts = this.allowedHosts();
    if (new URL(m.url).protocol !== 'https:' || !hosts.includes(new URL(m.url).hostname)) throw new AIError('host_not_allowed');
    const dir = this.dir(m);
    await mkdir(dir, { recursive: true, mode: 0o700 });
    const part = join(dir, 'model.gguf.part');
    let have = await this.partial(m);
    if (have > m.bytes) { await rm(part, { force: true }); have = 0; }
    const fs = await statfs(dir).catch(() => null);
    if (fs && fs.bavail * fs.bsize < m.bytes - have + FREE_SPACE_MARGIN) throw new AIError('no_space');
    if (have < m.bytes) {
      let res: Response;
      try {
        res = await this.deps.fetch(m.url, { headers: have ? { Range: `bytes=${have}-` } : {}, signal: d.abort.signal });
      } catch (e) {
        if (d.abort.signal.aborted) throw e;
        throw new AIError('connection');
      }
      if (!res.ok || !res.body) throw new AIError(res.status >= 500 || res.status === 429 || res.status === 408 ? 'connection' : 'download_failed');
      // A server that ignores the range sends the whole file: start again from the beginning.
      if (have && res.status !== 206) have = 0;
      d.received = have;
      const out = createWriteStream(part, { flags: have ? 'a' : 'w', mode: 0o600 });
      try {
        const reader = res.body.getReader();
        for (;;) {
          let chunk: ReadableStreamReadResult<Uint8Array>;
          try { chunk = await reader.read(); } catch (e) { if (d.abort.signal.aborted) throw e; throw new AIError('connection'); }
          if (chunk.done) break;
          const value = chunk.value;
          if (!out.write(value)) await new Promise<void>((r) => out.once('drain', () => r()));
          d.received += value.byteLength;
          if (d.received > m.bytes) throw new AIError('download_too_large');
          const now = this.now();
          const last = d.samples[d.samples.length - 1];
          if (!last || now - last[0] >= 500) d.samples = [...d.samples.filter(([t]) => now - t <= 20_000), [now, d.received]];
          this.changed();
        }
      } finally {
        await new Promise<void>((r) => out.end(() => r()));
      }
    }
    d.state = 'verifying';
    this.changed();
    const size = (await stat(part)).size;
    if (size !== m.bytes || (await sha256(part)) !== m.sha256) {
      await rm(part, { force: true });
      throw new AIError('mismatch');
    }
    const final = join(dir, 'model.gguf');
    await rename(part, final);
    const st = await stat(final);
    this.verified.set(final, `${st.size}:${st.mtimeMs}`);
    await writeFile(join(dir, 'package.json'), JSON.stringify({ ...m, installedAt: new Date(this.now()).toISOString() }, null, 1), { mode: 0o600 });
    if (!this.settings.defaultModel && m.purpose === 'chat') await this.setDefault(m.id);
  }

  /** Pauses a download, keeping what came; `discard` removes it. */
  async cancel(id: string, discard = false): Promise<void> {
    const d = this.downloads.get(id);
    if (d) { d.abort.abort(); await d.done; }
    if (discard) {
      const m = this.catalog?.models.find((x) => x.id === id);
      if (m) await rm(join(this.dir(m), 'model.gguf.part'), { force: true });
      this.failures.delete(id);
    }
    this.changed();
  }

  /** Removes this person's copy (an administrator's copy for everyone stays). */
  async remove(id: string): Promise<void> {
    const d = this.downloads.get(id);
    if (d) { d.abort.abort(); await d.done; }
    if (!ID_SAFE.test(id)) throw new AIError('invalid_argument');
    await rm(join(this.modelsDir(), id), { recursive: true, force: true });
    this.failures.delete(id);
    this.notReady.delete(id);
    delete this.settings.ready[id];
    if (this.settings.defaultModel === id) this.settings.defaultModel = null;
    await this.saveSettings();
    this.changed();
  }

  private readiness(m: Pick<LocalModel, 'id' | 'version'>): LocalModelReadiness {
    if (this.testing.has(m.id)) return 'testing';
    if (this.notReady.has(m.id)) return 'failed';
    return this.settings.ready[m.id] === m.version ? 'ready' : 'untested';
  }
  testStarted(id: string): void { this.testing.add(id); this.notReady.delete(id); this.changed(); }
  async testEnded(id: string, problem: string | null): Promise<void> {
    this.testing.delete(id);
    const m = this.catalog?.models.find((x) => x.id === id);
    if (problem === null && m) { this.settings.ready[id] = m.version; this.notReady.delete(id); }
    else { delete this.settings.ready[id]; this.notReady.set(id, problem ?? 'internal_error'); }
    await this.saveSettings();
    this.changed();
  }
  usable(id: string): boolean { return !this.testing.has(id) && !this.notReady.has(id); }

  /** Checks an installed file against the catalog again (Settings › AI › Check). */
  async check(id: string): Promise<boolean> {
    const m = this.find(id);
    const p = await this.path(id, false);
    const ok = !!p && (await this.matches(p, m, true));
    if (!ok) this.failures.set(id, 'mismatch_installed');
    else this.failures.delete(id);
    this.changed();
    return ok;
  }

  async setDefault(id: string | null): Promise<void> {
    if (id) this.find(id);
    this.settings.defaultModel = id;
    await this.saveSettings();
    this.changed();
  }
  defaultModel(): string | null { return this.settings.defaultModel; }

  private async saveSettings(): Promise<void> {
    await mkdir(this.deps.root, { recursive: true, mode: 0o700 });
    const tmp = join(this.deps.root, 'settings.json.tmp');
    await writeFile(tmp, JSON.stringify(this.settings), { mode: 0o600 });
    await rename(tmp, join(this.deps.root, 'settings.json'));
  }

  private async matches(p: string, m: LocalModel, force = false): Promise<boolean> {
    const st = await stat(p).catch(() => null);
    if (!st || st.size !== m.bytes || !m.sha256) return false;
    const key = `${st.size}:${st.mtimeMs}`;
    if (!force && this.verified.get(p) === key) return true;
    const ok = (await sha256(p)) === m.sha256;
    if (ok) this.verified.set(p, key); else this.verified.delete(p);
    return ok;
  }

  /**
   * The file for llama.cpp. With `verify` (every load) it must match its pinned SHA-256 first — hashed once per
   * change of the file — and the policy must allow the model; otherwise null / an error, never a path.
   */
  async path(id: string, verify = true): Promise<string | null> {
    const m = this.catalog?.models.find((x) => x.id === id);
    if (!m) return null;
    if (verify && !allowedBy(this.deps.policy(), id)) throw new AIError('model_not_allowed');
    const own = join(this.dir(m), 'model.gguf');
    const p = (await stat(own).catch(() => null)) ? own : await this.systemPath(m);
    if (!p) return null;
    if (verify && !(await this.matches(p, m))) {
      this.failures.set(id, 'mismatch_installed');
      this.changed();
      throw new AIError('mismatch_installed');
    }
    return p;
  }
}

const ID_SAFE = /^[a-z0-9][a-z0-9._-]{1,63}$/;

/** Bytes a second between the oldest and newest sample, once they are 2 s apart and something arrived. */
export function speed(samples: Array<[number, number]>): number | null {
  if (samples.length < 2) return null;
  const [t0, b0] = samples[0]!;
  const [t1, b1] = samples[samples.length - 1]!;
  if (t1 - t0 < 2_000 || b1 <= b0) return null;
  return Math.round((b1 - b0) / ((t1 - t0) / 1000));
}

export function sha256(path: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const h = createHash('sha256');
    createReadStream(path, { highWaterMark: 4 * 1024 * 1024 }).on('data', (c) => h.update(c)).on('error', reject).on('end', () => resolve(h.digest('hex')));
  });
}

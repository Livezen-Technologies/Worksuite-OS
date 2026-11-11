// The application installation engine for setup's INSTALLING_APPLICATIONS step, and the offline queue it leaves for
// later. Each app is its own transaction with its own retries; an optional app that fails never fails setup, a
// required one does (after the others ran). Sources are tried in catalog order, and only these:
//   bundled  a .deb in the image's bundled directory whose SHA-256 matches its SHA256SUMS line (works offline);
//   apt      the signed APT sources (apt-get verifies them; never --allow-unauthenticated);
//   flatpak  Flathub, only when that remote is already configured system-wide (OSTree signatures).
// An app that needs the network while offline is queued and installed by `worksuite-setup --drain-queue` later.
// Fixed executables and argument vectors only; package names and refs are checked before they reach argv.
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { FLATPAK_REF_RE, PACKAGE_RE, type AppDef, type Source } from './catalog.ts'
import type { Plan } from './plan.ts'
import type { Runner } from '../rollback.ts'

export type AppState = 'pending' | 'installing' | 'installed' | 'already' | 'queued' | 'failed' | 'skipped'
export interface AppStatus {
  id: string; name: string; required: boolean; state: AppState
  source: Source['type'] | null; attempts: number; error: string | null
  /** For skipped apps: why policy kept them out. */
  why?: string
}

export interface EngineEnv {
  runner: Runner
  bundledDir: string
  online(): boolean
  /** Durable per-app status (GetApps) and the offline queue. */
  statusFile: string
  queueFile: string
  log(line: string): void
  sleep(ms: number): Promise<void>
  retry?: { max: number; backoffMs: number }
}

const APT = ['-y', '-q', '-o', 'DPkg::Lock::Timeout=300', '-o', 'APT::Get::AllowUnauthenticated=false']
const firstLine = (s: string) => s.trim().split('\n').filter(Boolean).at(-1) ?? ''

function writeJson(file: string, v: unknown) {
  mkdirSync(path.dirname(file), { recursive: true, mode: 0o755 })
  const tmp = `${file}.tmp`
  writeFileSync(tmp, JSON.stringify(v, null, 2), { mode: 0o644 })
  renameSync(tmp, file)
}
export function readStatus(file: string): AppStatus[] {
  try { const v = JSON.parse(readFileSync(file, 'utf8')); return Array.isArray(v) ? v : [] } catch { return [] }
}
export function readQueue(file: string): string[] {
  try { const v = JSON.parse(readFileSync(file, 'utf8')); return Array.isArray(v) ? v.filter((x) => typeof x === 'string') : [] } catch { return [] }
}

/** The bundled .deb for a package, verified against SHA256SUMS; null when it is not bundled. Damaged = an error. */
export function bundledDeb(dir: string, pkg: string): string | null {
  const sums = path.join(dir, 'SHA256SUMS')
  if (!PACKAGE_RE.test(pkg) || !existsSync(sums)) return null
  for (const line of readFileSync(sums, 'utf8').split('\n')) {
    const m = /^([0-9a-f]{64})\s+\*?(\S+)$/.exec(line.trim())
    if (!m) continue
    const name = path.basename(m[2])
    // Saved by tools/fetch-*.sh as <package>_<version>_<arch>.deb.
    if (!name.startsWith(`${pkg}_`) || !name.endsWith('.deb')) continue
    const file = path.join(dir, name)
    if (!existsSync(file) || createHash('sha256').update(readFileSync(file)).digest('hex') !== m[1]) throw new Error(`the bundled ${name} is missing or damaged`)
    return file
  }
  return null
}

export class AppEngine {
  private readonly env: EngineEnv
  private status: AppStatus[] = []
  private aptUpdated = false
  constructor(env: EngineEnv) { this.env = env }

  private save() { writeJson(this.env.statusFile, this.status) }
  private set(id: string, patch: Partial<AppStatus>) {
    this.status = this.status.map((s) => (s.id === id ? { ...s, ...patch } : s)); this.save()
  }

  private async installed(src: Source): Promise<boolean> {
    if (src.type === 'flatpak') return (await this.env.runner.run('flatpak', ['info', '--system', src.ref])).code === 0
    const r = await this.env.runner.run('dpkg-query', ['-W', '-f=${Status}', '--', src.package])
    return r.code === 0 && /install ok installed/.test(r.stdout)
  }

  private async flathub(): Promise<boolean> {
    const r = await this.env.runner.run('flatpak', ['remotes', '--system', '--columns=name'])
    return r.code === 0 && r.stdout.split('\n').some((l) => l.trim() === 'flathub')
  }

  /** The first source usable now, 'queue' when one would be usable online, or null when none ever is. */
  private async pick(app: AppDef): Promise<{ src: Source; deb?: string } | 'queue' | null> {
    let later = false
    for (const src of app.sources) {
      if (src.type === 'bundled') { const deb = bundledDeb(this.env.bundledDir, src.package); if (deb) return { src, deb }; continue }
      if (src.type === 'flatpak' && !FLATPAK_REF_RE.test(src.ref)) continue
      if (src.type === 'apt' && !PACKAGE_RE.test(src.package)) continue
      if (!this.env.online()) { later = true; continue }
      if (src.type === 'flatpak' && !(await this.flathub())) continue
      return { src }
    }
    return later ? 'queue' : null
  }

  /** One attempt. Throws with a short reason; `retryable: false` when retrying cannot help (unresolvable). */
  private async attempt(src: Source, deb?: string) {
    const run = this.env.runner.run
    if (src.type === 'flatpak') {
      const r = await run('flatpak', ['install', '-y', '--noninteractive', '--system', 'flathub', src.ref])
      if (r.code !== 0) throw Object.assign(new Error(firstLine(r.stderr) || 'flatpak install failed'), { retryable: true })
      return
    }
    if (src.type === 'apt' && !this.aptUpdated) {
      const u = await run('apt-get', ['-q', 'update'])
      if (u.code !== 0) throw Object.assign(new Error(`could not refresh the package lists: ${firstLine(u.stderr)}`), { retryable: true })
      this.aptUpdated = true
    }
    const target = deb ?? (src as { package: string }).package
    // Dependency resolution first: a simulation that fails will not succeed on retry.
    const sim = await run('apt-get', ['-s', '-q', 'install', '--', target])
    if (sim.code !== 0) throw Object.assign(new Error(`its dependencies cannot be resolved: ${firstLine(sim.stdout + '\n' + sim.stderr)}`), { retryable: false })
    const r = await run('apt-get', [...APT, 'install', '--', target])
    if (r.code !== 0) throw Object.assign(new Error(firstLine(r.stderr) || 'apt-get install failed'), { retryable: true })
  }

  private async one(app: AppDef, required: boolean): Promise<AppState> {
    const { max, backoffMs } = this.env.retry ?? { max: 3, backoffMs: 5_000 }
    for (const src of app.sources) {
      if (src.type !== 'bundled' && await this.installed(src).catch(() => false)) { this.set(app.id, { state: 'already', source: null }); this.env.log(`${app.name}: already installed`); return 'already' }
    }
    let chosen
    try { chosen = await this.pick(app) } catch (e) { this.set(app.id, { state: 'failed', error: (e as Error).message }); this.env.log(`${app.name}: ${(e as Error).message}`); return 'failed' }
    if (chosen === 'queue') { this.set(app.id, { state: 'queued' }); this.env.log(`${app.name}: offline, queued for when the network is back`); return 'queued' }
    if (!chosen) { this.set(app.id, { state: 'failed', error: 'no trusted source has this app for this computer' }); return 'failed' }
    for (let n = 1; n <= max; n++) {
      this.set(app.id, { state: 'installing', source: chosen.src.type, attempts: n, error: null })
      this.env.log(`${app.name}: installing from ${chosen.src.type} (attempt ${n}/${max})`)
      try {
        await this.attempt(chosen.src, chosen.deb)
        this.set(app.id, { state: 'installed', error: null }); this.env.log(`${app.name}: installed`)
        return 'installed'
      } catch (e) {
        const err = e as Error & { retryable?: boolean }
        this.env.log(`${app.name}: attempt ${n} failed: ${err.message}`)
        if (err.retryable === false || n === max) { this.set(app.id, { state: 'failed', error: err.message }); return 'failed' }
        await this.env.sleep(backoffMs * 2 ** (n - 1))
      }
    }
    void required
    return 'failed'
  }

  /** Runs the plan. Resolves with the status list; throws when a required app failed (after trying every app). */
  async run(p: Plan): Promise<AppStatus[]> {
    this.status = [
      ...p.install.map((x) => ({ id: x.app.id, name: x.app.name, required: x.required, state: 'pending' as AppState, source: null, attempts: 0, error: null })),
      ...p.skipped.filter((s) => s.why !== 'unknown').map((s) => ({ id: s.id, name: s.id, required: false, state: 'skipped' as AppState, source: null, attempts: 0, error: null, why: s.why })),
    ]
    this.save()
    const queue = new Set(readQueue(this.env.queueFile))
    const failedRequired: string[] = []
    for (const x of p.install) {
      // Something it needs failed: do not try it (it would fail on the missing dependency anyway).
      const blocker = (x.app.requires ?? []).find((d) => ['failed', 'queued'].includes(this.status.find((s) => s.id === d)?.state ?? ''))
      let st: AppState
      if (blocker) { st = this.status.find((s) => s.id === blocker)!.state === 'queued' ? 'queued' : 'failed'; this.set(x.app.id, { state: st, error: st === 'failed' ? `needs ${blocker}, which did not install` : null }) }
      else st = await this.one(x.app, x.required)
      if (st === 'queued') queue.add(x.app.id); else queue.delete(x.app.id)
      if (st === 'failed' && x.required) failedRequired.push(x.app.name)
    }
    writeJson(this.env.queueFile, [...queue])
    if (failedRequired.length) {
      const why = failedRequired.map((n) => `${n}: ${this.status.find((s) => s.name === n)?.error ?? 'failed'}`).join('; ')
      throw Object.assign(new Error(`required app(s) did not install: ${why}`), { retryable: true })
    }
    return this.status
  }

  /** The offline queue, once online: install what was queued; what still cannot install stays queued. */
  async drain(byId: Map<string, AppDef>): Promise<{ installed: string[]; left: string[] }> {
    const ids = readQueue(this.env.queueFile)
    this.status = readStatus(this.env.statusFile)
    const installed: string[] = [], left: string[] = []
    for (const id of ids) {
      const app = byId.get(id)
      if (!app) continue
      if (!this.status.some((s) => s.id === id)) this.status.push({ id, name: app.name, required: false, state: 'queued', source: null, attempts: 0, error: null })
      const st = await this.one(app, false)
      if (st === 'installed' || st === 'already') installed.push(id); else left.push(id)
    }
    writeJson(this.env.queueFile, left)
    return { installed, left }
  }
}

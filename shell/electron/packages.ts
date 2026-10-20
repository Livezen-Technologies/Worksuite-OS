// App Center → lk.worksuite.PackageService1 on the system bus. busctl/gdbus with fixed arguments; polkit prompts
// for admin rights through the session's polkit agent (interactive authorization).
import { execFile, spawn } from 'node:child_process'
import { lstatSync, rmSync } from 'node:fs'
import { join } from 'node:path'

export const NAME = 'lk.worksuite.PackageService1'
export const PATH = '/lk/worksuite/PackageService1'
type Reply<T> = { ok: true; value: T } | { ok: false; error: string }

export type Exec = (cmd: string, args: string[]) => Promise<{ code: number; stdout: string; stderr: string }>
const realExec: Exec = (cmd, args) => new Promise((resolve) => {
  execFile(cmd, args, { timeout: 6 * 60_000 }, (err, stdout, stderr) => resolve({ code: err ? 1 : 0, stdout, stderr }))
})

const SOURCES = new Set(['apt', 'flatpak'])
const ID = /^(apt|flatpak):[A-Za-z0-9][A-Za-z0-9._+-]{0,199}$/

/** busctl prints "Call failed: <message>"; the service's messages are written for people. */
function failure(stderr: string): string {
  const m = /Call failed: (.*)/.exec(stderr)
  if (!m) return /not found|was not provided|ServiceUnknown/i.test(stderr) ? 'service_unavailable' : 'failed'
  const text = m[1].trim()
  if (/not authorized|NotAuthorized|Interactive authentication required|dismissed/i.test(text)) return 'not_authorized'
  return text
}

async function call(exec: Exec, member: string, signature: string, args: string[]): Promise<Reply<unknown[]>> {
  const r = await exec('busctl', ['--system', '--json=short', '--allow-interactive-authorization=yes', '--timeout=300', 'call', NAME, PATH, NAME, member, ...(signature ? [signature, ...args] : [])])
  if (r.code !== 0) return { ok: false, error: failure(r.stderr) }
  try { return { ok: true, value: (JSON.parse(r.stdout) as { data: unknown[] }).data } } catch { return { ok: false, error: 'failed' } }
}

function check(catalogId: string): string | null {
  return ID.test(catalogId) && SOURCES.has(catalogId.split(':')[0]) ? catalogId.split(':')[0] : null
}

export function packageClient(exec: Exec = realExec) {
  return {
    async preview(catalogId: string, op: 'install' | 'remove'): Promise<Reply<unknown>> {
      const src = check(catalogId)
      if (!src) return { ok: false, error: 'invalid_argument' }
      const r = await call(exec, 'Preview', 'sss', [src, catalogId, op])
      if (!r.ok) return r
      try { return { ok: true, value: JSON.parse(String(r.value[0])) } } catch { return { ok: false, error: 'failed' } }
    },
    async start(op: 'Install' | 'Remove', catalogId: string): Promise<Reply<string>> {
      const src = check(catalogId)
      if (!src) return { ok: false, error: 'invalid_argument' }
      const r = await call(exec, op, 'ss', [src, catalogId])
      return r.ok ? { ok: true, value: String(r.value[0]) } : r
    },
    /** CheckUpdates → plain values (busctl's JSON wraps each a{sv} value as {type, data}). */
    async checkUpdates(): Promise<Reply<UpdateSummary>> {
      const r = await call(exec, 'CheckUpdates', '', [])
      if (!r.ok) return r
      const d = (r.value[0] ?? {}) as Record<string, { data: unknown }>
      const list = (k: string) => (Array.isArray(d[k]?.data) ? (d[k].data as unknown[]).map(String) : [])
      return { ok: true, value: { packages: list('packages'), flatpaks: list('flatpaks'), reboot_required: d.reboot_required?.data === true, state: String(d.state?.data ?? 'idle') } }
    },
    // Update coordinator (WSOS-AUP-011).
    async updateStatus(check = false): Promise<Reply<unknown>> {
      const r = await call(exec, check ? 'CheckForUpdates' : 'GetUpdateStatus', '', [])
      if (!r.ok) return r
      try { return { ok: true, value: JSON.parse(String(r.value[0])) } } catch { return { ok: false, error: 'failed' } }
    },
    async deferUpdate(): Promise<Reply<boolean>> {
      const r = await call(exec, 'DeferUpdate', '', [])
      return r.ok ? { ok: true, value: r.value[0] === true } : r
    },
    async installUpdateNow(): Promise<Reply<true>> {
      const r = await call(exec, 'InstallUpdateNow', '', [])
      return r.ok ? { ok: true, value: true } : r
    },
    /** WSOS-APT-006: the service's State property ('interrupted' = dpkg was interrupted and needs Repair). No polkit. */
    async serviceState(): Promise<Reply<'idle' | 'busy' | 'interrupted'>> {
      const r = await exec('busctl', ['--system', '--json=short', 'get-property', NAME, PATH, NAME, 'State'])
      if (r.code !== 0) return { ok: false, error: failure(r.stderr) }
      try {
        const v = (JSON.parse(r.stdout) as { data?: unknown }).data
        return v === 'idle' || v === 'busy' || v === 'interrupted' ? { ok: true, value: v } : { ok: false, error: 'failed' }
      } catch { return { ok: false, error: 'failed' } }
    },
    /** Repair (§9.2): dpkg --configure -a, then apt-get -f install; polkit lk.worksuite.repair. */
    async repair(): Promise<Reply<string>> {
      const r = await call(exec, 'Repair', '', [])
      return r.ok ? { ok: true, value: String(r.value[0]) } : r
    },
    async applyUpdate(): Promise<Reply<string>> {
      const r = await call(exec, 'ApplyUpdate', 'sa{sv}', ['', '0'])
      return r.ok ? { ok: true, value: String(r.value[0]) } : r
    },
    /** App Center catalog from the server through the package service (WSOS-APP-001). */
    catalog: (): Promise<Reply<unknown>> => jsonCall(exec, 'GetCatalog', '', []),
    // Local .deb (WSOS-APT-005): preview stages and checks; install needs the preview token and an admin password.
    localDebPreview: (path: string): Promise<Reply<unknown>> => (ABS.test(path) && path.endsWith('.deb') ? jsonCall(exec, 'PreviewLocalDeb', 's', [path]) : bad()),
    localDebInstall: (token: string): Promise<Reply<string>> => (/^[0-9a-f]{64}$/.test(token) ? jobCall(exec, 'InstallLocalDeb', 's', [token]) : bad()),
    // Flatpak (WSOS-FLP-003/004): system side.
    appPermissions: (catalogId: string): Promise<Reply<unknown>> => (FLATPAK_ID.test(catalogId) ? jsonCall(exec, 'GetAppPermissions', 's', [catalogId]) : bad()),
    resetAppPermissions: (catalogId: string): Promise<Reply<string>> => (FLATPAK_ID.test(catalogId) ? jobCall(exec, 'ResetAppPermissions', 's', [catalogId]) : bad()),
    pruneRuntimes: (): Promise<Reply<string>> => jobCall(exec, 'PruneRuntimes', '', []),
    // Offline .wsupdate bundles (WSOS-AUP-010).
    bundleInspect: (path: string): Promise<Reply<unknown>> => (ABS.test(path) && path.endsWith('.wsupdate') ? jsonCall(exec, 'InspectBundle', 's', [path]) : bad()),
    // Drivers (Settings › Drivers): the report, a check now (waits for it), and installing offers (polkit).
    driverReport: (check = false): Promise<Reply<unknown>> => (check ? jsonCall(exec, 'CheckDrivers', 's', ['manual']) : jsonCall(exec, 'GetDrivers', '', [])),
    /** The one-time MOK password (polkit: administrator); '' when none is pending. */
    mokPassword: async (): Promise<Reply<string>> => { const r = await call(exec, 'GetMokPassword', '', []); return r.ok ? { ok: true, value: String(r.value[0] ?? '') } : r },
    installDrivers: (ids: string[]): Promise<Reply<string>> => {
      const ok = ids.filter((x) => /^[a-z]+:[A-Za-z0-9+._-]{1,100}$/.test(x)).slice(0, 50)
      return ok.length ? jobCall(exec, 'InstallDrivers', 'as', [String(ok.length), ...ok]) : bad()
    },
    // Update Manager: history of OS/driver/firmware/app updates, Flatpak app updates (polkit to apply).
    updateHistory: (): Promise<Reply<unknown>> => jsonCall(exec, 'GetUpdateHistory', '', []),
    appUpdates: (): Promise<Reply<unknown>> => jsonCall(exec, 'GetAppUpdates', '', []),
    updateApps: (ids: string[]): Promise<Reply<string>> => {
      const ok = ids.filter((x) => FLATPAK_ID.test(x)).slice(0, 200)
      return ok.length !== ids.length ? bad() : jobCall(exec, 'UpdateApps', 'as', [String(ok.length), ...ok])
    },
    // Software Management: ask the organization to approve an app; the service takes the requester from the bus.
    requestApp: (catalogId: string, reason: string): Promise<Reply<unknown>> =>
      (ID.test(catalogId) ? jsonCall(exec, 'RequestApp', 'ss', [catalogId, String(reason).replace(/[\u0000-\u001f]/g, ' ').slice(0, 500)]) : bad()),
    bundleInstall: (path: string): Promise<Reply<string>> => (ABS.test(path) && path.endsWith('.wsupdate') ? jobCall(exec, 'InstallBundle', 's', [path]) : bad()),
  }
}

const ABS = /^\/[^\0\n]{1,4000}$/
const FLATPAK_ID = /^flatpak:[A-Za-z][A-Za-z0-9_-]*(\.[A-Za-z0-9_-]+){2,}$/
const bad = async <T>(): Promise<Reply<T>> => ({ ok: false, error: 'invalid_argument' })
async function jsonCall(exec: Exec, member: string, sig: string, args: string[]): Promise<Reply<unknown>> {
  const r = await call(exec, member, sig, args)
  if (!r.ok) return r
  try { return { ok: true, value: JSON.parse(String(r.value[0])) } } catch { return { ok: false, error: 'failed' } }
}
async function jobCall(exec: Exec, member: string, sig: string, args: string[]): Promise<Reply<string>> {
  const r = await call(exec, member, sig, args)
  return r.ok ? { ok: true, value: String(r.value[0]) } : r
}

/** Per-user Flatpak state the root service must not touch (WSOS-FLP-003): the portal permission store, user
 *  overrides and ~/.var/app/<id>. Runs as the logged-in user. */
export function flatpakUserClient(exec: Exec = realExec, home = process.env.HOME ?? '') {
  const appId = (catalogId: string) => (FLATPAK_ID.test(catalogId) ? catalogId.slice('flatpak:'.length) : null)
  return {
    async resetUserPermissions(catalogId: string): Promise<Reply<true>> {
      const id = appId(catalogId)
      if (!id) return bad()
      const a = await exec('flatpak', ['permission-reset', id])
      const b = await exec('flatpak', ['override', '--user', '--reset', id])
      return a.code === 0 && b.code === 0 ? { ok: true, value: true } : { ok: false, error: (a.stderr || b.stderr).trim().split('\n')[0] || 'failed' }
    },
    /** Delete ~/.var/app/<id> (settings, cache and files the app keeps for itself). Never follows a link. */
    removeAppData(catalogId: string): Reply<boolean> {
      const id = appId(catalogId)
      if (!id || !home.startsWith('/')) return { ok: false, error: 'invalid_argument' }
      const dir = join(home, '.var', 'app', id)
      let st
      try { st = lstatSync(dir) } catch { return { ok: true, value: false } }
      if (!st.isDirectory() || st.isSymbolicLink()) return { ok: false, error: 'invalid_argument' }
      rmSync(dir, { recursive: true, force: true })
      return { ok: true, value: true }
    },
  }
}

/** worksuite-appimage (per-user AppImage manager in the package service, WSOS-AIM-001…004) with fixed arguments. */
export function appimageClient(exec: Exec = realExec, bin = '/usr/bin/worksuite-appimage') {
  const ID = /^[0-9a-f]{16}$/
  const run = async (args: string[]): Promise<Reply<unknown>> => {
    const r = await exec(bin, args)
    try {
      const out = JSON.parse(r.stdout.trim().split('\n').pop() ?? '') as { ok: boolean; value?: unknown; code?: string; error?: string }
      return out.ok ? { ok: true, value: out.value } : { ok: false, error: out.error ?? out.code ?? 'failed' }
    } catch { return { ok: false, error: /ENOENT|not found/i.test(r.stderr) ? 'service_unavailable' : 'failed' } }
  }
  return {
    list: () => run(['list']),
    import: (path: string, origin = '') => (ABS.test(path) && /\.appimage$/i.test(path) && !/[\r\n]/.test(origin) ? run(['import', path, '--origin', origin]) : bad()),
    approve: (id: string) => (ID.test(id) ? run(['approve', id]) : bad()),
    remove: (id: string) => (ID.test(id) ? run(['remove', id]) : bad()),
    update: (id: string, path: string) => (ID.test(id) && ABS.test(path) && /\.appimage$/i.test(path) ? run(['update', id, path]) : bad()),
    launch: (id: string) => (ID.test(id) ? run(['run', id]) : bad()),
  }
}

export interface UpdateSummary { packages: string[]; flatpaks: string[]; reboot_required: boolean; state: string }

export interface JobEvent { job: string; kind: 'progress' | 'finished' | 'update_status' | 'drivers'; status?: unknown; percent?: number; phase?: string; result?: string; error?: string }

/** One gdbus monitor line → event. Example:
 *  /lk/worksuite/PackageService1: lk.worksuite.PackageService1.JobFinished (objectpath '/lk/worksuite/PackageService1/job/3', 'failed', {'kind': <'install'>, 'error': <'not approved by your organization'>})
 */
export function parseMonitorLine(line: string): JobEvent | null {
  let m = /\.JobProgress \(objectpath '([^']+)', uint32 (\d+), '([^']*)'\)/.exec(line)
  if (m) return { job: m[1], kind: 'progress', percent: Number(m[2]), phase: m[3] }
  m = /\.JobFinished \(objectpath '([^']+)', '(\w+)', \{(.*)\}\)/.exec(line)
  if (m) {
    const err = /'error': <'((?:[^'\\]|\\.)*)'>/.exec(m[3])?.[1]?.replace(/\\(.)/g, '$1')
    return { job: m[1], kind: 'finished', result: m[2], ...(err ? { error: err } : {}) }
  }
  // GVariant string: single-quoted with \' and \\ escapes (JSON itself uses double quotes).
  m = /\.DriversChanged \('((?:[^'\\]|\\.)*)',\)/.exec(line)
  if (m) {
    try { return { job: '', kind: 'drivers', status: JSON.parse(m[1].replace(/\\(.)/g, '$1')) } } catch { return null }
  }
  m = /\.UpdateStatusChanged \('((?:[^'\\]|\\.)*)',\)/.exec(line)
  if (m) {
    try { return { job: '', kind: 'update_status', status: JSON.parse(m[1].replace(/\\(.)/g, '$1')) } } catch { return null }
  }
  return null
}

/** Follow the service's signals; restarts the monitor if it exits. */
export function followJobs(onEvent: (e: JobEvent) => void) {
  const start = () => {
    const child = spawn('gdbus', ['monitor', '--system', '--dest', NAME, '--object-path', PATH], { stdio: ['ignore', 'pipe', 'ignore'] })
    let buf = ''
    child.stdout.setEncoding('utf8')
    child.stdout.on('data', (c: string) => {
      buf += c
      let nl: number
      while ((nl = buf.indexOf('\n')) >= 0) { const e = parseMonitorLine(buf.slice(0, nl)); buf = buf.slice(nl + 1); if (e) onEvent(e) }
    })
    child.on('error', () => {})
    child.on('exit', () => setTimeout(start, 5000))
  }
  start()
}

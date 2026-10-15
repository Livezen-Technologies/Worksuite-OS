// App Center → lk.worksuite.PackageService1 on the system bus. busctl/gdbus with fixed arguments; polkit prompts
// for admin rights through the session's polkit agent (interactive authorization).
import { execFile, spawn } from 'node:child_process'

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
    async applyUpdate(): Promise<Reply<string>> {
      const r = await call(exec, 'ApplyUpdate', 'sa{sv}', ['', '0'])
      return r.ok ? { ok: true, value: String(r.value[0]) } : r
    },
  }
}

export interface UpdateSummary { packages: string[]; flatpaks: string[]; reboot_required: boolean; state: string }

export interface JobEvent { job: string; kind: 'progress' | 'finished'; percent?: number; phase?: string; result?: string; error?: string }

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

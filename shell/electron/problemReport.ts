// §11.6-d "Report a problem": the shell builds a diagnostic report from this computer, the person reviews every
// section (and leaves out what they don't want to share), then saves it or sends it to their organization.
// Nothing is collected or sent before they ask. Known secrets (tokens, passwords, keys, email addresses) are
// redacted before the person even sees the text. Electron-free so it can be unit tested.
import { randomUUID } from 'node:crypto'

export type Exec = (cmd: string, args: string[]) => Promise<{ code: number; stdout: string; stderr: string; missing?: boolean }>
export type SectionId = 'system' | 'services' | 'session_services' | 'session_log' | 'system_log' | 'packages'
export interface ReportSection { id: SectionId; text: string; available: boolean }
export interface ProblemReport { id: string; created_at: string; sections: ReportSection[] }

const MAX_SECTION = 64 * 1024

/** Redaction applied to every section. Errs on the side of removing. */
export function redact(text: string, home = ''): string {
  let s = text
    .replace(/\b(Bearer|Basic)\s+[A-Za-z0-9._~+/=-]+/gi, '$1 <redacted>')
    .replace(/\b(password|passwd|pass|pin|secret|token|access_token|refresh_token|api[_-]?key|credential|authorization|cookie|psk)(\s*[=:]\s*)("[^"]*"|'[^']*'|\S+)/gi, '$1$2<redacted>')
    .replace(/-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g, '<private key redacted>')
    .replace(/\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]*/g, '<jwt redacted>')
    .replace(/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g, '<email>')
    .replace(/\b[A-Fa-f0-9]{40,}\b/g, '<hex redacted>')
  if (home && home.length > 1) s = s.split(home).join('~')
  return s
}

const cap = (s: string) => (s.length > MAX_SECTION ? `${s.slice(0, MAX_SECTION)}\n… (truncated)` : s)

export async function collectReport(o: { exec: Exec; readFile: (p: string) => string | null; home: string; now?: () => Date }): Promise<ProblemReport> {
  const run = async (id: SectionId, cmd: string, args: string[], empty: string): Promise<ReportSection> => {
    const r = await o.exec(cmd, args)
    if (r.missing || r.code !== 0) return { id, text: '', available: false }
    const out = r.stdout.trim()
    return { id, text: cap(redact(out || empty, o.home)), available: true }
  }
  const osRelease = o.readFile('/etc/os-release') ?? ''
  const field = (k: string) => new RegExp(`^${k}="?([^"\\n]*)"?`, 'm').exec(osRelease)?.[1] ?? null
  const uname = await o.exec('uname', ['-srm'])
  const system: ReportSection = {
    id: 'system', available: true,
    text: redact([`OS: ${field('PRETTY_NAME') ?? 'unknown'}`, `Version: ${field('VERSION_ID') ?? 'unknown'}`, `Kernel: ${uname.code === 0 ? uname.stdout.trim() : 'unknown'}`].join('\n'), o.home),
  }
  const sections = [system, ...(await Promise.all([
    run('services', 'systemctl', ['--failed', '--no-legend', '--plain', '--no-pager'], 'No failed system services.'),
    run('session_services', 'systemctl', ['--user', '--failed', '--no-legend', '--plain', '--no-pager'], 'No failed session services.'),
    run('session_log', 'journalctl', ['--user', '-p', 'warning', '-b', '-n', '200', '-o', 'short-iso', '--no-pager'], 'No warnings in this session.'),
    run('system_log', 'journalctl', ['-p', 'err', '-b', '-n', '200', '-o', 'short-iso', '--no-pager'], 'No errors since boot.'),
    run('packages', 'dpkg-query', ['-W', '-f=${Package} ${Version}\\n', 'worksuite-*'], 'No WorkSuite packages found.'),
  ]))]
  return { id: randomUUID(), created_at: (o.now ?? (() => new Date()))().toISOString(), sections }
}

/** What leaves the computer: only the sections the person kept, and their own description. */
export function finalReport(r: ProblemReport, keep: string[], description: string): { id: string; created_at: string; description: string; sections: { id: SectionId; text: string }[] } {
  const k = new Set(keep)
  return {
    id: r.id, created_at: r.created_at, description: redact(String(description).slice(0, 2000)),
    sections: r.sections.filter((s) => s.available && k.has(s.id)).map(({ id, text }) => ({ id, text })),
  }
}

export function reportText(f: ReturnType<typeof finalReport>): string {
  return [`WorkSuite OS problem report ${f.id}`, `Created: ${f.created_at}`, '', f.description || '(no description)', '',
    ...f.sections.flatMap((s) => [`== ${s.id} ==`, s.text, ''])].join('\n')
}

export type SendFetch = (url: string, init: { method: string; headers: Record<string, string>; body: string }) => Promise<{ ok: boolean; status: number }>

/** Sends to the signed-in user's organization (desktop/v1/problem-reports). */
export async function sendReport(f: ReturnType<typeof finalReport>, s: { token: string; apiBase: string } | null, fetchFn: SendFetch, device?: string | null): Promise<{ ok: true } | { ok: false; error: string }> {
  if (!s) return { ok: false, error: 'not_signed_in' }
  try {
    const r = await fetchFn(new URL('desktop/v1/problem-reports', s.apiBase).toString(), {
      method: 'POST',
      headers: { authorization: `Bearer ${s.token}`, 'content-type': 'application/json', 'idempotency-key': f.id, ...(device ? { 'x-ws-device': device } : {}) },
      body: JSON.stringify(f),
    })
    if (r.status === 401) return { ok: false, error: 'auth_required' }
    return r.ok ? { ok: true } : { ok: false, error: 'server_error' }
  } catch { return { ok: false, error: 'offline' } }
}

// Ending the session and what goes wrong on the way, for the shell (registered from main.ts):
// - shutdown/restart/sign-out: logind's inhibitors (ListInhibitors) for the "These apps are preventing shutdown"
//   dialog, the forced variant (systemctl --check-inhibitors=no, polkit decides), and the overlay's state broadcast
//   to every display's shell window so the fade shows on all of them (src/components/SessionEnd.tsx);
// - "X quit unexpectedly": systemd-coredump's journal entries for this user's apps (MESSAGE_ID below), turned into
//   the app's name and desktop id; technical fields go to the dialog's administrator details only;
// - Settings › About › Diagnostics (administrators): this session's journal directly, the system journal and the
//   "show boot details" boot entry through pkexec worksuite-diagnostics (polkit lk.worksuite.diagnostics).
import { execFile, spawn, type ChildProcess } from 'node:child_process'
import { existsSync } from 'node:fs'
import dbus from 'dbus-next'
import type { DesktopEntry } from './xdg'

type Handle = (channel: string, fn: (...args: string[]) => unknown) => void
type Broadcast = (channel: string, payload: unknown) => void

export type EndAction = 'shutdown' | 'restart' | 'logout'
export interface Inhibitor { what: string; who: string; why: string; mode: string; uid: number; pid: number }

/** Inhibitors that stop this action: "block" mode on shutdown (restart is a shutdown too). Sign-out has none. */
export function blockingInhibitors(list: Inhibitor[], action: EndAction): Inhibitor[] {
  if (action === 'logout') return []
  return list.filter((i) => i.mode === 'block' && i.what.split(':').includes('shutdown'))
}

/** systemctl argv for an action; `force` skips inhibitors (logind asks polkit, which may want an administrator). */
export function powerArgs(action: string, force: boolean): string[] | null {
  const verb = ({ suspend: 'suspend', restart: 'reboot', shutdown: 'poweroff' } as Record<string, string>)[action]
  if (!verb) return null
  return force && verb !== 'suspend' ? [verb, '--check-inhibitors=no'] : [verb]
}

export const POWER_FORCE = '/usr/lib/worksuite/worksuite-power-force'

/** "Restart anyway" / "Shut down anyway": at most ONE question, and none when logind allows it.
 *  1. logind without interaction (systemctl --no-ask-password): an ordinary user restarting with no other sessions
 *     signed in, past inhibitors of their own apps, needs no administrator (logind ignores the caller's own ones).
 *  2. Otherwise one administrator prompt (polkit lk.worksuite.power-force, through our agent): the helper runs as root,
 *     which logind does not ask about. systemctl itself asks polkit once per action (other sessions signed in, then
 *     inhibitors), which showed two administrator prompts in a row. */
export async function forcePower(exec: Exec, action: string): Promise<{ ok: true; value: true } | { ok: false; error: string }> {
  const a = powerArgs(action, true)
  if (!a || action === 'suspend') return { ok: false, error: 'invalid_argument' }
  const quiet = await exec('systemctl', [...a, '--no-ask-password'])
  if (quiet.code === 0) return { ok: true, value: true }
  const r = await exec('pkexec', ['/usr/lib/worksuite/worksuite-power-force', a[0]])   // POWER_FORCE; a[0] is reboot|poweroff
  return r.code === 0 ? { ok: true, value: true } : { ok: false, error: pkexecError(r.code) === 'failed' ? 'not_authorized' : pkexecError(r.code) }
}

export async function listInhibitors(bus: { getProxyObject: (n: string, p: string) => Promise<{ getInterface: (i: string) => { ListInhibitors(): Promise<unknown[][]> } }>; disconnect?: () => void } = dbus.systemBus()): Promise<Inhibitor[]> {
  try {
    const obj = await bus.getProxyObject('org.freedesktop.login1', '/org/freedesktop/login1')
    const rows = await obj.getInterface('org.freedesktop.login1.Manager').ListInhibitors()
    return rows.map((r) => ({ what: String(r[0]), who: String(r[1]), why: String(r[2]), mode: String(r[3]), uid: Number(r[4]), pid: Number(r[5]) }))
  } finally { bus.disconnect?.() }
}

// ---- crashed apps ----
/** systemd-coredump's "Process … dumped core" catalog id. */
export const COREDUMP_MESSAGE_ID = 'fc2e22bc6ee647b6b90729ab34a250b1'
export const CRASH_JOURNAL_ARGS = ['--user', '-f', '-n', '0', '-o', 'json', `MESSAGE_ID=${COREDUMP_MESSAGE_ID}`]

export interface Crash { appId: string | null; name: string; at: number; details: string }

/** The desktop id from the app's scope (electron/session.ts: app-worksuite-<id>-<8 hex>.scope). */
export function appIdFromScope(unit: string | undefined): string | null {
  const m = /^app-worksuite-(.+)-[0-9a-f]{8}\.scope$/.exec(unit ?? '')
  return m ? m[1] : null
}

/** One coredump journal entry → what the dialog needs; null for the shell itself and non-apps. */
export function crashFromJournal(e: Record<string, unknown>, apps: DesktopEntry[], now = Date.now()): Crash | null {
  const s = (k: string) => (typeof e[k] === 'string' ? (e[k] as string) : undefined)
  const comm = s('COREDUMP_COMM') ?? ''
  const exe = s('COREDUMP_EXE') ?? ''
  const unit = s('COREDUMP_USER_UNIT') ?? s('COREDUMP_UNIT')
  if (/^worksuite-(shell|wayland-bridge|session)/.test(unit ?? '') || /worksuite-shell|electron$/.test(exe) && !appIdFromScope(unit)) return null
  let appId = appIdFromScope(unit)
  const base = exe.split('/').pop() ?? ''
  const entry = (appId && apps.find((a) => a.id === appId)) || apps.find((a) => {
    const prog = (a.exec ?? '').trim().split(/\s+/)[0]?.split('/').pop()
    return !!prog && (prog === base || prog === comm)
  })
  if (!appId && !entry) {
    if (!unit?.startsWith('app-')) return null   // a background service, not something the person opened
  }
  appId = appId ?? entry?.id ?? null
  const signal = s('COREDUMP_SIGNAL_NAME') ?? s('COREDUMP_SIGNAL') ?? ''
  const details = [`Process: ${comm || base} (PID ${s('COREDUMP_PID') ?? '?'})`, exe && `Executable: ${exe}`, signal && `Signal: ${signal}`,
    unit && `Unit: ${unit}`, s('COREDUMP_FILENAME') && `Core file: ${s('COREDUMP_FILENAME')}`].filter(Boolean).join('\n')
  return { appId, name: entry?.name ?? (comm || base || 'App'), at: now, details }
}

/** The same app crashing again within this window shows no second dialog (a crash loop). */
export function crashDeduper(windowMs = 15_000) {
  const last = new Map<string, number>()
  return (c: Crash) => {
    const k = c.appId ?? c.name
    const prev = last.get(k)
    last.set(k, c.at)
    return prev == null || c.at - prev > windowMs
  }
}

export function watchCrashes(apps: () => DesktopEntry[], onCrash: (c: Crash) => void, run: (cmd: string, args: string[]) => ChildProcess = (c, a) => spawn(c, a, { stdio: ['ignore', 'pipe', 'ignore'] })): () => void {
  let child: ChildProcess | null = null
  let stopped = false
  const fresh = crashDeduper()
  const start = () => {
    if (stopped) return
    try { child = run('journalctl', CRASH_JOURNAL_ARGS) } catch { return }
    let buf = ''
    child.stdout?.setEncoding('utf8')
    child.stdout?.on('data', (d: string) => {
      buf += d
      let i
      while ((i = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, i); buf = buf.slice(i + 1)
        try {
          const c = crashFromJournal(JSON.parse(line) as Record<string, unknown>, apps())
          if (c && fresh(c)) onCrash(c)
        } catch { /* not JSON */ }
      }
    })
    child.on('error', () => { child = null })
    child.on('exit', () => { child = null; if (!stopped) setTimeout(start, 30_000) })
  }
  start()
  return () => { stopped = true; child?.kill() }
}

// ---- diagnostics (administrators) ----
export const SESSION_JOURNAL_ARGS = (lines: number) => ['--user', '-b', '0', '-o', 'short-iso', '-n', String(lines), '--no-pager', '-q']
export const DIAGNOSTICS = '/usr/lib/worksuite/worksuite-diagnostics'
export const BOOT_DETAILS_FLAG = '/etc/worksuite/boot-details'

export function clampLines(n: string | number): number {
  const v = Math.floor(Number(n))
  return Number.isFinite(v) ? Math.min(5000, Math.max(1, v)) : 500
}

/** Admin = member of sudo, admin or wheel (electron/users.ts), from /etc/group. */
export function isAdminUser(user: string, group: string): boolean {
  return group.split('\n').some((l) => /^(sudo|wheel|admin):/.test(l) && (l.split(':')[3] ?? '').split(',').includes(user))
}

type Exec = (cmd: string, args: string[]) => Promise<{ code: number; stdout: string; stderr: string }>
const realExec: Exec = (cmd, args) => new Promise((resolve) => execFile(cmd, args, { encoding: 'utf8', maxBuffer: 8 * 1024 * 1024, timeout: 120_000 }, (err, stdout, stderr) =>
  resolve({ code: err ? (typeof (err as { code?: unknown }).code === 'number' ? (err as { code: number }).code : 1) : 0, stdout: stdout ?? '', stderr: stderr ?? '' })))

/** pkexec exit 126/127: the administrator prompt was dismissed or refused. */
export function pkexecError(code: number): string {
  return code === 126 ? 'auth_cancelled' : code === 127 ? 'not_authorized' : 'failed'
}

export function startSessionHost(handle: Handle, broadcast: Broadcast, o: { apps: () => DesktopEntry[]; user: string; readGroup: () => string; exec?: Exec; launch: (id: string) => unknown; watch?: boolean }) {
  const exec = o.exec ?? realExec
  handle('ws:inhibitors', async (action) => {
    try {
      const all = await listInhibitors()
      return { ok: true, value: blockingInhibitors(all, (['shutdown', 'restart', 'logout'].includes(action) ? action : 'shutdown') as EndAction) }
    } catch { return { ok: false, error: 'service_unavailable' } }
  })
  handle('ws:powerForce', (action) => forcePower(exec, action))
  // The main window runs the overlay; every display mirrors it.
  handle('ws:sessionEndState', (json) => {
    let s: unknown = null
    try { s = JSON.parse(json) } catch { return false }
    broadcast('ws:sessionEnd', s)
    return true
  })
  if (o.watch !== false) watchCrashes(o.apps, (c) => broadcast('ws:appCrashed', c))
  handle('ws:reopenApp', (id) => o.launch(id))
  handle('ws:isAdmin', () => { try { return isAdminUser(o.user, o.readGroup()) } catch { return false } })
  handle('ws:sessionJournal', async (lines) => {
    const r = await exec('journalctl', SESSION_JOURNAL_ARGS(clampLines(lines)))
    return r.code === 0 ? { ok: true, value: r.stdout } : { ok: false, error: 'failed' }
  })
  handle('ws:systemJournal', async (kind, lines) => {
    if (!['boot', 'previous', 'greeter'].includes(kind)) return { ok: false, error: 'invalid_argument' }
    const r = await exec('pkexec', ['/usr/lib/worksuite/worksuite-diagnostics', 'journal', kind, String(clampLines(lines))])
    return r.code === 0 ? { ok: true, value: r.stdout } : { ok: false, error: pkexecError(r.code) }
  })
  handle('ws:bootDetails', async (op) => {
    if (!['status', 'on', 'off'].includes(op)) return { ok: false, error: 'invalid_argument' }
    // Reading the flag needs no administrator; changing it does.
    if (op === 'status') return { ok: true, value: existsSync(BOOT_DETAILS_FLAG) }
    const r = await exec('pkexec', ['/usr/lib/worksuite/worksuite-diagnostics', 'boot-details', op])
    return r.code === 0 ? { ok: true, value: r.stdout.trim() === 'on' } : { ok: false, error: pkexecError(r.code) }
  })
}

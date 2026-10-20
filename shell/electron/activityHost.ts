// Wires activity monitoring (electron/activity.ts) to the session: the window list, logind idle and lock, the policy,
// IPC for Settings and the indicator, and sending to the organization.
import { spawn } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { ActivityTracker, activityPolicy, activityView, clearStore, DISCLOSURE_VERSION, loadStore, saveStore, sendActivity, storePath, type ActivityPolicy, type SendFetch } from './activity'

type Handle = (channel: string, fn: (...args: string[]) => unknown) => void

const read = (p: string) => { try { return readFileSync(p, 'utf8') } catch { return null } }

/** gdbus monitor lines of the user's logind session → idle / lock changes. */
export function parseLogindLine(line: string): { idle?: boolean; lock?: boolean } | null {
  if (/org\.freedesktop\.login1\.Session\.Lock \(\)/.test(line)) return { lock: true }
  if (/org\.freedesktop\.login1\.Session\.Unlock \(\)/.test(line)) return { lock: false }
  const m = /PropertiesChanged \('org\.freedesktop\.login1\.Session', \{[^}]*'IdleHint': <(true|false)>/.exec(line)
  return m ? { idle: m[1] === 'true' } : null
}

/** Display name from the app's desktop entry (Name=), or a readable form of its id. Never the window title. */
export function appDisplayName(appId: string, readFile: (p: string) => string | null = read): string {
  const dirs = ['/usr/share/applications', '/var/lib/flatpak/exports/share/applications', '/usr/local/share/applications', `${process.env.HOME ?? ''}/.local/share/applications`]
  for (const d of dirs) {
    const t = readFile(`${d}/${appId}.desktop`)
    const n = t ? /^Name=(.+)$/m.exec(t)?.[1]?.trim() : null
    if (n) return n.slice(0, 80)
  }
  const last = appId.split('.').pop() || appId
  return (last.charAt(0).toUpperCase() + last.slice(1)).replace(/[-_]+/g, ' ').slice(0, 80)
}

const SHELL_IDS = new Set(['worksuite-shell', 'worksuite', 'electron'])

export interface ActivityDeps {
  home: string
  now?: () => number
  session: () => Promise<{ token: string; apiBase: string } | null>
  device: () => string | null
  fetch: SendFetch & ((url: string, init: { headers: Record<string, string> }) => Promise<{ ok: boolean; status: number; json(): Promise<unknown> }>)
  broadcast: (channel: string, payload: unknown) => void
}

export function startActivity(handle: Handle, d: ActivityDeps) {
  const now = d.now ?? Date.now
  const file = storePath(d.home)
  let policy: ActivityPolicy = activityPolicy(read)
  let tracker: ActivityTracker | null = null
  let lastSent: number | null = null
  let ack = loadStore(file).disclosure_ack

  const save = () => { if (tracker) { tracker.flush(); saveStore(file, tracker.store) } }
  const start = () => {
    const store = loadStore(file)
    tracker = new ActivityTracker(store, { now, idleThresholdS: policy.idle_threshold_s })
    tracker.prune(policy.retention_days)
    tracker.event('login')
    saveStore(file, store)
  }
  const apply = () => {
    const was = policy.enabled
    policy = activityPolicy(read)
    if (policy.enabled && !tracker) start()
    if (!policy.enabled && tracker) { tracker = null }
    // Off (or unmanaged): nothing recorded is kept on the device.
    if (!policy.enabled) clearStore(file, ack)
    if (was !== policy.enabled) d.broadcast('ws:activityChanged', view())
  }
  const view = () => { tracker?.flush(); return activityView(policy, tracker?.store ?? { ...loadStore(file), days: {} }, lastSent) }

  const send = async () => {
    if (!tracker) return
    tracker.flush()
    const reports = tracker.unsent()
    if (!reports.length) return
    const at = now()
    const r = await sendActivity(reports, await d.session().catch(() => null), d.device(), d.fetch)
    if (r.ok) { tracker.markSent(reports.map((x) => x.day), at); lastSent = at; saveStore(file, tracker.store) }
  }

  apply()
  // Session idle and lock from logind (swayidle sets IdleHint; worksuite-lock answers Lock).
  const session = process.env.XDG_SESSION_ID
  if (session) {
    const child = spawn('gdbus', ['monitor', '--system', '--dest', 'org.freedesktop.login1', '--object-path', `/org/freedesktop/login1/session/${session.replace(/[^A-Za-z0-9_]/g, '_')}`], { stdio: ['ignore', 'pipe', 'ignore'] })
    let buf = ''
    child.stdout.setEncoding('utf8')
    child.stdout.on('data', (c: string) => {
      buf += c
      let nl: number
      while ((nl = buf.indexOf('\n')) >= 0) {
        const ev = parseLogindLine(buf.slice(0, nl)); buf = buf.slice(nl + 1)
        if (!ev || !tracker) continue
        if (ev.lock !== undefined) tracker.lock(ev.lock)
        if (ev.idle !== undefined) tracker.idle(ev.idle)
      }
    })
    child.on('error', () => {})
  }
  const names = new Map<string, string>()
  const timers = [
    setInterval(apply, 5 * 60_000),
    setInterval(save, 60_000),
    setInterval(() => { void send() }, 15 * 60_000),
  ]
  for (const t of timers) t.unref?.()

  handle('ws:activityStatus', () => view())
  handle('ws:activityAck', () => {
    ack = DISCLOSURE_VERSION
    if (tracker) { tracker.store.disclosure_ack = ack; saveStore(file, tracker.store) } else saveStore(file, { ...loadStore(file), disclosure_ack: ack })
    const v = view(); d.broadcast('ws:activityChanged', v); return v
  })
  // Transparency: what the organization holds about this user (desktop/v1/activity).
  handle('ws:activityRemote', async () => {
    const s = await d.session().catch(() => null)
    if (!s) return { ok: false, error: 'not_signed_in' }
    try {
      const dev = d.device()
      const r = await d.fetch(new URL('desktop/v1/activity', s.apiBase).toString(), { headers: { authorization: `Bearer ${s.token}`, ...(dev ? { 'x-ws-device': dev } : {}) } })
      if (!r.ok) return { ok: false, error: r.status === 401 ? 'auth_required' : 'server_error' }
      const b = await r.json() as { items?: unknown[] }
      return { ok: true, value: Array.isArray(b.items) ? b.items : [] }
    } catch { return { ok: false, error: 'offline' } }
  })

  return {
    /** Window list from the Wayland bridge: the activated app (not the shell) is the one being used. */
    windows(list: { appId: string; flags: number }[], activatedFlag: number) {
      if (!tracker) return
      const w = list.find((x) => x.flags & activatedFlag)
      if (!w || SHELL_IDS.has(w.appId.toLowerCase())) { tracker.focus(null); return }
      let n = names.get(w.appId)
      if (!n) { n = appDisplayName(w.appId); names.set(w.appId, n) }
      tracker.focus({ id: w.appId, name: n })
    },
    /** Network back: send what was kept offline. */
    online() { void send() },
    stop() { if (tracker) { tracker.event('logout'); save() } void send(); for (const t of timers) clearInterval(t) },
  }
}

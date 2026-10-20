// Wires activity monitoring (electron/activity.ts) to the session: the window list, logind idle and lock, the policy,
// IPC for Settings and the indicator, and sending to the organization.
import { spawn } from 'node:child_process'
import { mkdirSync, readFileSync, watch } from 'node:fs'
import path from 'node:path'
import { ActivityTracker, activityPolicy, activityView, clearStore, disclosureVersion, loadStore, saveStore, sendActivity, sendLive, storePath, webDomainFile, type ActivityPolicy, type LiveState, type SendFetch } from './activity'

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

/** gdbus monitor lines of NetworkManager → true when it reports full connectivity (Connectivity 4 or State 70). */
export function parseNmOnline(line: string): boolean | null {
  if (!/PropertiesChanged \('org\.freedesktop\.NetworkManager',/.test(line)) return null
  const c = /'Connectivity': <uint32 (\d+)>/.exec(line)
  if (c) return c[1] === '4'
  const s = /'State': <uint32 (\d+)>/.exec(line)
  return s ? s[1] === '70' : null
}

/** WorkSuite web-app windows (worksuite-app <module>, Wayland app_id worksuite-<module>): the only domain source. */
export const isWorkSuiteWebApp = (appId: string) => /^worksuite-[a-z0-9-]+$/.test(appId) && !SHELL_IDS.has(appId)

/** Lines of a long-running `gdbus monitor` → fn(line). */
function monitorBus(args: string[], fn: (line: string) => void) {
  const child = spawn('gdbus', ['monitor', ...args], { stdio: ['ignore', 'pipe', 'ignore'] })
  let buf = ''
  child.stdout.setEncoding('utf8')
  child.stdout.on('data', (c: string) => {
    buf += c
    let nl: number
    while ((nl = buf.indexOf('\n')) >= 0) { const l = buf.slice(0, nl); buf = buf.slice(nl + 1); fn(l) }
  })
  child.on('error', () => {})
  return child
}

const SHELL_IDS = new Set(['worksuite-shell', 'worksuite', 'electron'])

export interface ActivityDeps {
  home: string
  now?: () => number
  session: () => Promise<{ token: string; apiBase: string } | null>
  device: () => string | null
  fetch: SendFetch & ((url: string, init: { headers: Record<string, string> }) => Promise<{ ok: boolean; status: number; json(): Promise<unknown> }>)
  broadcast: (channel: string, payload: unknown) => void
  /** $XDG_RUNTIME_DIR, where web-app windows leave their current domain (only read when the policy allows it). */
  runtimeDir?: string
}

export function startActivity(handle: Handle, d: ActivityDeps) {
  const now = d.now ?? Date.now
  const file = storePath(d.home)
  let policy: ActivityPolicy = activityPolicy(read)
  let tracker: ActivityTracker | null = null
  let lastSent: number | null = null
  let live: (LiveState & { at: number }) | null = null
  let focused: string | null = null
  let ack = loadStore(file).disclosure_ack
  const runtime = d.runtimeDir ?? process.env.XDG_RUNTIME_DIR ?? null

  const save = () => { if (tracker) { tracker.flush(); saveStore(file, tracker.store) } }
  const start = () => {
    const store = loadStore(file)
    tracker = new ActivityTracker(store, { now, idleThresholdS: policy.idle_threshold_s })
    tracker.prune(policy.retention_days)
    tracker.event('login')
    saveStore(file, store)
  }
  const apply = () => {
    const was = policy.enabled, wasWeb = policy.web_domains
    policy = activityPolicy(read)
    if (policy.enabled && !tracker) start()
    if (!policy.enabled && tracker) { tracker = null }
    // Off (or unmanaged): nothing recorded is kept on the device.
    if (!policy.enabled) { clearStore(file, ack); live = null }
    // Website tracking off: no domain is followed and the recorded ones are deleted.
    if (tracker && !policy.web_domains) { tracker.dropDomains(); saveStore(file, tracker.store) }
    if (tracker) readDomain()
    if (was !== policy.enabled || wasWeb !== policy.web_domains) d.broadcast('ws:activityChanged', view())
  }
  const view = () => { tracker?.flush(); return activityView(policy, tracker?.store ?? { ...loadStore(file), days: {} }, lastSent, live) }
  /** The focused WorkSuite web-app's domain, from the file its process keeps (electron/appwindow.ts). */
  const readDomain = () => {
    if (!tracker) return
    if (!policy.web_domains || !runtime || !focused || !isWorkSuiteWebApp(focused)) { tracker.setDomain(null); return }
    tracker.setDomain(read(webDomainFile(runtime, focused))?.trim() ?? null)
  }
  const heartbeat = async () => {
    if (!tracker) return
    const cur = tracker.current()
    const r = await sendLive(cur, await d.session().catch(() => null), d.device(), d.fetch)
    if (r.ok) live = { ...cur, at: now() }
  }

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
    monitorBus(['--system', '--dest', 'org.freedesktop.login1', '--object-path', `/org/freedesktop/login1/session/${session.replace(/[^A-Za-z0-9_]/g, '_')}`], (line) => {
      const ev = parseLogindLine(line)
      if (!ev || !tracker) return
      if (ev.lock !== undefined) tracker.lock(ev.lock)
      if (ev.idle !== undefined) tracker.idle(ev.idle)
      // The live view follows lock and idle at once, not only at the next 60 s heartbeat.
      void heartbeat()
    })
  }
  // #39: reports kept while offline go out as soon as NetworkManager reports full connectivity again.
  let online = true
  monitorBus(['--system', '--dest', 'org.freedesktop.NetworkManager', '--object-path', '/org/freedesktop/NetworkManager'], (line) => {
    const on = parseNmOnline(line)
    if (on === null) return
    if (on && !online) { void send(); void heartbeat() }
    online = on
  })
  // Web-app windows rewrite their domain file on navigation; follow it while one of them has the focus.
  if (runtime) {
    try {
      const dir = path.dirname(webDomainFile(runtime, 'x'))
      mkdirSync(dir, { recursive: true, mode: 0o700 })
      watch(dir, () => readDomain()).on('error', () => {})
    } catch { /* no runtime dir: domains are read on focus changes only */ }
  }
  const names = new Map<string, string>()
  const timers = [
    setInterval(apply, 5 * 60_000),
    setInterval(save, 60_000),
    setInterval(() => { void send() }, 15 * 60_000),
    // #39 live view: current state every minute while monitoring is on.
    setInterval(() => { void heartbeat() }, 60_000),
  ]
  for (const t of timers) t.unref?.()

  handle('ws:activityStatus', () => view())
  handle('ws:activityAck', () => {
    ack = disclosureVersion(policy)
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
      const b = await r.json() as { items?: unknown[]; device_events?: unknown[]; live?: unknown[] }
      return { ok: true, value: { items: Array.isArray(b.items) ? b.items : [], device_events: Array.isArray(b.device_events) ? b.device_events : [], live: Array.isArray(b.live) ? b.live : [] } }
    } catch { return { ok: false, error: 'offline' } }
  })

  return {
    /** Window list from the Wayland bridge: the activated app (not the shell) is the one being used. */
    windows(list: { appId: string; flags: number }[], activatedFlag: number) {
      if (!tracker) return
      const w = list.find((x) => x.flags & activatedFlag)
      if (!w || SHELL_IDS.has(w.appId.toLowerCase())) { focused = null; tracker.focus(null); return }
      let n = names.get(w.appId)
      if (!n) { n = appDisplayName(w.appId); names.set(w.appId, n) }
      const changed = focused !== w.appId
      focused = w.appId
      tracker.focus({ id: w.appId, name: n })
      if (changed) readDomain()
    },
    /** Network back: send what was kept offline. */
    online() { void send() },
    stop() { if (tracker) { tracker.event('logout'); save() } void send(); for (const t of timers) clearInterval(t) },
  }
}

// Settings › Privacy & security › App permissions (issue #21). Runtime permissions live where the OS enforces them:
// the XDG permission store that xdg-desktop-portal consults before it gives a sandboxed (Flatpak) app the camera,
// microphone, location, notifications, screenshots or background running. This module reads and changes that store
// (`flatpak permissions` / `permission-set` / `permission-remove` / `permission-reset`, fixed argv, no shell), applies
// the organization's deny rules from the signed device policy (app_permissions.deny), notices decisions the portal
// dialogs recorded since the last look (the "recent requests" list), and reports which apps use the camera or
// microphone right now (PipeWire). Policy can only take access away; it never writes "yes".
//
// What is NOT protected is said so: apps that are not sandboxed (APT packages, AppImages) reach devices directly, so
// for them these switches are not shown as protection (ENFORCEMENT below and the panel's "Not sandboxed" note).
import { appendFile, mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import type { Exec } from './system'

type Reply<T> = { ok: true; value: T } | { ok: false; error: string }

/** Permission-store backed resources: table, object id, and what "allowed"/"denied" are stored as. */
export const STORE_RESOURCES = {
  camera: { table: 'devices', id: 'camera', yes: 'yes', no: 'no' },
  microphone: { table: 'devices', id: 'microphone', yes: 'yes', no: 'no' },
  location: { table: 'location', id: 'location', yes: 'EXACT', no: 'NONE' },
  notifications: { table: 'notifications', id: 'notification', yes: 'yes', no: 'no' },
  screenshot: { table: 'screenshot', id: 'screenshot', yes: 'yes', no: 'no' },
  background: { table: 'background', id: 'background', yes: 'yes', no: 'no' },
} as const
export type StoreResource = keyof typeof STORE_RESOURCES
export const isStoreResource = (r: string): r is StoreResource => Object.hasOwn(STORE_RESOURCES, r)

/**
 * How each protected resource of issue #21 is enforced on WorkSuite OS, so the panel never presents a switch as
 * protection where an app could bypass it. `prompt`: asked per request (no stored grant to manage).
 */
export const ENFORCEMENT: Record<string, { mechanism: string; scope: 'sandboxed' | 'all' | 'none'; stored: boolean }> = {
  camera: { mechanism: 'portal', scope: 'sandboxed', stored: true },
  microphone: { mechanism: 'portal', scope: 'sandboxed', stored: true },
  location: { mechanism: 'portal', scope: 'sandboxed', stored: true },
  notifications: { mechanism: 'portal', scope: 'sandboxed', stored: true },
  screenshot: { mechanism: 'portal', scope: 'all', stored: true },
  background: { mechanism: 'portal', scope: 'sandboxed', stored: true },
  // Wayland: no app can capture the screen or inject input without the portal, which asks every time.
  screen_recording: { mechanism: 'screencast_prompt', scope: 'all', stored: false },
  remote_control: { mechanism: 'remote_desktop_prompt', scope: 'all', stored: false },
  // FileChooser/Documents portal: per file the user picks; static filesystem access is the app's Flatpak permission.
  files: { mechanism: 'file_chooser', scope: 'sandboxed', stored: false },
  usb: { mechanism: 'flatpak_static', scope: 'sandboxed', stored: false },
  bluetooth: { mechanism: 'flatpak_static', scope: 'sandboxed', stored: false },
  // Wayland gives the clipboard only to the focused app; there is no per-app read prompt to enforce.
  clipboard: { mechanism: 'wayland_focus', scope: 'all', stored: false },
  system_settings: { mechanism: 'polkit', scope: 'all', stored: false },
  admin: { mechanism: 'polkit', scope: 'all', stored: false },
}

export interface Grant { resource: StoreResource; app: string; allowed: boolean }
export interface AppPolicy { deny: Partial<Record<StoreResource, string[]>> }
export interface PermEvent { at: number; app: string; resource: string; action: 'allowed' | 'denied' | 'removed' | 'reset' | 'policy_denied'; by: 'user' | 'app_request' | 'policy' }

const APP_ID = /^[A-Za-z][A-Za-z0-9_-]*(\.[A-Za-z0-9_-]+){2,}$/

/** `flatpak permissions` (Table Object App Permissions Data; tab- or space-separated) → grants we manage. */
export function parsePermissions(text: string): Grant[] {
  const out: Grant[] = []
  for (const line of text.split('\n')) {
    const cols = (line.includes('\t') ? line.split('\t') : line.trim().split(/\s+/)).map((c) => c.trim())
    if (cols.length < 4) continue
    const [table, id, app, perms] = cols
    if (!APP_ID.test(app)) continue
    const res = (Object.keys(STORE_RESOURCES) as StoreResource[]).find((r) => STORE_RESOURCES[r].table === table && STORE_RESOURCES[r].id === id)
    if (!res) continue
    const v = perms.replace(/[[\]'"]/g, '').split(',')[0].trim()
    out.push({ resource: res, app, allowed: v === STORE_RESOURCES[res].yes || (res === 'location' && v !== 'NONE' && v !== '') })
  }
  return out
}

/** Signed policy (policy.json) → deny rules; anything malformed is ignored rather than guessed at. */
export function parseAppPolicy(policyJson: string | null): AppPolicy {
  const deny: AppPolicy['deny'] = {}
  try {
    const p = JSON.parse(policyJson ?? 'null') as { app_permissions?: { deny?: Record<string, unknown> } } | null
    for (const [r, apps] of Object.entries(p?.app_permissions?.deny ?? {})) {
      if (!isStoreResource(r) || !Array.isArray(apps)) continue
      deny[r] = apps.filter((a): a is string => typeof a === 'string' && (a === '*' || APP_ID.test(a)))
    }
  } catch { /* no policy */ }
  return { deny }
}

export const deniedByPolicy = (p: AppPolicy, r: StoreResource, app: string) => !!p.deny[r]?.some((a) => a === '*' || a === app)

/** Store entries that appeared or changed since the last snapshot: decisions made in portal dialogs. */
export function diffGrants(before: Grant[], after: Grant[], at: number): PermEvent[] {
  const key = (g: Grant) => `${g.resource}\u0000${g.app}`
  const old = new Map(before.map((g) => [key(g), g.allowed]))
  return after.filter((g) => old.get(key(g)) !== g.allowed).map((g) => ({ at, app: g.app, resource: g.resource, action: g.allowed ? 'allowed' : 'denied', by: 'app_request' as const }))
}

/** pw-dump → apps with a running capture stream on the camera or microphone. */
export function mediaInUse(json: string): { camera: string[]; microphone: string[] } {
  const out = { camera: new Set<string>(), microphone: new Set<string>() }
  try {
    for (const o of JSON.parse(json) as { type?: string; info?: { state?: string; props?: Record<string, unknown> } }[]) {
      if (o.type !== 'PipeWire:Interface:Node' || o.info?.state !== 'running') continue
      const p = o.info.props ?? {}
      const who = String(p['pipewire.access.portal.app_id'] ?? p['application.name'] ?? p['application.process.binary'] ?? '?')
      if (p['media.class'] === 'Stream/Input/Audio') out.microphone.add(who)
      else if (p['media.class'] === 'Stream/Input/Video' && !String(p['node.name'] ?? '').startsWith('xdpw_stream')) out.camera.add(who)
    }
  } catch { /* nothing known */ }
  return { camera: [...out.camera], microphone: [...out.microphone] }
}

export interface AppPermDeps {
  exec: Exec
  readPolicy(): string | null
  /** Per-user state: last store snapshot and the event log (~/.local/state/worksuite/permissions/). */
  stateDir: string
  now?: () => number
  read?(p: string): Promise<string | null>
  append?(p: string, s: string): Promise<void>
  write?(p: string, s: string): Promise<void>
}

export function appPermissionsBridge(d: AppPermDeps) {
  const now = d.now ?? Date.now
  const read = d.read ?? ((p: string) => readFile(p, 'utf8').catch(() => null))
  const append = d.append ?? (async (p: string, s: string) => { await mkdir(dirname(p), { recursive: true }); await appendFile(p, s, { mode: 0o600 }) })
  const write = d.write ?? (async (p: string, s: string) => { await mkdir(dirname(p), { recursive: true }); await writeFile(p, s, { mode: 0o600 }) })
  const logPath = join(d.stateDir, 'events.jsonl')
  const snapPath = join(d.stateDir, 'snapshot.json')
  const log = async (events: PermEvent[]) => { if (events.length) await append(logPath, events.map((e) => JSON.stringify(e)).join('\n') + '\n').catch(() => {}) }

  const list = async (): Promise<Reply<Grant[]>> => {
    const r = await d.exec('flatpak', ['permissions'])
    if (r.missing) return { ok: false, error: 'flatpak_missing' }
    return r.code === 0 ? { ok: true, value: parsePermissions(r.stdout) } : { ok: false, error: 'service_unavailable' }
  }
  const setStore = async (res: StoreResource, app: string, allow: boolean) => {
    const s = STORE_RESOURCES[res]
    const r = await d.exec('flatpak', ['permission-set', s.table, s.id, app, allow ? s.yes : s.no])
    return r.code === 0
  }
  const installedApps = async () => {
    const r = await d.exec('flatpak', ['list', '--app', '--columns=application'])
    return r.code === 0 ? r.stdout.split('\n').map((l) => l.trim()).filter((a) => APP_ID.test(a)) : []
  }

  /** Org deny rules → "no" in the store for each named (or, for "*", every installed) app. Idempotent. */
  const applyPolicy = async (): Promise<number> => {
    const pol = parseAppPolicy(d.readPolicy())
    const cur = await list()
    if (!cur.ok) return 0
    const apps = new Set([...cur.value.map((g) => g.app), ...(Object.values(pol.deny).some((a) => a?.includes('*')) ? await installedApps() : [])])
    const events: PermEvent[] = []
    for (const [res, rule] of Object.entries(pol.deny) as [StoreResource, string[]][]) {
      const targets = rule.includes('*') ? [...apps] : rule
      for (const app of targets) {
        if (cur.value.some((g) => g.resource === res && g.app === app && !g.allowed)) continue
        if (await setStore(res, app, false)) events.push({ at: now(), app, resource: res, action: 'policy_denied', by: 'policy' })
      }
    }
    await log(events)
    return events.length
  }

  return {
    /** Every stored grant, with policy locks, plus who uses the camera/microphone now. Records new portal decisions. */
    async state(): Promise<Reply<{ grants: (Grant & { locked: boolean })[]; inUse: { camera: string[]; microphone: string[] }; enforcement: typeof ENFORCEMENT }>> {
      await applyPolicy()
      const cur = await list()
      if (!cur.ok) return cur
      const prev = JSON.parse((await read(snapPath)) ?? '[]') as Grant[]
      await log(diffGrants(Array.isArray(prev) ? prev : [], cur.value, now()))
      await write(snapPath, JSON.stringify(cur.value)).catch(() => {})
      const pol = parseAppPolicy(d.readPolicy())
      const pw = await d.exec('pw-dump', [])
      return { ok: true, value: {
        grants: cur.value.map((g) => ({ ...g, locked: deniedByPolicy(pol, g.resource, g.app) })),
        inUse: pw.code === 0 ? mediaInUse(pw.stdout) : { camera: [], microphone: [] },
        enforcement: ENFORCEMENT,
      } }
    },
    async set(resource: string, app: string, allow: boolean): Promise<Reply<true>> {
      if (!isStoreResource(resource) || !APP_ID.test(app)) return { ok: false, error: 'invalid_argument' }
      if (allow && deniedByPolicy(parseAppPolicy(d.readPolicy()), resource, app)) return { ok: false, error: 'blocked_by_policy' }
      if (!(await setStore(resource, app, allow))) return { ok: false, error: 'failed' }
      await log([{ at: now(), app, resource, action: allow ? 'allowed' : 'denied', by: 'user' }])
      return { ok: true, value: true }
    },
    /** Forget the decision: the app is asked again next time it needs the resource. */
    async revoke(resource: string, app: string): Promise<Reply<true>> {
      if (!isStoreResource(resource) || !APP_ID.test(app)) return { ok: false, error: 'invalid_argument' }
      const s = STORE_RESOURCES[resource]
      const r = await d.exec('flatpak', ['permission-remove', s.table, s.id, app])
      if (r.code !== 0) return { ok: false, error: 'failed' }
      await log([{ at: now(), app, resource, action: 'removed', by: 'user' }])
      await applyPolicy()
      return { ok: true, value: true }
    },
    async reset(app: string): Promise<Reply<true>> {
      if (!APP_ID.test(app)) return { ok: false, error: 'invalid_argument' }
      const r = await d.exec('flatpak', ['permission-reset', app])
      if (r.code !== 0) return { ok: false, error: 'failed' }
      await log([{ at: now(), app, resource: '*', action: 'reset', by: 'user' }])
      await applyPolicy()
      return { ok: true, value: true }
    },
    /** Cheap poll for the taskbar indicator. */
    async inUse(): Promise<{ camera: string[]; microphone: string[] }> {
      const pw = await d.exec('pw-dump', [])
      return pw.code === 0 ? mediaInUse(pw.stdout) : { camera: [], microphone: [] }
    },
    async recent(limit = 30): Promise<PermEvent[]> {
      const text = (await read(logPath)) ?? ''
      return text.split('\n').filter(Boolean).slice(-limit).reverse().flatMap((l) => { try { return [JSON.parse(l) as PermEvent] } catch { return [] } })
    },
    applyPolicy,
  }
}

type Handle = (channel: string, fn: (...args: string[]) => unknown) => void
export function startAppPermissionsHost(handle: Handle, b: ReturnType<typeof appPermissionsBridge>) {
  handle('ws:portalPerms', () => b.state())
  handle('ws:portalPermSet', (res, app, on) => b.set(res, app, on === 'on'))
  handle('ws:portalPermRevoke', (res, app) => b.revoke(res, app))
  handle('ws:portalPermReset', (app) => b.reset(app))
  handle('ws:portalPermRecent', () => b.recent())
  handle('ws:mediaInUse', () => b.inUse())
  // Org deny rules hold even if someone edits the store by hand: re-applied at start and every 5 minutes.
  void b.applyPolicy().catch(() => {})
  setInterval(() => { void b.applyPolicy().catch(() => {}) }, 5 * 60_000).unref?.()
}

// Kiosk mode (WSOS-AUTH-002), pure parts: the kiosk config the device agent writes (/etc/worksuite/kiosk.json), the
// web kiosk's URL allowlist, its webPreferences, and which keys may reach the page. No Electron imports, so it is
// unit-tested; kioskMain.ts wires it to Electron.

export const KIOSK_CONFIG = '/etc/worksuite/kiosk.json'
export const KIOSK_MODULES = ['home', 'mail', 'chat', 'calendar', 'tasks', 'files', 'crm', 'hr'] as const
export type KioskApp = { type: 'url'; url: string } | { type: 'module'; id: string } | { type: 'desktop'; id: string }
export interface KioskConfig {
  user: string
  app: KioskApp
  allowed_urls: string[]
  idle_reset_minutes: number
  show_on_screen_keyboard: boolean
  exit_pin: boolean
}

const DESKTOP_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,150}\.desktop$/

/** Parses kiosk.json; anything unexpected → null (the kiosk shows "not available" rather than guessing). */
export function parseKioskConfig(json: string): KioskConfig | null {
  let d: Record<string, unknown>
  try { d = JSON.parse(json) } catch { return null }
  if (!d || typeof d !== 'object' || typeof d.user !== 'string') return null
  const a = d.app as Record<string, unknown> | undefined
  let app: KioskApp | null = null
  if (a?.type === 'url' && typeof a.url === 'string') {
    try { const u = new URL(a.url); if (u.protocol === 'https:' && !u.username && !u.password) app = { type: 'url', url: u.toString() } } catch { /* invalid */ }
  } else if (a?.type === 'module' && (KIOSK_MODULES as readonly unknown[]).includes(a.id)) app = { type: 'module', id: a.id as string }
  else if (a?.type === 'desktop' && typeof a.id === 'string' && DESKTOP_ID.test(a.id)) app = { type: 'desktop', id: a.id }
  if (!app) return null
  return {
    user: d.user, app,
    allowed_urls: Array.isArray(d.allowed_urls) ? d.allowed_urls.filter((x): x is string => typeof x === 'string') : [],
    idle_reset_minutes: Number.isInteger(d.idle_reset_minutes) ? d.idle_reset_minutes as number : 0,
    show_on_screen_keyboard: d.show_on_screen_keyboard === true,
    exit_pin: d.exit_pin === true,
  }
}

interface Rule { host: string; wildcard: boolean; port: string; path: string }

function rule(pattern: string): Rule | null {
  const m = /^https:\/\/(\*\.)?([a-z0-9.-]+)(?::(\d{1,5}))?(\/[^?#\s]*)?$/.exec(pattern)
  if (!m || !m[2].includes('.')) return null
  return { wildcard: !!m[1], host: m[2], port: m[3] ?? '', path: m[4] ?? '/' }
}

/**
 * The web kiosk's allowlist: the start page's origin (whole site) plus the policy's `allowed_urls` patterns
 * (`https://host[:port][/path-prefix]`, `*.host` for subdomains). https only; no credentials; paths match on
 * segment boundaries, so `/kiosk` allows `/kiosk` and `/kiosk/…` but not `/kiosk-admin`.
 */
export function urlAllowlist(cfg: Pick<KioskConfig, 'app' | 'allowed_urls'>): (raw: string) => boolean {
  const rules: Rule[] = []
  if (cfg.app.type === 'url') { const u = new URL(cfg.app.url); rules.push({ host: u.hostname, wildcard: false, port: u.port, path: '/' }) }
  for (const p of cfg.allowed_urls) { const r = rule(p); if (r) rules.push(r) }
  return (raw: string) => {
    let u: URL
    try { u = new URL(raw) } catch { return false }
    if (u.protocol !== 'https:' || u.username || u.password) return false
    return rules.some((r) => {
      const hostOk = r.wildcard ? u.hostname.endsWith('.' + r.host) : u.hostname === r.host
      if (!hostOk || u.port !== r.port) return false
      if (r.path === '/') return true
      const base = r.path.endsWith('/') ? r.path : r.path + '/'
      return u.pathname === r.path || u.pathname.startsWith(base)
    })
  }
}

/** webPreferences of the web kiosk: sandboxed, no Node, no devtools, a fresh in-memory profile per reset. */
export function kioskWebPreferences(preload: string, generation: number) {
  return {
    preload, sandbox: true, contextIsolation: true, nodeIntegration: false, nodeIntegrationInWorker: false,
    nodeIntegrationInSubFrames: false, webSecurity: true, allowRunningInsecureContent: false, webviewTag: false,
    devTools: false, spellcheck: false, navigateOnDragDrop: false, safeDialogs: true,
    // No "persist:" prefix: Chromium keeps this partition in memory only, so cookies, storage and cache vanish with it.
    partition: `kiosk-${generation}`,
  }
}

export interface KeyInput { type: string; key: string; control: boolean; alt: boolean; shift: boolean; meta: boolean }

/** Ctrl+Alt+Shift+K: the admin exit gesture (also bound in the kiosk Labwc config). */
export const isExitGesture = (i: KeyInput) => i.type === 'keyDown' && i.control && i.alt && i.shift && !i.meta && i.key.toLowerCase() === 'k'

/**
 * Keys the kiosk page never receives: browser shortcuts that would leave, reload into another state, print, save,
 * open devtools, zoom the UI, or open windows. Typing, Tab, arrows, Enter, Backspace and Escape still work.
 */
export function blockedKey(i: KeyInput): boolean {
  if (i.type !== 'keyDown') return false
  const k = i.key.toLowerCase()
  if (i.meta) return true                                             // Super/logo combinations
  if (/^f([1-9]|1[0-2])$/.test(k)) return true                        // F5 reload, F11 fullscreen, F12 devtools, …
  if (i.alt && (k === 'arrowleft' || k === 'arrowright' || k === 'home' || k === 'f4')) return true
  if (i.control && !i.alt && ['n', 't', 'w', 'r', 'p', 's', 'o', 'u', 'j', 'h', 'f', 'g', 'l', 'd', 'q', '+', '-', '=', '0', 'tab'].includes(k)) return true
  if (i.control && i.shift && ['i', 'j', 'c', 'delete', 'n', 't'].includes(k)) return true
  return false
}

/** Exit codes of worksuite-kiosk-exit → what the exit prompt shows. */
export type ExitResult = 'ok' | 'wrong_pin' | 'locked_out' | 'pin_disabled' | 'cancelled' | 'failed'
export function exitResult(code: number | null): ExitResult {
  switch (code) {
    case 0: return 'ok'
    case 3: return 'wrong_pin'
    case 4: return 'locked_out'
    case 5: return 'pin_disabled'
    case 126: case 127: return 'cancelled'   // pkexec: authentication dismissed / not authorised
    default: return 'failed'
  }
}

/** Exponential back-off for restarting a crashed kiosk app: 1 s, 2 s, 4 s … capped at 30 s; reset after a stable run. */
export function restartDelay(recentFailures: number): number {
  return Math.min(30_000, 1000 * 2 ** Math.max(0, recentFailures - 1))
}

/** The 5-tap corner gesture: five taps within 3 s in the top-left 64×64 px. */
export function tapCounter(now: () => number = Date.now) {
  let taps: number[] = []
  return (x: number, y: number): boolean => {
    if (x > 64 || y > 64) { taps = []; return false }
    const t = now()
    taps = [...taps.filter((p) => t - p < 3000), t]
    if (taps.length >= 5) { taps = []; return true }
    return false
  }
}

/**
 * argv of a .desktop Exec line for the kiosk (no shell): quoted words kept, field codes (%f, %U, …) dropped, `%%` → `%`.
 * Returns null for an empty line or one that tries to run through a shell or env assignment.
 */
export function desktopExecArgv(exec: string | null | undefined): string[] | null {
  if (!exec) return null
  const out: string[] = []
  const re = /"((?:[^"\\]|\\.)*)"|(\S+)/g
  for (const m of exec.matchAll(re)) {
    const w = m[1] !== undefined ? m[1].replace(/\\(.)/g, '$1') : m[2]
    if (/^%[fFuUdDnNickvm]$/.test(w)) continue
    out.push(w.replace(/%%/g, '%'))
  }
  if (!out.length || /^(sh|bash|dash|zsh|env)$/.test(out[0].split('/').pop()!)) return null
  return out
}

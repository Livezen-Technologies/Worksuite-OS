// WorkSuite web apps ("WorkSuite Desktop"): which module to open, where it lives and what an app window may load.
// Electron-free so it can be unit tested; the window itself is in appwindow.ts.

export const WEB_APP_ID = /^[a-z][a-z0-9_-]{0,63}$/

export interface WebApp { id: string; name: string; web_url: string; offline_level?: OfflineLevel }
/** WSOS-SYN-009: what each app declares in bootstrap (api-contracts/openapi.yaml). */
export type OfflineLevel = 'full_offline' | 'cached_read' | 'online_only'
export const offlineLevel = (v: unknown): OfflineLevel | undefined => (v === 'full_offline' || v === 'cached_read' || v === 'online_only' ? v : undefined)

/** What `worksuite-app <module>` / `worksuite-app worksuite://<module>/<route>` asked for. */
export interface AppRequest { id: string; link: string | null }

/**
 * The shell runs as an app window when started with --worksuite-app=<id>, --worksuite-app <id> or a worksuite://
 * link (the URL handler). Anything that isn't a valid module key is ignored, so the shell starts normally.
 */
export function parseAppArgs(argv: string[]): AppRequest | null {
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    let v: string | undefined
    if (a.startsWith('--worksuite-app=')) v = a.slice('--worksuite-app='.length)
    else if (a === '--worksuite-app') v = argv[i + 1]
    if (v === undefined) continue
    if (v.startsWith('worksuite:')) return linkRequest(v)
    if (WEB_APP_ID.test(v)) {
      const link = argv.slice(i + 1).find((x) => x.startsWith('worksuite:'))
      return { id: v, link: link && linkRequest(link)?.id === v ? link : null }
    }
    return null
  }
  return null
}

export function linkRequest(link: string): AppRequest | null {
  try {
    const u = new URL(link)
    return u.protocol === 'worksuite:' && WEB_APP_ID.test(u.hostname) ? { id: u.hostname, link: u.toString() } : null
  } catch { return null }
}

/** https URL, or null. Plain http only for loopback (development servers). */
export function safeUrl(s: unknown): URL | null {
  if (typeof s !== 'string') return null
  try {
    const u = new URL(s)
    if (u.username || u.password) return null
    if (u.protocol === 'https:') return u
    if (u.protocol === 'http:' && (u.hostname === '127.0.0.1' || u.hostname === 'localhost' || u.hostname === '[::1]')) return u
    return null
  } catch { return null }
}

/**
 * Web apps from /desktop/v1/bootstrap. `apps` (with web_url) is the contract; a server that predates it gets the
 * default layout <api_base>/apps/<id>/ for the fallback ids. Entries with unsafe URLs are dropped.
 */
export function webAppsFrom(bootstrap: unknown, apiBase: string, fallbackIds: string[] = []): WebApp[] {
  const b = (bootstrap ?? {}) as { apps?: unknown }
  if (Array.isArray(b.apps)) {
    const out: WebApp[] = []
    for (const a of b.apps as Record<string, unknown>[]) {
      const id = typeof a?.id === 'string' ? a.id : ''
      const url = safeUrl(a?.web_url)
      if (!WEB_APP_ID.test(id) || !url || out.some((x) => x.id === id)) continue
      const level = offlineLevel(a.offline_level)
      out.push({ id, name: typeof a.name === 'string' && a.name ? a.name : id, web_url: url.toString(), ...(level ? { offline_level: level } : {}) })
    }
    return out
  }
  const base = safeUrl(apiBase)
  if (!base) return []
  return fallbackIds.filter((id) => WEB_APP_ID.test(id)).map((id) => ({ id, name: id, web_url: new URL(`apps/${id}/`, base.toString().replace(/\/?$/, '/')).toString() }))
}

/** Origins an app window may navigate within (and send the WorkSuite token to): the module's own origin. */
export function allowedOrigins(app: WebApp): Set<string> {
  return new Set([new URL(app.web_url).origin])
}

export type NavDecision = 'allow' | 'external' | 'deny'

/** In-window for the allowed origins; https/mailto/tel elsewhere goes to the default browser; everything else is blocked. */
/** Modules that may ask to share the screen (Meet ENH-01, SRS §7.1). */
export const SCREEN_SHARE_MODULES = new Set(['meet'])
/** getDisplayMedia from a module page: only Meet, only from its own origin. The portal then asks the user
 * (worksuite-screencast-chooser) on every request; nothing is granted here. */
export function screenShareAllowed(moduleId: string, frameUrl: string, origins: Set<string>): boolean {
  return SCREEN_SHARE_MODULES.has(moduleId) && navDecision(frameUrl, origins) === 'allow'
}

export function navDecision(url: string, origins: Set<string>): NavDecision {
  let u: URL
  try { u = new URL(url) } catch { return 'deny' }
  if ((u.protocol === 'https:' || u.protocol === 'http:') && origins.has(u.origin) && safeUrl(u.toString())) return 'allow'
  if (u.protocol === 'https:' || u.protocol === 'mailto:' || u.protocol === 'tel:') return 'external'
  return 'deny'
}

/** The token is attached only to requests for the allowed origins, never to third parties. */
export function wantsToken(url: string, origins: Set<string>): boolean {
  return navDecision(url, origins) === 'allow'
}

/** The URL to open: a resolved link if it belongs to this app's origin, else the module's start page. */
export function startUrl(app: WebApp, resolvedLink: string | null): string {
  if (resolvedLink && navDecision(resolvedLink, allowedOrigins(app)) === 'allow') return resolvedLink
  return app.web_url
}

export type DeviceCredential = () => string | null

/** Headers for a request to an allowed origin: the token, plus X-WS-Device when enrolled. Nothing for other origins. */
export function appAuthHeaders(url: string, origins: Set<string>, token: string, device: DeviceCredential): Record<string, string> {
  if (!wantsToken(url, origins)) return {}
  const d = device()
  return d ? { Authorization: `Bearer ${token}`, 'X-WS-Device': d } : { Authorization: `Bearer ${token}` }
}

const authHeaders = (token: string, device?: DeviceCredential): Record<string, string> => {
  const d = device?.()
  return d ? { authorization: `Bearer ${token}`, 'x-ws-device': d } : { authorization: `Bearer ${token}` }
}

/** Server the sign-in should go to: the enrolled org's server, then a previous account's, then WorkSuite Cloud. */
export function signInTarget(deviceServer: string | null, accounts: { server_url: string }[]): { server_url: string; mode: 'personal' | 'enterprise' } {
  if (deviceServer && safeUrl(deviceServer)) return { server_url: deviceServer, mode: 'enterprise' }
  const prev = accounts.find((a) => safeUrl(a.server_url))
  if (prev) return { server_url: prev.server_url, mode: new URL(prev.server_url).hostname.endsWith('worksuitecloud.com') ? 'personal' : 'enterprise' }
  return { server_url: 'https://worksuitecloud.com', mode: 'personal' }
}

export const FALLBACK_WEB_APPS: { id: string; name: string }[] = [
  { id: 'mail', name: 'Mail' }, { id: 'calendar', name: 'Calendar' }, { id: 'chat', name: 'Chat' },
  { id: 'drive', name: 'Drive' }, { id: 'tasks', name: 'Tasks' }, { id: 'projects', name: 'Projects' },
  { id: 'crm', name: 'CRM' }, { id: 'meet', name: 'Meet' },
  { id: 'pdf-studio', name: 'PDF Studio' },
]

export type Fetch = (url: string, init?: { headers?: Record<string, string> }) => Promise<{ ok: boolean; status: number; json(): Promise<unknown> }>
export type Broker = (method: string, params?: Record<string, unknown>) => Promise<{ ok: true; value: unknown } | { ok: false; error: string }>

export interface Session { account: { id: string; server_url: string }; token: string; apiBase: string; apps: WebApp[] }
export type SessionResult = { ok: true; value: Session } | { ok: false; error: 'not_signed_in' | 'locked' | 'auth_required' | 'offline' | 'device_required' | 'server_error' }

/** Signed-in account → access token (from the broker) → api_base → bootstrap apps. */
export async function loadSession(broker: Broker, fetchFn: Fetch, device?: DeviceCredential): Promise<SessionResult> {
  const st = await broker('Status')
  if (!st.ok) return { ok: false, error: 'not_signed_in' }
  const accounts = (Array.isArray(st.value) ? st.value : []) as { id: string; server_url: string; state?: string }[]
  const acct = accounts.find((a) => a.state === 'signed_in') ?? accounts[0]
  if (!acct) return { ok: false, error: 'not_signed_in' }
  if (acct.state === 'locked') return { ok: false, error: 'locked' }
  const t = await broker('GetAccessToken', { account_id: acct.id })
  if (!t.ok || typeof t.value !== 'string') return { ok: false, error: t.ok ? 'server_error' : t.error === 'broker_unavailable' ? 'not_signed_in' : 'auth_required' }
  const server = safeUrl(acct.server_url)
  if (!server) return { ok: false, error: 'server_error' }
  try {
    let apiBase = server.toString()
    const wk = await fetchFn(new URL('/.well-known/worksuite-desktop', server).toString())
    if (wk.ok) { const b = (await wk.json()) as { api_base?: unknown }; if (safeUrl(b.api_base)) apiBase = String(b.api_base) }
    apiBase = apiBase.replace(/\/?$/, '/')
    const r = await fetchFn(new URL('desktop/v1/bootstrap', apiBase).toString(), { headers: authHeaders(t.value, device) })
    const body = await r.json().catch(() => null)
    if (!r.ok) {
      const code = (body as { error?: { code?: string } } | null)?.error?.code
      return { ok: false, error: code === 'DEVICE_REQUIRED' ? 'device_required' : r.status === 401 ? 'auth_required' : 'server_error' }
    }
    return { ok: true, value: { account: acct, token: t.value, apiBase, apps: webAppsFrom(body, apiBase, FALLBACK_WEB_APPS.map((a) => a.id)) } }
  } catch { return { ok: false, error: 'offline' } }
}

/** worksuite:// link → web_url via /desktop/v1/links/resolve (null if the server can't place it). */
export async function resolveLink(s: Session, link: string, fetchFn: Fetch, device?: DeviceCredential): Promise<string | null> {
  try {
    const r = await fetchFn(new URL(`desktop/v1/links/resolve?url=${encodeURIComponent(link)}`, s.apiBase).toString(), { headers: authHeaders(s.token, device) })
    if (!r.ok) return null
    const b = (await r.json()) as { web_url?: unknown }
    return safeUrl(b.web_url)?.toString() ?? null
  } catch { return null }
}

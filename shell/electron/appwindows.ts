// WorkSuite business apps in their own windows, one persistent Electron session partition per app (WSOS-SEC-004):
// cookies, storage, cache and permission grants of one app are invisible to every other app and to the shell.
// Windows are sandboxed, context-isolated, without Node or a preload, and stay on the app's own HTTPS origin.
export const APP_ID = /^[a-z][a-z0-9-]{0,62}$/

export function partitionFor(appId: string): string {
  if (!APP_ID.test(appId)) throw new Error('invalid app id')
  return `persist:ws-app-${appId}`
}

export function appOrigin(raw: string): string | null {
  try {
    const u = new URL(raw)
    return u.protocol === 'https:' && !u.username && !u.password ? u.origin : null
  } catch { return null }
}

/** Same-origin navigations stay in the window; everything else goes to the system browser (if allowed) or nowhere. */
export function navigationDecision(appUrl: string, target: string): 'allow' | 'external' | 'deny' {
  const origin = appOrigin(appUrl)
  let t: URL
  try { t = new URL(target) } catch { return 'deny' }
  if (origin && t.origin === origin) return 'allow'
  return ['https:', 'mailto:', 'tel:'].includes(t.protocol) ? 'external' : 'deny'
}

export interface WindowLike {
  loadURL(url: string): Promise<void>
  focus(): void
  isDestroyed(): boolean
  on(ev: 'closed', fn: () => void): void
  webContents: {
    on(ev: 'will-navigate', fn: (e: { preventDefault(): void }, url: string) => void): void
    setWindowOpenHandler(fn: (d: { url: string }) => { action: 'deny' }): void
  }
}
export interface SessionLike { setPermissionRequestHandler(fn: (wc: unknown, perm: string, cb: (ok: boolean) => void) => void): void }
export interface AppWindowHost {
  session(partition: string): SessionLike
  window(opts: { partition: string; title: string }): WindowLike
  openExternal(url: string): void
}

/** Webpreferences every app window gets; exported for tests and for main.ts. */
export const appWebPreferences = (partition: string) => ({
  partition, sandbox: true, contextIsolation: true, nodeIntegration: false, webSecurity: true,
  allowRunningInsecureContent: false, webviewTag: false, spellcheck: false,
})

export function appWindows(host: AppWindowHost) {
  const open = new Map<string, WindowLike>()
  return {
    open(appId: string, url: string): { ok: true } | { ok: false; error: string } {
      if (!APP_ID.test(appId)) return { ok: false, error: 'invalid_app' }
      if (!appOrigin(url)) return { ok: false, error: 'insecure_url' }
      const existing = open.get(appId)
      if (existing && !existing.isDestroyed()) { existing.focus(); return { ok: true } }
      const partition = partitionFor(appId)
      // Web permissions (camera, notifications, …) denied in every app partition (WSOS-SEC-003).
      host.session(partition).setPermissionRequestHandler((_wc, _perm, cb) => cb(false))
      const w = host.window({ partition, title: appId })
      w.webContents.on('will-navigate', (e, target) => {
        const d = navigationDecision(url, target)
        if (d !== 'allow') { e.preventDefault(); if (d === 'external') host.openExternal(target) }
      })
      w.webContents.setWindowOpenHandler(({ url: target }) => {
        if (navigationDecision(url, target) !== 'deny') host.openExternal(target)
        return { action: 'deny' }
      })
      w.on('closed', () => open.delete(appId))
      open.set(appId, w)
      void w.loadURL(url)
      return { ok: true }
    },
  }
}

// `worksuite-app <module>`: one WorkSuite web module in its own window (WorkSuite Desktop).
// One process per module (its own userData, single-instance lock and Wayland app_id worksuite-<module>), a persistent
// partition per account, navigation kept on the module's origin, and the broker's access token attached as a Bearer
// header to that origin only. No Node, sandboxed, context-isolated, no preload in the web content. Sign-in never
// happens in this window: the "Sign in to WorkSuite" state asks the broker, which uses the system browser (PKCE).
import { app, BrowserWindow, desktopCapturer, session, shell } from 'electron'
import os from 'node:os'
import path from 'node:path'
import { brokerCall } from './broker'
import { deviceCredential, deviceInfo } from './device'
import {
  allowedOrigins, appAuthHeaders, appProcessNames, isPrintShortcut, linkRequest, loadSession, navDecision, resolveLink, screenShareAllowed, signInTarget, startUrl, wantsToken,
  type AppRequest, type Fetch, type Session, type WebApp,
} from './webapps'
import { pickLocale, translate, type MessageKey } from '../src/i18n/core'
import { xdgDirs } from './xdgDirs'

const fetchFn: Fetch = (url, init) => fetch(url, { headers: init?.headers, redirect: 'follow' })
const broker = (m: string, p?: Record<string, unknown>) => brokerCall(m, p ?? {}, m === 'SignIn' ? 6 * 60_000 : 15_000)
/** The session's language (LANG / LC_MESSAGES via Electron), read once the app is ready. */
const tr = (key: MessageKey, vars?: Record<string, string | number>) => translate(pickLocale(app.isReady() ? app.getLocale() : process.env.LANG), key, vars)
const TITLE: Record<string, string> = { mail: 'Mail', calendar: 'Calendar', chat: 'Chat', drive: 'Drive', tasks: 'Tasks', projects: 'Projects', crm: 'CRM', meet: 'Meet', 'pdf-studio': 'PDF Studio' }

/** Must run before app 'ready'. Returns false when another process already shows this module (it gets the request). */
export function prepareAppMode(req: AppRequest): boolean {
  const names = appProcessNames(req.id, TITLE[req.id])
  app.setName(names.name)
  // Linux-only (undocumented in the typings): the Wayland app_id, matching the .desktop file.
  ;(app as unknown as { setDesktopName?: (n: string) => void }).setDesktopName?.(names.desktop)
  app.commandLine.appendSwitch('class', `worksuite-${req.id}`)
  // Screen capture on Wayland goes through the xdg-desktop-portal ScreenCast path (PipeWire), SRS §7.1.
  app.commandLine.appendSwitch('enable-features', 'WebRTCPipeWireCapturer')
  app.setPath('userData', path.join(xdgDirs(os.homedir()).data, 'worksuite/apps', req.id))
  return app.requestSingleInstanceLock(req)
}

export function runAppMode(req: AppRequest) {
  let win: BrowserWindow | null = null
  let current: { s: Session; app: WebApp } | null = null
  let token = { value: '', at: 0 }

  async function freshToken() {
    if (current && Date.now() - token.at > 60_000) {
      const r = await broker('GetAccessToken', { account_id: current.s.account.id })
      if (r.ok && typeof r.value === 'string') token = { value: r.value, at: Date.now() }
    }
    return token.value
  }

  function guard(w: BrowserWindow, origins: () => Set<string>) {
    const wc = w.webContents
    const onNav = (e: { preventDefault(): void }, url: string) => {
      if (url.startsWith('data:') && !current) return // our own state page
      const d = navDecision(url, origins())
      if (d === 'allow') return
      e.preventDefault()
      if (d === 'external') void shell.openExternal(url)
    }
    wc.on('will-navigate', onNav)
    wc.on('will-redirect', onNav)
    wc.on('will-frame-navigate', (e) => { if (!e.isMainFrame) return; onNav(e, e.url) })
    wc.setWindowOpenHandler(({ url }) => {
      const d = navDecision(url, origins())
      if (d === 'allow') return { action: 'allow', overrideBrowserWindowOptions: { autoHideMenuBar: true, webPreferences: webPrefs(current?.s.account.id) } }
      if (d === 'external') void shell.openExternal(url)
      return { action: 'deny' }
    })
    wc.on('did-create-window', (child) => guard(child, origins))
    // Printing like any desktop app: Ctrl+P (and window.print() from the page) opens the system print dialog.
    wc.on('before-input-event', (e, input) => { if (isPrintShortcut(input)) { e.preventDefault(); wc.print({}) } })
  }

  function webPrefs(accountId?: string) {
    return {
      partition: accountId ? `persist:account-${accountId.replace(/[^A-Za-z0-9_-]/g, '_')}` : undefined,
      sandbox: true, contextIsolation: true, nodeIntegration: false, webSecurity: true,
      nodeIntegrationInSubFrames: false, webviewTag: false, spellcheck: true,
    }
  }

  function statePage(title: string, detail: string, action: string | null) {
    const esc = (s: string) => s.replace(/[&<>"]/g, (c) => `&#${c.charCodeAt(0)};`)
    const html = `<!doctype html><html lang="${esc(tr('appwin.lang'))}"><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'">
<title>${esc(title)}</title><style>
:root{color-scheme:light dark;--bg:#f8fafc;--card:#fff;--fg:#0f172a;--muted:#475569;--accent:#2563eb}
@media (prefers-color-scheme:dark){:root{--bg:#0f172a;--card:#1e293b;--fg:#f8fafc;--muted:#94a3b8}}
body{margin:0;height:100vh;display:grid;place-items:center;background:var(--bg);color:var(--fg);font:15px/1.5 system-ui,sans-serif}
.c{background:var(--card);border-radius:16px;padding:32px 36px;max-width:420px;text-align:center;box-shadow:0 12px 32px rgba(2,6,23,.12)}
.m{width:56px;height:56px;border-radius:14px;margin:0 auto 16px;background:#0A6CFF;color:#fff;display:grid;place-items:center;font-weight:700;font-size:22px}
h1{font-size:20px;margin:0 0 8px}p{color:var(--muted);margin:0 0 20px}
button{background:var(--accent);color:#fff;border:0;border-radius:10px;height:40px;padding:0 20px;font:600 14px system-ui;cursor:pointer}
button:disabled{opacity:.6}</style></head><body><div class="c"><div class="m">W</div><h1>${esc(title)}</h1><p id="d">${esc(detail)}</p>
${action ? `<button id="b">${esc(action)}</button><script>document.getElementById('b').onclick=function(){this.disabled=true;document.getElementById('d').textContent=${JSON.stringify(tr('appwin.continueBrowser'))};location.hash='signin'}</script>` : ''}
</div></body></html>`
    void win?.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(html)}`)
  }

  async function signIn() {
    const st = await broker('Status')
    const accounts = st.ok && Array.isArray(st.value) ? st.value as { server_url: string }[] : []
    const t = signInTarget(deviceInfo().server, accounts)
    const r = await broker('SignIn', { server_url: t.server_url, mode: t.mode })
    if (r.ok) await open(req)
    else statePage(tr('appwin.signInTitle'), tr('appwin.unfinished'), tr('greeter.signIn'))
  }

  async function open(r: AppRequest) {
    if (!win) return
    const name = TITLE[r.id] ?? r.id
    win.setTitle(`WorkSuite ${name}`)
    const res = await loadSession(broker, fetchFn, () => deviceCredential())
    if (!res.ok) {
      current = null
      const msg: Record<string, [string, string, string | null]> = {
        not_signed_in: [tr('appwin.signInTitle'), tr('appwin.notSignedIn', { name }), tr('greeter.signIn')],
        auth_required: [tr('appwin.signInTitle'), tr('appwin.ended'), tr('greeter.signIn')],
        locked: [tr('appwin.locked'), tr('appwin.lockedBody'), null],
        offline: [tr('appwin.offline'), tr('appwin.offlineBody', { name }), null],
        device_required: [tr('appwin.notEnrolled'), tr('appwin.notEnrolledBody'), null],
        server_error: [tr('appwin.unavailable'), tr('appwin.unavailableBody'), null],
      }
      const [t, d, a] = msg[res.error]
      statePage(t, d, a)
      return
    }
    const target = res.value.apps.find((a) => a.id === r.id)
    if (!target) { current = null; statePage(tr('appwin.appUnavailable', { name }), tr('appwin.notEnabled', { name }), null); return }
    current = { s: res.value, app: target }
    token = { value: res.value.token, at: Date.now() }
    const ses = session.fromPartition(webPrefs(res.value.account.id).partition!)
    const origins = allowedOrigins(target)
    const patterns = [...origins].map((o) => `${o}/*`)
    ses.webRequest.onBeforeSendHeaders({ urls: patterns }, (details, cb) => {
      const allowed = allowedOrigins(current?.app ?? target)
      if (!wantsToken(details.url, allowed)) return cb({ requestHeaders: details.requestHeaders })
      // X-WS-Device is read fresh per request (revocation takes effect immediately) and is set here in the main process only.
      void freshToken().then((t) => cb({ requestHeaders: { ...details.requestHeaders, ...appAuthHeaders(details.url, allowed, t, () => deviceCredential()) } }))
    })
    // Camera/microphone/notifications/clipboard for the module's own origin only (Meet, Chat); nothing else.
    const OK = new Set(['media', 'notifications', 'clipboard-sanitized-write', 'fullscreen'])
    ses.setPermissionRequestHandler((wc, perm, cb) => cb(OK.has(perm) && navDecision(wc.getURL(), allowedOrigins(target)) === 'allow'))
    ses.setPermissionCheckHandler((_wc, perm, origin) => OK.has(perm) && allowedOrigins(target).has(origin))
    // Meet screen sharing (SRS §7.1): getSources goes to the ScreenCast portal, whose chooser asks the user every time;
    // cancelling there denies. The panel shows "Sharing screen" with Stop, and Super+Shift+Esc stops it anywhere.
    ses.setDisplayMediaRequestHandler((request, cb) => {
      if (!screenShareAllowed(r.id, request.frame?.url ?? '', allowedOrigins(target))) { cb({}); return }
      desktopCapturer.getSources({ types: ['screen'] })
        .then((sources) => { if (sources[0]) { cb({ video: sources[0] }) } else { cb({}) } })
        .catch(() => cb({}))
    })
    if (win.webContents.session !== ses) {
      // The partition is fixed per window; recreate the window for this account.
      const old = win
      win = makeWindow(res.value.account.id)
      old.destroy()
    }
    const link = r.link ? await resolveLink(res.value, r.link, fetchFn, () => deviceCredential()) : null
    void win.loadURL(startUrl(target, link))
  }

  function makeWindow(accountId?: string) {
    const w = new BrowserWindow({
      width: 1280, height: 820, minWidth: 480, minHeight: 360, autoHideMenuBar: true, backgroundColor: '#f8fafc',
      title: `WorkSuite ${TITLE[req.id] ?? req.id}`,
      icon: `/usr/share/icons/hicolor/256x256/apps/worksuite-${req.id}.png`,
      webPreferences: webPrefs(accountId),
    })
    guard(w, () => current ? allowedOrigins(current.app) : new Set())
    w.webContents.on('did-navigate-in-page', (_e, url) => { if (!current && url.endsWith('#signin')) void signIn() })
    w.on('page-title-updated', (e) => { if (!current) e.preventDefault() })
    return w
  }

  app.on('second-instance', (_e, _argv, _cwd, data) => {
    const r = data as AppRequest | null
    if (!win) return
    if (win.isMinimized()) win.restore()
    win.focus()
    if (r?.link && linkRequest(r.link)?.id === req.id) void open(r)
  })

  void app.whenReady().then(() => {
    session.defaultSession.setPermissionRequestHandler((_wc, _p, cb) => cb(false))
    win = makeWindow()
    void open(req)
  })
  app.on('window-all-closed', () => app.quit())
}

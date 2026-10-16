// `worksuite-app whatsapp`: WhatsApp Web in its own app window (WhatsApp has no native Linux app).
// Like the WorkSuite web app windows (appwindow.ts): one process with its own userData and single-instance lock,
// sandboxed, context-isolated, no preload, closing the window quits it. Differences: no WorkSuite account or token at
// all, its own persistent partition (persist:whatsapp) so the QR link survives restarts and no cookie is shared with
// WorkSuite, navigation kept on WhatsApp's hosts (whatsapp.ts), and a Chrome user agent WhatsApp Web accepts.
import { app, BrowserWindow, desktopCapturer, dialog, Notification, session, shell } from 'electron'
import { existsSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { deviceInfo } from './device'
import { pickLocale, translate, type MessageKey } from '../src/i18n/core'
import { xdgDirs } from './xdgDirs'
import {
  chromeUserAgent, downloadPath, mediaKind, unreadFromTitle, whatsappAllowed, whatsappHost, whatsappNav, whatsappPermission, whatsappPopup,
  WHATSAPP_APP_ID, WHATSAPP_ID, WHATSAPP_PARTITION, WHATSAPP_URL,
} from './whatsapp'

const tr = (key: MessageKey, vars?: Record<string, string | number>) => translate(pickLocale(app.isReady() ? app.getLocale() : process.env.LANG), key, vars)
const ICON = `/usr/share/icons/hicolor/256x256/apps/${WHATSAPP_APP_ID}.png`

/** Must run before app 'ready'. False when WhatsApp is already open (that window is focused instead). */
export function prepareWhatsApp(): boolean {
  app.setName(WHATSAPP_APP_ID)
  ;(app as unknown as { setDesktopName?: (n: string) => void }).setDesktopName?.(`${WHATSAPP_APP_ID}.desktop`)
  app.commandLine.appendSwitch('class', WHATSAPP_APP_ID)
  app.commandLine.appendSwitch('enable-features', 'WebRTCPipeWireCapturer')
  app.setPath('userData', path.join(xdgDirs(os.homedir()).data, 'worksuite/apps', WHATSAPP_ID))
  return app.requestSingleInstanceLock()
}

export function runWhatsApp() {
  let win: BrowserWindow | null = null
  let unread = 0
  let note: Notification | null = null
  // Camera/microphone answers for this run only; asked again after a restart.
  const consent = new Map<string, boolean>()

  const focus = () => { if (!win) return; if (win.isMinimized()) win.restore(); win.show(); win.focus() }

  function offPage() {
    const esc = (s: string) => s.replace(/[&<>"]/g, (c) => `&#${c.charCodeAt(0)};`)
    const html = `<!doctype html><html><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'">
<title>WhatsApp</title><style>:root{color-scheme:light dark}body{margin:0;height:100vh;display:grid;place-items:center;font:15px/1.5 system-ui,sans-serif}
.c{max-width:420px;text-align:center;padding:32px}h1{font-size:20px;margin:0 0 8px}p{opacity:.75;margin:0}</style></head>
<body><div class="c"><h1>${esc(tr('whatsapp.offTitle'))}</h1><p>${esc(tr('whatsapp.offBody'))}</p></div></body></html>`
    void win?.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(html)}`)
  }

  async function askMedia(kind: 'camera' | 'microphone' | 'both'): Promise<boolean> {
    if (consent.has(kind)) return consent.get(kind)!
    const r = await dialog.showMessageBox(win!, {
      type: 'question', title: 'WhatsApp', message: tr(`whatsapp.media.${kind}`), detail: tr('whatsapp.media.detail'),
      buttons: [tr('whatsapp.media.allow'), tr('whatsapp.media.deny')], defaultId: 1, cancelId: 1, noLink: true,
    })
    const ok = r.response === 0
    consent.set(kind, ok)
    return ok
  }

  function setUnread(n: number) {
    const prev = unread
    unread = n
    app.setBadgeCount(n)
    if (n > prev && win && !win.isFocused() && Notification.isSupported()) {
      note?.close()
      note = new Notification({ title: 'WhatsApp', body: tr('whatsapp.unread', { count: n }), icon: existsSync(ICON) ? ICON : undefined })
      note.on('click', focus)
      note.show()
    }
    if (n === 0) { note?.close(); note = null }
  }

  function setup() {
    const ses = session.fromPartition(WHATSAPP_PARTITION)
    ses.setUserAgent(chromeUserAgent(process.versions.chrome ?? ''))
    ses.setPermissionRequestHandler((wc, perm, cb, details) => {
      const a = whatsappPermission(perm, details.requestingUrl ?? wc.getURL())
      if (a !== 'ask') { cb(a === 'allow'); return }
      void askMedia(mediaKind((details as { mediaTypes?: string[] }).mediaTypes)).then(cb, () => cb(false))
    })
    ses.setPermissionCheckHandler((_wc, perm, origin) => {
      const a = whatsappPermission(perm, origin)
      return a === 'allow' || (a === 'ask' && [...consent.values()].some(Boolean))
    })
    // Screen sharing: the ScreenCast portal's chooser asks the user every time; cancelling there denies.
    ses.setDisplayMediaRequestHandler((request, cb) => {
      if (!whatsappHost(request.frame?.url ?? '')) { cb({}); return }
      desktopCapturer.getSources({ types: ['screen'] }).then((s) => cb(s[0] ? { video: s[0] } : {})).catch(() => cb({}))
    })
    // Downloads (media, documents) go straight to ~/Downloads, never over an existing file.
    ses.on('will-download', (_e, item) => {
      item.setSavePath(downloadPath(app.getPath('downloads'), item.getFilename(), existsSync))
    })
    return ses
  }

  function makeWindow() {
    const w = new BrowserWindow({
      width: 1200, height: 820, minWidth: 480, minHeight: 360, autoHideMenuBar: true, backgroundColor: '#f0f2f5', title: 'WhatsApp',
      icon: existsSync(ICON) ? ICON : undefined,
      webPreferences: {
        partition: WHATSAPP_PARTITION, sandbox: true, contextIsolation: true, nodeIntegration: false, webSecurity: true,
        nodeIntegrationInSubFrames: false, webviewTag: false, spellcheck: true,
      },
    })
    const wc = w.webContents
    const onNav = (e: { preventDefault(): void }, url: string) => {
      if (url.startsWith('data:') && !wc.getURL().startsWith('https:')) return // our own "turned off" page
      const d = whatsappNav(url)
      if (d === 'allow') return
      e.preventDefault()
      if (d === 'external') void shell.openExternal(url)
    }
    wc.on('will-navigate', onNav)
    wc.on('will-redirect', onNav)
    wc.on('will-frame-navigate', (e) => { if (e.isMainFrame) onNav(e, e.url) })
    wc.setWindowOpenHandler(({ url }) => { if (whatsappPopup(url) === 'external') void shell.openExternal(url); return { action: 'deny' } })
    w.on('page-title-updated', (_e, title) => setUnread(unreadFromTitle(title)))
    w.on('focus', () => { note?.close(); note = null })
    return w
  }

  app.on('second-instance', focus)
  void app.whenReady().then(() => {
    session.defaultSession.setPermissionRequestHandler((_wc, _p, cb) => cb(false))
    setup()
    win = makeWindow()
    const p = deviceInfo().policies as { whatsapp?: boolean | null; kiosk?: boolean } | null
    if (!whatsappAllowed(p)) offPage()
    else void win.loadURL(WHATSAPP_URL, { userAgent: chromeUserAgent(process.versions.chrome ?? '') })
  })
  app.on('window-all-closed', () => app.quit())
}

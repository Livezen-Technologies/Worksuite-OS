// WhatsApp (WhatsApp Web, https://web.whatsapp.com) as a first-class app window. WhatsApp has no native Linux app, so
// `worksuite-app whatsapp` opens the official web client in its own window (whatsappwindow.ts). Electron-free so it is
// unit tested; the renderer uses the launcher id, the app_id and the title parsing for its taskbar badge.

/** The short id (`worksuite-app whatsapp`), the Wayland app_id / WM class and .desktop id, and the launcher id. */
export const WHATSAPP_ID = 'whatsapp'
export const WHATSAPP_APP_ID = 'lk.worksuite.whatsapp'
export const WHATSAPP_URL = 'https://web.whatsapp.com/'
/** Its own persistent session: stays linked (QR) across restarts and never shares cookies with WorkSuite's partitions. */
export const WHATSAPP_PARTITION = 'persist:whatsapp'

/** Hosts the window may load: WhatsApp's own domains (web, static, media mmg/pps, …), https only. */
export function whatsappHost(url: string): boolean {
  let u: URL
  try { u = new URL(url) } catch { return false }
  if (u.protocol !== 'https:' || u.username || u.password || (u.port && u.port !== '443')) return false
  const h = u.hostname.toLowerCase()
  return h === 'whatsapp.com' || h.endsWith('.whatsapp.com') || h === 'whatsapp.net' || h.endsWith('.whatsapp.net')
}

export type NavDecision = 'allow' | 'external' | 'deny'

/** Main-frame navigation: WhatsApp's hosts stay in the window; other https/mailto/tel links go to the default browser. */
export function whatsappNav(url: string): NavDecision {
  if (whatsappHost(url)) return 'allow'
  let u: URL
  try { u = new URL(url) } catch { return 'deny' }
  if ((u.protocol === 'https:' || u.protocol === 'mailto:' || u.protocol === 'tel:') && !u.username && !u.password) return 'external'
  return 'deny'
}

/** window.open / target=_blank (links in chats): never a new app window; web links open in the default browser. */
export function whatsappPopup(url: string): 'external' | 'deny' {
  return whatsappNav(url) === 'deny' ? 'deny' : 'external'
}

/** Permissions the window may have: notifications always, camera/microphone after the user agrees. Nothing else;
 *  screen sharing goes through setDisplayMediaRequestHandler and the ScreenCast portal, which asks every time. */
export type PermissionAnswer = 'allow' | 'ask' | 'deny'
export function whatsappPermission(permission: string, requestingUrl: string): PermissionAnswer {
  if (!whatsappHost(requestingUrl)) return 'deny'
  if (permission === 'notifications') return 'allow'
  if (permission === 'media') return 'ask'
  return 'deny'
}

/** What a media request asks for, from Electron's mediaTypes. */
export function mediaKind(types: readonly string[] | undefined): 'camera' | 'microphone' | 'both' {
  const v = types?.includes('video'), a = types?.includes('audio')
  return v && a ? 'both' : v ? 'camera' : a ? 'microphone' : 'both'
}

/** Unread chats from the page title WhatsApp Web sets: "(3) WhatsApp" → 3, "WhatsApp" → 0. */
export function unreadFromTitle(title: string | null | undefined): number {
  const m = /^\s*\((\d{1,5})\+?\)\s*WhatsApp\b/i.exec(title ?? '')
  return m ? Number(m[1]) : 0
}

/** A desktop Chrome user agent for this Chromium version (WhatsApp Web turns away the Electron/… one). */
export function chromeUserAgent(chromeVersion: string): string {
  const major = /^(\d+)/.exec(chromeVersion)?.[1] ?? '140'
  return `Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${major}.0.0.0 Safari/537.36`
}

/** Policy `whatsapp` (admin console › Policy): false turns it off on the device; a kiosk runs only its own app. */
export function whatsappAllowed(p: { whatsapp?: boolean | null; kiosk?: boolean } | null | undefined): boolean {
  return p?.whatsapp !== false && p?.kiosk !== true
}

/** Where a download lands in ~/Downloads: the page's file name made safe, "name (1).ext" if taken. */
export function downloadPath(dir: string, suggested: string, exists: (p: string) => boolean): string {
  let name = (suggested.split(/[\\/]/).pop() ?? '').replace(/[\u0000-\u001f\u007f]/g, '').trim().replace(/^\.+/, '')
  if (!name) name = 'download'
  name = name.slice(0, 200)
  const dot = name.lastIndexOf('.')
  const [base, ext] = dot > 0 ? [name.slice(0, dot), name.slice(dot)] : [name, '']
  const join = (n: string) => `${dir.replace(/\/+$/, '')}/${n}`
  let p = join(name)
  for (let i = 1; exists(p) && i < 1000; i++) p = join(`${base} (${i})${ext}`)
  return p
}

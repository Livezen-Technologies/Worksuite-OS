// The session's notification server (WSOS-INT-007): the shell owns org.freedesktop.Notifications, so desktop apps,
// WorkSuite app windows (Electron's Notification goes through libnotify) and system services all land in the shell's
// notification centre next to the sync notices. Actions are shown as buttons, everything is kept in the history
// until dismissed, do-not-disturb holds back the toast only, and the lock screen shows the app name, never content.
import dbus from 'dbus-next'

const { Message } = dbus
type Bus = InstanceType<typeof dbus.MessageBus>
type Msg = InstanceType<typeof Message>

export const BUS_NAME = 'org.freedesktop.Notifications'
export const OBJ_PATH = '/org/freedesktop/Notifications'
const IFACE = 'org.freedesktop.Notifications'

export interface AppNotification {
  id: number; app: string; summary: string; body: string
  actions: { key: string; label: string }[]; urgency: 0 | 1 | 2; at: number
  /** The sender's icon: app_icon (theme name or icon file path), else its desktop-entry hint; resolved like app icons. */
  icon?: string | null
  /** The sender's desktop-entry hint ("lk.worksuite.whatsapp"), used to find its window on click. */
  desktopEntry?: string
}

/** Notify's app_icon, else the desktop-entry hint: a theme name or an absolute path (file:// stripped), else null. */
export function notifyIcon(appIcon: unknown, desktopEntry: unknown): string | null {
  for (const v of [appIcon, desktopEntry]) {
    if (typeof v !== 'string') continue
    const s = v.replace(/^file:\/\//, '').trim()
    if (s && s.length <= 512 && (/^[A-Za-z0-9][A-Za-z0-9._+@-]*$/.test(s) || s.startsWith('/'))) return s
  }
  return null
}
/** The sender's window for a clicked notification: by desktop-entry hint, else app_name, matched against window
 *  app_ids (exact, StartupWMClass-style case-insensitive, or a reverse-DNS id's last part). Most recent window wins. */
export function windowForNotification<W extends { handle: string; appId: string }>(n: Pick<AppNotification, 'app' | 'desktopEntry'>, windows: W[]): W | undefined {
  const norm = (s: string) => s.trim().toLowerCase().replace(/\.desktop$/, '')
  const last = (s: string) => s.split('.').pop() ?? s
  const keys = [n.desktopEntry, n.app].filter((x): x is string => !!x && !!x.trim()).map(norm)
  for (const k of keys) {
    const hit = [...windows].reverse().find((w) => norm(w.appId) === k)
      ?? [...windows].reverse().find((w) => k.includes('.') && last(k) === norm(w.appId))
      ?? [...windows].reverse().find((w) => norm(w.appId).includes('.') && last(norm(w.appId)) === k)
    if (hit) return hit
  }
  return undefined
}

/** Spec close reasons. */
export const CLOSED = { expired: 1, dismissed: 2, closedByCall: 3 } as const

const MAX_KEEP = 100
const clip = (s: unknown, n: number) => String(s ?? '').slice(0, n)
/** We do not advertise body-markup, but some senders send it anyway: drop tags, decode the basic entities. */
export function plainBody(s: string): string {
  return s.replace(/<[^>]*>/g, '').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, '&')
}
/** Flat [key, label, key, label…] → pairs; the "default" action has no button (clicking the notice runs it). */
export function actionPairs(flat: unknown): { key: string; label: string }[] {
  const a = Array.isArray(flat) ? flat.map(String) : []
  const out: { key: string; label: string }[] = []
  for (let i = 0; i + 1 < a.length && out.length < 4; i += 2) out.push({ key: clip(a[i], 64), label: clip(a[i + 1], 64) })
  return out
}

export class NotificationCenter {
  private items: AppNotification[] = []
  private next = 1
  private listeners = new Set<(list: AppNotification[]) => void>()
  constructor(
    private closed: (id: number, reason: number) => void = () => {},
    private invoked: (id: number, key: string) => void = () => {},
    private now: () => number = Date.now,
    /** Clicking a notification (the "default" action) also brings the sender's window forward. */
    private focus: (n: AppNotification) => void = () => {},
  ) {}

  list(): AppNotification[] { return [...this.items] }
  onChange(cb: (list: AppNotification[]) => void): () => void { this.listeners.add(cb); return () => { this.listeners.delete(cb) } }
  private emit() { const l = this.list(); for (const cb of this.listeners) cb(l) }

  notify(app: string, replacesId: number, summary: string, body: string, actions: unknown, urgency: number, icon: string | null = null, desktopEntry: string | null = null): number {
    const keep = replacesId > 0 && this.items.some((n) => n.id === replacesId)
    const id = keep ? replacesId : this.next++
    const n: AppNotification = {
      id, app: clip(app, 80) || 'App', summary: clip(summary, 200), body: clip(plainBody(String(body ?? '')), 1000),
      actions: actionPairs(actions), urgency: urgency === 0 || urgency === 2 ? urgency : 1, at: this.now(),
      ...(icon ? { icon } : {}),
      ...(typeof desktopEntry === 'string' && /^[A-Za-z0-9][A-Za-z0-9._+-]{0,127}$/.test(desktopEntry) ? { desktopEntry } : {}),
    }
    this.items = [n, ...this.items.filter((x) => x.id !== id)].slice(0, MAX_KEEP)
    this.emit()
    return id
  }

  close(id: number, reason: number) {
    const had = this.items.some((n) => n.id === id)
    this.items = this.items.filter((n) => n.id !== id)
    if (had) { this.closed(id, reason); this.emit() }
  }

  invoke(id: number, key: string): boolean {
    const n = this.items.find((x) => x.id === id)
    if (!n || (key !== 'default' && !n.actions.some((a) => a.key === key))) return false
    if (key === 'default') { try { this.focus(n) } catch { /* no window: the action still goes back */ } }
    this.invoked(id, key)
    this.close(id, CLOSED.dismissed)
    return true
  }
}

/** Serves the spec's methods on `bus` for `center`. Returns false when another server already owns the name. */
export async function serveNotifications(bus: Bus, center: NotificationCenter): Promise<boolean> {
  const reply = await bus.requestName(BUS_NAME, 4 /* DBUS_NAME_FLAG_DO_NOT_QUEUE */)
  if (reply !== 1 && reply !== 4) return false
  bus.addMethodHandler((m: Msg) => {
    if (m.path !== OBJ_PATH || m.interface !== IFACE) return false
    const ret = (sig: string, body: unknown[]) => { bus.send(Message.newMethodReturn(m, sig, body)); return true }
    switch (m.member) {
      case 'GetCapabilities': return ret('as', [['actions', 'body', 'persistence']])
      case 'GetServerInformation': return ret('ssss', ['WorkSuite', 'WorkSuite', '1.0', '1.2'])
      case 'Notify': {
        const [app, replaces, appIcon, summary, body, actions, hints] = m.body as [string, number, string, string, string, string[], Record<string, { value: unknown }>]
        const urgency = Number(hints?.urgency?.value ?? 1)
        return ret('u', [center.notify(app, Number(replaces) || 0, summary, body, actions, urgency, notifyIcon(appIcon, hints?.['desktop-entry']?.value), typeof hints?.['desktop-entry']?.value === 'string' ? hints['desktop-entry'].value as string : null)])
      }
      case 'CloseNotification': center.close(Number(m.body[0]), CLOSED.closedByCall); return ret('', [])
      default: return false
    }
  })
  return true
}

export function signalsFor(bus: Bus) {
  return {
    closed: (id: number, reason: number) => bus.send(Message.newSignal(OBJ_PATH, IFACE, 'NotificationClosed', 'uu', [id, reason])),
    invoked: (id: number, key: string) => bus.send(Message.newSignal(OBJ_PATH, IFACE, 'ActionInvoked', 'us', [id, key])),
  }
}

type Handle = (channel: string, fn: (...args: string[]) => unknown) => void
/** Starts the server on the session bus and wires it to the renderer. Without a bus the centre stays shell-only. */
export function startNotifications(handle: Handle, broadcast: (channel: string, payload: unknown) => void, focus: (n: AppNotification) => void = () => {}): NotificationCenter {
  let bus: Bus | null = null
  try { bus = dbus.sessionBus(); bus.on('error', () => { /* bus gone: keep the shell running */ }) } catch { bus = null }
  const sig = bus ? signalsFor(bus) : null
  const center = new NotificationCenter((id, r) => sig?.closed(id, r), (id, k) => sig?.invoked(id, k), Date.now, focus)
  if (bus) void serveNotifications(bus, center).catch(() => false)
  center.onChange((list) => broadcast('ws:notificationsChanged', list))
  handle('ws:notifications', () => center.list())
  handle('ws:notificationInvoke', (id, key) => center.invoke(Number(id), key))
  handle('ws:notificationDismiss', (id) => { center.close(Number(id), CLOSED.dismissed); return true })
  return center
}

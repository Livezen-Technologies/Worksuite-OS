// Remote support input on the device (issue #19): the administrator's mouse and keyboard events from the viewer's data
// channel, applied only while the person at the device has granted remote control (remoteSession.ts checks that on
// every event). Two backends, both inside Wayland's rules (nothing reads or writes /dev/input):
//   - RemoteDesktop portal (org.freedesktop.portal.RemoteDesktop NotifyPointer*/NotifyKeyboardKeysym), used whenever the
//     portal backend implements it; starting it shows the portal's own permission dialog;
//   - otherwise labwc's wlroots virtual-pointer / virtual-keyboard protocols via wlrctl and wtype (fixed argv).
import type { Exec } from './system'

export type InputMsg =
  | { t: 'pm'; x: number; y: number }
  | { t: 'pb'; b: number; down: boolean; x: number; y: number }
  | { t: 'ax'; dx: number; dy: number }
  | { t: 'k'; key: string; code: string; down: boolean }

/** Untrusted data-channel JSON → a well-formed input message, or null. */
export function parseInput(raw: unknown): InputMsg | null {
  if (!raw || typeof raw !== 'object') return null
  const m = raw as Record<string, unknown>
  const unit = (v: unknown) => typeof v === 'number' && Number.isFinite(v) && v >= 0 && v <= 1
  const step = (v: unknown) => v === -1 || v === 0 || v === 1
  if (m.t === 'pm' && unit(m.x) && unit(m.y)) return { t: 'pm', x: m.x as number, y: m.y as number }
  if (m.t === 'pb' && (m.b === 0 || m.b === 1 || m.b === 2) && typeof m.down === 'boolean' && unit(m.x) && unit(m.y)) return { t: 'pb', b: m.b, down: m.down, x: m.x as number, y: m.y as number }
  if (m.t === 'ax' && step(m.dx) && step(m.dy)) return { t: 'ax', dx: m.dx as number, dy: m.dy as number }
  if (m.t === 'k' && typeof m.key === 'string' && m.key.length >= 1 && m.key.length <= 20 && typeof m.code === 'string' && m.code.length <= 30 && typeof m.down === 'boolean') return { t: 'k', key: m.key, code: m.code, down: m.down }
  return null
}

const SPECIAL: Record<string, number> = {
  Enter: 0xff0d, Backspace: 0xff08, Tab: 0xff09, Escape: 0xff1b, Delete: 0xffff, Home: 0xff50, End: 0xff57,
  PageUp: 0xff55, PageDown: 0xff56, ArrowLeft: 0xff51, ArrowUp: 0xff52, ArrowRight: 0xff53, ArrowDown: 0xff54,
  Insert: 0xff63, Shift: 0xffe1, Control: 0xffe3, Alt: 0xffe9, Meta: 0xffeb, CapsLock: 0xffe5, ' ': 0x20,
  F1: 0xffbe, F2: 0xffbf, F3: 0xffc0, F4: 0xffc1, F5: 0xffc2, F6: 0xffc3, F7: 0xffc4, F8: 0xffc5, F9: 0xffc6, F10: 0xffc7, F11: 0xffc8, F12: 0xffc9,
}
const XKB_NAME: Record<number, string> = {
  0xff0d: 'Return', 0xff08: 'BackSpace', 0xff09: 'Tab', 0xff1b: 'Escape', 0xffff: 'Delete', 0xff50: 'Home', 0xff57: 'End', 0xff55: 'Prior', 0xff56: 'Next',
  0xff51: 'Left', 0xff52: 'Up', 0xff53: 'Right', 0xff54: 'Down', 0xff63: 'Insert', 0xffe1: 'Shift_L', 0xffe3: 'Control_L', 0xffe9: 'Alt_L', 0xffeb: 'Super_L', 0xffe5: 'Caps_Lock', 0x20: 'space',
}

/** KeyboardEvent.key → X keysym (Unicode keysyms for printable characters), or null for keys we don't send. */
export function keysym(key: string): number | null {
  if (key in SPECIAL) return SPECIAL[key]
  if (/^F([1-9]|1[0-2])$/.test(key)) return SPECIAL[key]
  const cps = [...key]
  if (cps.length !== 1) return null
  const cp = cps[0].codePointAt(0)!
  if (cp < 0x20 || cp === 0x7f) return null
  return cp <= 0xff ? cp : 0x01000000 + cp
}

/** Browser mouse button → evdev code (BTN_LEFT, BTN_MIDDLE, BTN_RIGHT). */
export const BUTTON = [0x110, 0x112, 0x111] as const

export interface InputBackend {
  readonly name: string
  /** Pointer to absolute normalized position on a screen of size w×h (pixels). */
  move(x: number, y: number, w: number, h: number): Promise<void>
  button(b: 0 | 1 | 2, down: boolean): Promise<void>
  scroll(dx: number, dy: number): Promise<void>
  key(sym: number, down: boolean): Promise<void>
  close(): Promise<void>
}

/** Relative-only pointers (portal NotifyPointerMotion, wlrctl): track the position; first move warps to the corner. */
export class PointerTracker {
  private at: { x: number; y: number } | null = null
  delta(x: number, y: number, w: number, h: number): { dx: number; dy: number }[] {
    const px = Math.round(x * w), py = Math.round(y * h)
    const out: { dx: number; dy: number }[] = []
    if (!this.at) { out.push({ dx: -100_000, dy: -100_000 }); this.at = { x: 0, y: 0 } }
    const d = { dx: px - this.at.x, dy: py - this.at.y }
    this.at = { x: px, y: py }
    if (d.dx || d.dy) out.push(d)
    return out
  }
}

/** labwc: wlr-virtual-pointer (wlrctl) and virtual-keyboard (wtype). wlrctl clicks press and release together. */
export function wlrBackend(exec: Exec): InputBackend {
  const tr = new PointerTracker()
  const mods = new Set<string>()
  const BTN = ['left', 'middle', 'right']
  return {
    name: 'wlroots',
    async move(x, y, w, h) { for (const d of tr.delta(x, y, w, h)) await exec('wlrctl', ['pointer', 'move', String(d.dx), String(d.dy)]) },
    async button(b, down) { if (!down) await exec('wlrctl', ['pointer', 'click', BTN[b]]) },
    async scroll(dx, dy) { await exec('wlrctl', ['pointer', 'scroll', String(dy * 15), String(dx * 15)]) },
    async key(sym, down) {
      const name = XKB_NAME[sym]
      const mod = name && /^(Shift|Control|Alt|Super)_L$/.test(name) ? name.replace('_L', '').toLowerCase().replace('super', 'logo').replace('control', 'ctrl') : null
      if (mod) { if (down) mods.add(mod); else mods.delete(mod); return }
      if (!down) return
      const press = [...mods].flatMap((m) => ['-M', m])
      const release = [...mods].flatMap((m) => ['-m', m])
      const ch = String.fromCodePoint(sym >= 0x01000000 ? sym - 0x01000000 : sym)
      // Keysym and modifier names come from the tables above; a typed character never starts with '-' (no option).
      const k = name ? ['-k', name] : ch === '-' ? ['-k', 'minus'] : [ch]
      await exec('wtype', [...press, ...k, ...release])
    },
    async close() { mods.clear() },
  }
}

// ---- RemoteDesktop portal (dbus-next) ----
export interface PortalBus {
  /** Calls a portal method that answers through a Request object; resolves with its results or rejects on cancel. */
  request(method: string, args: unknown[]): Promise<Record<string, unknown>>
  call(method: string, args: unknown[]): Promise<void>
  close(): void
}

export async function portalBackend(bus: PortalBus): Promise<InputBackend> {
  const created = await bus.request('CreateSession', [{}])
  const session = String((created.session_handle as { value?: unknown })?.value ?? created.session_handle ?? '')
  if (!session) throw new Error('no_session')
  await bus.request('SelectDevices', [session, { types: 3 }])      // keyboard (1) | pointer (2)
  await bus.request('Start', [session, '', {}])                     // the portal asks the user here
  const tr = new PointerTracker()
  return {
    name: 'portal',
    async move(x, y, w, h) { for (const d of tr.delta(x, y, w, h)) await bus.call('NotifyPointerMotion', [session, {}, d.dx, d.dy]) },
    async button(b, down) { await bus.call('NotifyPointerButton', [session, {}, BUTTON[b], down ? 1 : 0]) },
    async scroll(dx, dy) { await bus.call('NotifyPointerAxisDiscrete', [session, {}, dy ? 0 : 1, dy || dx]) },
    async key(sym, down) { await bus.call('NotifyKeyboardKeysym', [session, {}, sym, down ? 1 : 0]) },
    async close() { bus.close() },
  }
}

/** dbus-next implementation of PortalBus against the session bus. */
export async function dbusPortalBus(): Promise<PortalBus> {
  const dbus = (await import('dbus-next')).default
  const bus = dbus.sessionBus()
  const obj = await bus.getProxyObject('org.freedesktop.portal.Desktop', '/org/freedesktop/portal/desktop')
  const rd = obj.getInterface('org.freedesktop.portal.RemoteDesktop')
  const sender = String((bus as unknown as { name?: string }).name ?? '').replace(/^:/, '').replace(/\./g, '_')
  let n = 0
  const V = dbus.Variant
  const wrap = (o: Record<string, unknown>) => Object.fromEntries(Object.entries(o).map(([k, v]) => [k, typeof v === 'number' ? new V('u', v) : new V('s', String(v))]))
  const typed = (method: string, args: unknown[]) => {
    // Argument types come from the portal's introspection; only the a{sv} option dicts need Variants.
    const m = rd as unknown as Record<string, (...a: unknown[]) => Promise<unknown>>
    return m[method](...args.map((a) => (a && typeof a === 'object' && !(a instanceof V) ? wrap(a as Record<string, unknown>) : a)))
  }
  return {
    async request(method, args) {
      const token = `ws_rs_${process.pid}_${++n}`
      const path = `/org/freedesktop/portal/desktop/request/${sender}/${token}`
      const opts = { handle_token: token, ...(method === 'CreateSession' ? { session_handle_token: `ws_rs_s_${process.pid}_${n}` } : {}) }
      const last = args.length - 1
      const withOpts = args.map((a, i) => (i === last ? { ...(a as object), ...opts } : a))
      const done = new Promise<Record<string, unknown>>((resolve, reject) => {
        bus.getProxyObject('org.freedesktop.portal.Desktop', path).then((ro) => {
          ro.getInterface('org.freedesktop.portal.Request').once('Response', (code: number, results: Record<string, { value: unknown }>) =>
            (code === 0 ? resolve(results) : reject(new Error(code === 1 ? 'cancelled' : 'failed'))))
        }).catch(reject)
      })
      await typed(method, withOpts)
      return done
    },
    async call(method, args) { await typed(method, args) },
    close() { bus.disconnect() },
  }
}

/** The portal when its backend implements RemoteDesktop (it asks the user); otherwise the wlroots protocols. */
export async function openInput(exec: Exec, portal: () => Promise<PortalBus> = dbusPortalBus): Promise<InputBackend> {
  try { return await portalBackend(await portal()) } catch { return wlrBackend(exec) }
}

/** One message → backend calls. Screen size is the shared stream's (the viewer sends normalized coordinates). */
export async function applyInput(b: InputBackend, m: InputMsg, screen: { w: number; h: number }) {
  if (m.t === 'pm') return b.move(m.x, m.y, screen.w, screen.h)
  if (m.t === 'pb') { await b.move(m.x, m.y, screen.w, screen.h); return b.button(m.b as 0 | 1 | 2, m.down) }
  if (m.t === 'ax') return b.scroll(m.dx, m.dy)
  const s = keysym(m.key)
  if (s !== null) return b.key(s, m.down)
}

// Panel back end in the Electron main process (SRS §5.1–5.2): the shell's taskbar is the WorkSuite panel.
// - Window list and window operations come only from lk.worksuite.WaylandBridge1 (the bridge verifies that the
//   caller is this binary, WSOS-SHL-004); window signals are unicast to this connection after SubscribeWindowEvents.
// - Tray items come from the bridge's StatusNotifierWatcher (lk.worksuite.Tray1).
// - Exports lk.worksuite.Shell1 so Labwc's Super binding opens the launcher (WSOS-DSK-011).
import dbus from 'dbus-next'

const { Message } = dbus
type Msg = InstanceType<typeof Message>

export const BRIDGE = 'lk.worksuite.WaylandBridge1'
export const BRIDGE_PATH = '/lk/worksuite/WaylandBridge1'
export const TRAY_PATH = '/lk/worksuite/Tray1'
export const TRAY_IFACE = 'lk.worksuite.Tray1'
export const SHELL = 'lk.worksuite.Shell1'
export const SHELL_PATH = '/lk/worksuite/Shell1'

export const SHELL_XML = `<node name="${SHELL_PATH}">
  <interface name="${SHELL}">
    <!-- Super key (services/session/labwc/rc.xml): open or close the launcher. -->
    <method name="ToggleLauncher"/>
    <method name="ShowLauncher"/>
    <!-- Super+A (rc.xml): open or close the AI assistant (services/ai). -->
    <method name="ToggleAssistant"/>
    <!-- Files is the default handler for archives (shell/apps/worksuite-files.desktop): browse this one. -->
    <method name="OpenArchive"><arg name="path" type="s" direction="in"/></method>
  </interface>
</node>`

export interface PanelWindow { handle: string; appId: string; title: string; output: string; flags: number }
export interface TrayItem { key: string; id: string; title: string; icon: string; status: string }
export type PanelResult<T> = { ok: true; value: T } | { ok: false; error: string }

/** The part of a dbus-next MessageBus the panel uses (tests pass a fake). */
export interface PanelBus {
  call(msg: Msg): Promise<Msg | null>
  send(msg: Msg): void
  on(event: 'message', fn: (msg: Msg) => void): unknown
  addMethodHandler(fn: (msg: Msg) => boolean): void
  requestName(name: string, flags: number): Promise<number>
}

export function rowsToWindows(rows: unknown): PanelWindow[] {
  if (!Array.isArray(rows)) return []
  return rows.filter((r) => Array.isArray(r) && r.length >= 5).map((r) => ({ handle: String(r[0]), appId: String(r[1]), title: String(r[2]), output: String(r[3]), flags: Number(r[4]) }))
}

export function rowsToTray(rows: unknown): TrayItem[] {
  if (!Array.isArray(rows)) return []
  return rows.filter((r) => Array.isArray(r) && r.length >= 5).map((r) => ({ key: String(r[0]), id: String(r[1]), title: String(r[2]), icon: String(r[3]), status: String(r[4]) }))
}

function errorCode(e: unknown): string {
  const type = (e as { type?: string })?.type ?? ''
  if (type.endsWith('.NotFound')) return 'not_found'
  if (type.endsWith('.NotSupported')) return 'not_supported'
  if (type.endsWith('AccessDenied')) return 'access_denied'
  if (type.endsWith('ServiceUnknown') || type.endsWith('NameHasNoOwner')) return 'bridge_unavailable'
  return 'failed'
}

export interface PanelEvents {
  windows(list: PanelWindow[]): void
  tray(items: TrayItem[]): void
  launcher(action: 'toggle' | 'show' | 'assistant'): void
  /** A monitor was plugged, unplugged or reconfigured (bridge OutputsChanged, WSOS-DSK-007). */
  outputs?(): void
  /** OpenArchive(path) from worksuite-open-archive. */
  openArchive?(path: string): void
}

export class PanelClient {
  windows: PanelWindow[] = []
  tray: TrayItem[] = []
  private refreshTimer: ReturnType<typeof setTimeout> | null = null

  private bus: PanelBus
  private events: PanelEvents
  private debounceMs: number

  constructor(bus: PanelBus, events: PanelEvents, debounceMs = 50) {
    this.bus = bus
    this.events = events
    this.debounceMs = debounceMs
  }

  private call(path: string, iface: string, member: string, signature = '', body: unknown[] = []) {
    return this.bus.call(new Message({ destination: BRIDGE, path, interface: iface, member, signature, body }))
  }

  /** Exports Shell1, subscribes to window events and loads the first window and tray lists. */
  async start(): Promise<void> {
    this.bus.addMethodHandler((msg) => this.onMethod(msg))
    this.bus.on('message', (msg) => this.onSignal(msg))
    await this.bus.requestName(SHELL, 4 /* DBUS_NAME_FLAG_DO_NOT_QUEUE */).catch(() => 0)
    await this.bus.call(new Message({ destination: 'org.freedesktop.DBus', path: '/org/freedesktop/DBus', interface: 'org.freedesktop.DBus', member: 'AddMatch', signature: 's',
      body: [`type='signal',interface='${TRAY_IFACE}',path='${TRAY_PATH}'`] })).catch(() => null)
    await this.reconnect()
    // The bridge restarts on its own (Restart=always); subscribe again when its name gets a new owner.
    await this.bus.call(new Message({ destination: 'org.freedesktop.DBus', path: '/org/freedesktop/DBus', interface: 'org.freedesktop.DBus', member: 'AddMatch', signature: 's',
      body: [`type='signal',sender='org.freedesktop.DBus',member='NameOwnerChanged',arg0='${BRIDGE}'`] })).catch(() => null)
  }

  async reconnect(): Promise<void> {
    await this.call(BRIDGE_PATH, BRIDGE, 'SubscribeWindowEvents').catch(() => null)
    await Promise.all([this.refreshWindows(), this.refreshTray()])
  }

  private onMethod(msg: Msg): boolean {
    if (msg.path !== SHELL_PATH) return false
    if (msg.interface === SHELL && (msg.member === 'ToggleLauncher' || msg.member === 'ShowLauncher' || msg.member === 'ToggleAssistant')) {
      this.events.launcher(msg.member === 'ToggleLauncher' ? 'toggle' : msg.member === 'ShowLauncher' ? 'show' : 'assistant')
      this.bus.send(Message.newMethodReturn(msg, '', []))
      return true
    }
    if (msg.interface === SHELL && msg.member === 'OpenArchive' && msg.signature === 's') {
      this.events.openArchive?.(String(msg.body?.[0] ?? ''))
      this.bus.send(Message.newMethodReturn(msg, '', []))
      return true
    }
    if (msg.interface === 'org.freedesktop.DBus.Introspectable' && msg.member === 'Introspect') {
      this.bus.send(Message.newMethodReturn(msg, 's', [SHELL_XML]))
      return true
    }
    return false
  }

  private onSignal(msg: Msg) {
    if (msg.type !== 4 /* SIGNAL */) return
    if (msg.interface === BRIDGE && ['WindowAdded', 'WindowChanged', 'WindowRemoved'].includes(msg.member ?? '')) this.scheduleRefresh()
    else if (msg.interface === BRIDGE && msg.member === 'OutputsChanged') { this.events.outputs?.(); this.scheduleRefresh() }
    else if (msg.interface === TRAY_IFACE && msg.member === 'ItemsChanged') void this.refreshTray()
    else if (msg.member === 'NameOwnerChanged' && msg.body?.[0] === BRIDGE && msg.body?.[2]) void this.reconnect()
    else if (msg.member === 'NameOwnerChanged' && msg.body?.[0] === BRIDGE) { this.windows = []; this.tray = []; this.events.windows([]); this.events.tray([]) }
  }

  private scheduleRefresh() {
    if (this.refreshTimer) return
    this.refreshTimer = setTimeout(() => { this.refreshTimer = null; void this.refreshWindows() }, this.debounceMs)
  }

  async refreshWindows(): Promise<PanelWindow[]> {
    try {
      const r = await this.call(BRIDGE_PATH, BRIDGE, 'ListWindows')
      this.windows = rowsToWindows(r?.body?.[0])
    } catch {
      this.windows = []
    }
    this.events.windows(this.windows)
    return this.windows
  }

  async refreshTray(): Promise<TrayItem[]> {
    try {
      const r = await this.call(TRAY_PATH, TRAY_IFACE, 'ListItems')
      this.tray = rowsToTray(r?.body?.[0])
    } catch {
      this.tray = []
    }
    this.events.tray(this.tray)
    return this.tray
  }

  private async op(member: string, signature: string, body: unknown[], path = BRIDGE_PATH, iface = BRIDGE): Promise<PanelResult<true>> {
    try {
      await this.call(path, iface, member, signature, body)
      return { ok: true, value: true }
    } catch (e) {
      return { ok: false, error: errorCode(e) }
    }
  }

  activate(handle: string) { return this.op('ActivateWindow', 'ss', [handle, ''] ) }
  close(handle: string) { return this.op('CloseWindow', 's', [handle]) }
  minimize(handle: string, state: boolean) { return this.op('SetMinimized', 'sb', [handle, state]) }
  trayActivate(key: string, x: number, y: number) { return this.op('Activate', 'sii', [key, Math.round(x), Math.round(y)], TRAY_PATH, TRAY_IFACE) }
}

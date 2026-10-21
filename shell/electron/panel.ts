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
/** D-Bus signature (string handle, uint32 index) of MoveWindowToWorkspace. */
const HANDLE_INDEX = 'su'
export const SHELL_PATH = '/lk/worksuite/Shell1'

export const SHELL_XML = `<node name="${SHELL_PATH}">
  <interface name="${SHELL}">
    <!-- Super key (services/session/labwc/rc.xml): open or close the launcher. -->
    <method name="ToggleLauncher"/>
    <method name="ShowLauncher"/>
    <!-- Touch gestures (worksuite-gestures): edge swipe from the right, three-finger swipe down. -->
    <method name="ToggleNotifications"/>
    <method name="ShowDesktop"/>
    <!-- Super+Tab (rc.xml), the three-finger swipe up: open or close Task View (desktops, WSOS-DSK-003). -->
    <method name="ToggleTaskView"/>
    <!-- Super+A (rc.xml): open or close the AI assistant (services/ai). -->
    <method name="ToggleAssistant"/>
    <!-- Files is the default handler for archives (shell/apps/worksuite-files.desktop): browse this one. -->
    <method name="OpenArchive"><arg name="path" type="s" direction="in"/></method>
    <!-- Windows-style shortcuts (rc.xml, src/lib/shortcuts.ts): files, settings, monitor, a11y, clipboard (Super+V),
         emoji (Super+.), shortcuts (Super+/), snip (the Snipping Tool app) or app:<desktop id> (custom shortcuts). -->
    <method name="Open"><arg name="what" type="s" direction="in"/></method>
    <!-- worksuite-screenshot (Print, Super+Print, Alt+Print, Super+Shift+S): print, save, window or snip (electron/capture.ts). -->
    <method name="Capture"><arg name="kind" type="s" direction="in"/></method>
    <!-- worksuite-hotkey (laptop Fn keys, #62) after it changed the level: volume, mic or brightness, 0…100, muted. -->
    <method name="Osd"><arg name="kind" type="s" direction="in"/><arg name="value" type="u" direction="in"/><arg name="muted" type="b" direction="in"/></method>
  </interface>
</node>`

export interface PanelWindow { handle: string; appId: string; title: string; output: string; flags: number }
export interface TrayItem { key: string; id: string; title: string; icon: string; status: string }
/** Labwc desktops through the bridge (WSOS-DSK-003): current and count are 1-based; windows maps handle → workspace.
 *  names: per desktop, "" = no name of its own; sticky: windows on all desktops; stickyApps: apps whose windows are;
 *  switcherAll: Alt+Tab shows every desktop's windows; dynamic: desktops can be added, closed, moved and renamed;
 *  capture: the bridge can capture an output for Task View. */
export interface Workspaces {
  supported: boolean; current: number; count: number; windows: Record<string, number>
  names?: string[]; sticky?: string[]; stickyApps?: string[]; switcherAll?: boolean; dynamic?: boolean; capture?: boolean; ids?: string[]
}
export const MAX_DESKTOPS = 16
/** ListWindows flags bit: the window has focus. */
export const ACTIVATED_FLAG = 1
/** ListWindows flags bit: the window is full-screen (worksuite_bridge/model.py FULLSCREEN). */
export const FULLSCREEN_FLAG = 8
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
  launcher(action: 'toggle' | 'show' | 'notifications' | 'desktop' | 'assistant' | 'taskview'): void
  /** A monitor was plugged, unplugged or reconfigured (bridge OutputsChanged, WSOS-DSK-007). */
  outputs?(): void
  /** OpenArchive(path) from worksuite-open-archive. */
  openArchive?(path: string): void
  workspaces?(w: Workspaces): void
  /** Open(what) and Capture(kind) from the Windows-style key bindings. */
  open?(what: string): void
  capture?(kind: string): void
  /** Osd(kind, value, muted) from worksuite-hotkey: show the level indicator. */
  osd?(o: OsdLevel): void
}
/** What the on-screen indicator shows after a Fn key (#62). */
export const OSD_KINDS = ['volume', 'mic', 'brightness'] as const
export interface OsdLevel { kind: (typeof OSD_KINDS)[number]; value: number; muted: boolean }
/** What Open(what) accepts: shell surfaces, or app:<desktop id> for custom shortcuts. */
export const OPEN_TARGETS = ['files', 'settings', 'monitor', 'a11y', 'clipboard', 'emoji', 'shortcuts', 'snip']
export const validOpen = (w: string) => OPEN_TARGETS.includes(w) || /^app:[A-Za-z0-9][A-Za-z0-9._+-]{0,127}$/.test(w)
export const CAPTURE_KINDS = ['print', 'save', 'window', 'snip']

const HANDLE = /^w[0-9a-f]{1,32}$/
const strings = (v: unknown, ok: (s: string) => boolean, max: number) => (Array.isArray(v) ? v.map(String).filter(ok).slice(0, max) : [])

/** ListWorkspaces (current, count, windows) or WorkspaceDetails (current, names, windows, sticky, sticky apps, Alt+Tab
 *  scope) from the bridge, validated. */
export function toWorkspaces(body: unknown, ops: string[], details?: unknown): Workspaces {
  const d = Array.isArray(details) && Array.isArray(details[1]) ? details : null
  const b = d ? [d[0], (d[1] as unknown[]).length, d[2]] : Array.isArray(body) ? body : []
  const count = Math.max(1, Math.min(MAX_DESKTOPS, Number(b[1]) || 1))
  const current = Math.max(1, Math.min(count, Number(b[0]) || 1))
  const windows: Record<string, number> = {}
  if (b[2] && typeof b[2] === 'object') for (const [h, n] of Object.entries(b[2] as Record<string, unknown>)) if (HANDLE.test(h) && Number.isInteger(n)) windows[h] = n as number
  const out: Workspaces = { supported: ops.includes('workspaces'), current, count, windows }
  if (d) {
    out.names = strings(d[1], () => true, MAX_DESKTOPS).map((s) => s.slice(0, 40))
    out.sticky = strings(d[3], (h) => HANDLE.test(h), 256)
    out.stickyApps = strings(d[4], (a) => a.length > 0 && a.length < 256, 64)
    out.switcherAll = d[5] === true
    out.ids = strings(d[6], (x) => /^[A-Za-z0-9]{1,16}$/.test(x), MAX_DESKTOPS)
  }
  out.dynamic = out.supported && ops.includes('dynamic-workspaces')
  out.capture = ops.includes('capture-output')
  return out
}

export class PanelClient {
  windows: PanelWindow[] = []
  tray: TrayItem[] = []
  workspaces: Workspaces = { supported: false, current: 1, count: 1, windows: {} }
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
    // A restarted bridge starts with its default reservation: the taskbar's height again (touch mode's 64, #53).
    if (this.panelHeight !== null) await this.setPanelHeight(this.panelHeight)
    await Promise.all([this.refreshWindows(), this.refreshTray(), this.refreshWorkspaces()])
  }

  private onMethod(msg: Msg): boolean {
    if (msg.path !== SHELL_PATH) return false
    const shellAction = ({ ToggleLauncher: 'toggle', ShowLauncher: 'show', ToggleNotifications: 'notifications', ShowDesktop: 'desktop', ToggleAssistant: 'assistant', ToggleTaskView: 'taskview' } as const)[msg.member as 'ToggleLauncher']
    if (msg.interface === SHELL && shellAction) {
      this.events.launcher(shellAction)
      this.bus.send(Message.newMethodReturn(msg, '', []))
      return true
    }
    if (msg.interface === SHELL && (msg.member === 'Open' || msg.member === 'Capture') && msg.signature === 's') {
      const arg = String(msg.body?.[0] ?? '')
      const ok = msg.member === 'Open' ? validOpen(arg) : CAPTURE_KINDS.includes(arg)
      if (!ok) { this.bus.send(Message.newError(msg as unknown as string, 'org.freedesktop.DBus.Error.InvalidArgs', `unknown ${msg.member === 'Open' ? 'target' : 'kind'}`)); return true }
      if (msg.member === 'Open') this.events.open?.(arg); else this.events.capture?.(arg)
      this.bus.send(Message.newMethodReturn(msg, '', []))
      return true
    }
    if (msg.interface === SHELL && msg.member === 'Osd' && msg.signature === 'sub') {
      const [kind, value, muted] = msg.body ?? []
      if (!(OSD_KINDS as readonly string[]).includes(String(kind)) || !Number.isInteger(value) || value < 0 || value > 1000) {
        this.bus.send(Message.newError(msg as unknown as string, 'org.freedesktop.DBus.Error.InvalidArgs', 'bad level')); return true
      }
      this.events.osd?.({ kind: kind as OsdLevel['kind'], value: Math.min(100, value as number), muted: muted === true })
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
    else if (msg.interface === BRIDGE && msg.member === 'WorkspacesChanged') void this.refreshWorkspaces()
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

  async refreshWorkspaces(): Promise<Workspaces> {
    try {
      const [r, p, d] = await Promise.all([this.call(BRIDGE_PATH, BRIDGE, 'ListWorkspaces'),
        this.call(BRIDGE_PATH, 'org.freedesktop.DBus.Properties', 'Get', 'ss', [BRIDGE, 'SupportedOperations']),
        this.call(BRIDGE_PATH, BRIDGE, 'WorkspaceDetails').catch(() => null)])  // older bridges: no details
      const ops = (p?.body?.[0] as { value?: unknown } | undefined)?.value
      this.workspaces = toWorkspaces(r?.body, Array.isArray(ops) ? ops.map(String) : [], d?.body)
    } catch {
      this.workspaces = { supported: false, current: 1, count: 1, windows: {} }
    }
    this.events.workspaces?.(this.workspaces)
    return this.workspaces
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
  activateWorkspace(n: number) { return this.op('ActivateWorkspace', 'u', [n]) }
  moveToWorkspace(handle: string, n: number) { return this.op('MoveWindowToWorkspace', HANDLE_INDEX, [handle, n]) }
  createWorkspace() { return this.op('CreateWorkspace', '', []) }
  removeWorkspace(n: number) { return this.op('RemoveWorkspace', 'u', [n]) }
  moveWorkspace(from: number, to: number) { return this.op('MoveWorkspace', 'uu', [from, to]) }
  renameWorkspace(n: number, name: string) { return this.op('RenameWorkspace', 'us', [n, name.slice(0, 40)]) }
  restoreWorkspaces(names: string[], prefix: string) { return this.op('RestoreWorkspaces', 'ass', [names.slice(0, MAX_DESKTOPS).map((x) => x.slice(0, 40)), prefix.slice(0, 40)]) }
  setWindowOnAllWorkspaces(handle: string, on: boolean) { return this.op('SetWindowOnAllWorkspaces', 'sb', [handle, on]) }
  setAppOnAllWorkspaces(appId: string, on: boolean) { return this.op('SetAppOnAllWorkspaces', 'sb', [appId, on]) }
  setSwitcherAllWorkspaces(on: boolean) { return this.op('SetSwitcherAllWorkspaces', 'b', [on]) }
  /** Task View: the shell's window over the apps (it is always on bottom otherwise, rc.xml), and back. */
  setShellRaised(handle: string, raised: boolean) { return this.op('SetShellRaised', 'sb', [handle, raised]) }

  /** #53: the taskbar's height, reserved by the bridge at the bottom of every output (layer-shell exclusive zone). */
  setPanelHeight(height: number) {
    this.panelHeight = Math.max(0, Math.min(256, Math.round(height)))
    return this.op('SetPanelHeight', 'u', [this.panelHeight])
  }
  private panelHeight: number | null = null

  /** A small JPEG of an output for Task View, as a data: URL held in memory only; null when the bridge can't. */
  async captureOutput(output: string, maxWidth: number): Promise<string | null> {
    try {
      const r = await this.call(BRIDGE_PATH, BRIDGE, 'CaptureOutput', HANDLE_INDEX, [output, Math.max(64, Math.min(640, Math.round(maxWidth)))])
      const data = r?.body?.[0]
      if (!(data instanceof Uint8Array) || !data.length || data.length > 2 * 1024 * 1024) return null
      return `data:image/jpeg;base64,${Buffer.from(data).toString('base64')}`
    } catch {
      return null
    }
  }

  /** The shell's own main window (app_id worksuite-shell; the per-monitor desktops are "WorkSuite desktop <output>"). */
  shellWindow(): PanelWindow | undefined {
    return this.windows.find((w) => w.appId === 'worksuite-shell' && !w.title.startsWith('WorkSuite desktop '))
  }

  trayActivate(key: string, x: number, y: number) { return this.op('Activate', 'sii', [key, Math.round(x), Math.round(y)], TRAY_PATH, TRAY_IFACE) }
}

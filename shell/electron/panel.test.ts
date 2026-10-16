import { describe, expect, it, vi } from 'vitest'
import dbus from 'dbus-next'
import { BRIDGE, BRIDGE_PATH, PanelClient, SHELL, SHELL_PATH, TRAY_IFACE, TRAY_PATH, rowsToWindows, toWorkspaces, type PanelBus } from './panel'

const { Message } = dbus
type Msg = InstanceType<typeof Message>

function fakeBus(replies: Record<string, (m: Msg) => unknown[] | Error>) {
  const sent: Msg[] = []
  const calls: Msg[] = []
  let onMessage: (m: Msg) => void = () => {}
  let methodHandler: (m: Msg) => boolean = () => false
  const bus: PanelBus = {
    async call(m) {
      calls.push(m)
      const fn = replies[m.member ?? '']
      if (!fn) return new Message({ type: 2, body: [] })
      const r = fn(m)
      if (r instanceof Error) throw r
      return { body: r } as unknown as Msg
    },
    send(m) { sent.push(m) },
    on(_e, fn) { onMessage = fn },
    addMethodHandler(fn) { methodHandler = fn },
    async requestName() { return 1 },
  }
  return { bus, sent, calls, emit: (m: Msg) => onMessage(m), method: (m: Msg) => methodHandler(m) }
}

const dbusError = (type: string) => Object.assign(new Error(type), { type })

describe('panel client', () => {
  it('lists windows and tray items from the bridge and subscribes first', async () => {
    const f = fakeBus({
      ListWindows: () => [[['w1', 'foot', 'Terminal', 'HDMI-A-1', 1]]],
      ListItems: () => [[[':1.9/StatusNotifierItem', 'nm-applet', 'Network', 'network-wireless', 'Active']]],
    })
    const windows = vi.fn(), tray = vi.fn()
    const c = new PanelClient(f.bus, { windows, tray, launcher: vi.fn() })
    await c.start()
    expect(f.calls.map((m) => m.member)).toContain('SubscribeWindowEvents')
    expect(f.calls.findIndex((m) => m.member === 'SubscribeWindowEvents')).toBeLessThan(f.calls.findIndex((m) => m.member === 'ListWindows'))
    expect(windows).toHaveBeenLastCalledWith([{ handle: 'w1', appId: 'foot', title: 'Terminal', output: 'HDMI-A-1', flags: 1 }])
    expect(tray).toHaveBeenLastCalledWith([{ key: ':1.9/StatusNotifierItem', id: 'nm-applet', title: 'Network', icon: 'network-wireless', status: 'Active' }])
  })

  it('refreshes once per burst of window signals', async () => {
    let n = 0
    const f = fakeBus({ ListWindows: () => { n++; return [[]] } })
    const c = new PanelClient(f.bus, { windows: vi.fn(), tray: vi.fn(), launcher: vi.fn() }, 5)
    await c.start()
    n = 0
    for (const member of ['WindowAdded', 'WindowChanged', 'WindowRemoved']) f.emit(new Message({ type: 4, path: BRIDGE_PATH, interface: BRIDGE, member }))
    await new Promise((r) => setTimeout(r, 30))
    expect(n).toBe(1)
  })

  it('reports hotplug (OutputsChanged) and relists windows on their new output', async () => {
    let n = 0
    const f = fakeBus({ ListWindows: () => { n++; return [[]] } })
    const outputs = vi.fn()
    const c = new PanelClient(f.bus, { windows: vi.fn(), tray: vi.fn(), launcher: vi.fn(), outputs }, 5)
    await c.start()
    n = 0
    f.emit(new Message({ type: 4, path: BRIDGE_PATH, interface: BRIDGE, member: 'OutputsChanged' }))
    await new Promise((r) => setTimeout(r, 30))
    expect(outputs).toHaveBeenCalledOnce()
    expect(n).toBe(1)
  })

  it('maps bridge errors to codes', async () => {
    const f = fakeBus({
      ActivateWindow: () => dbusError('lk.worksuite.WaylandBridge1.Error.NotFound'),
      CloseWindow: () => dbusError('lk.worksuite.WaylandBridge1.Error.NotSupported'),
      SetMinimized: () => dbusError('org.freedesktop.DBus.Error.ServiceUnknown'),
      Activate: () => [],
    })
    const c = new PanelClient(f.bus, { windows: vi.fn(), tray: vi.fn(), launcher: vi.fn() })
    expect(await c.activate('gone')).toEqual({ ok: false, error: 'not_found' })
    expect(await c.close('w')).toEqual({ ok: false, error: 'not_supported' })
    expect(await c.minimize('w', true)).toEqual({ ok: false, error: 'bridge_unavailable' })
    expect(await c.trayActivate('k', 1.4, 2.6)).toEqual({ ok: true, value: true })
    const act = f.calls.find((m) => m.member === 'Activate')!
    expect([act.path, act.interface, act.body]).toEqual([TRAY_PATH, TRAY_IFACE, ['k', 1, 3]])
  })

  it('exports lk.worksuite.Shell1 for the Super key', async () => {
    const f = fakeBus({})
    const launcher = vi.fn()
    await new PanelClient(f.bus, { windows: vi.fn(), tray: vi.fn(), launcher }).start()
    expect(f.method(new Message({ type: 1, serial: 7, sender: ':1.2', path: SHELL_PATH, interface: SHELL, member: 'ToggleLauncher' }))).toBe(true)
    expect(launcher).toHaveBeenCalledWith('toggle')
    expect(f.sent).toHaveLength(1)
    expect(f.method(new Message({ type: 1, serial: 8, sender: ':1.2', path: '/other', interface: SHELL, member: 'ToggleLauncher' }))).toBe(false)
    // Super+A: the AI assistant.
    expect(f.method(new Message({ type: 1, serial: 9, sender: ':1.2', path: SHELL_PATH, interface: SHELL, member: 'ToggleAssistant' }))).toBe(true)
    expect(launcher).toHaveBeenLastCalledWith('assistant')
  })

  it('opens an archive in Files through Shell1.OpenArchive', async () => {
    const f = fakeBus({})
    const openArchive = vi.fn()
    await new PanelClient(f.bus, { windows: vi.fn(), tray: vi.fn(), launcher: vi.fn(), openArchive }).start()
    expect(f.method(new Message({ type: 1, serial: 9, sender: ':1.2', path: SHELL_PATH, interface: SHELL, member: 'OpenArchive', signature: 's', body: ['/home/a/x.zip'] }))).toBe(true)
    expect(openArchive).toHaveBeenCalledWith('/home/a/x.zip')
    expect(f.method(new Message({ type: 1, serial: 10, sender: ':1.2', path: SHELL_PATH, interface: SHELL, member: 'OpenArchive', signature: 'u', body: [1] }))).toBe(false)
  })

  it('ignores malformed rows', () => {
    expect(rowsToWindows([['a'], 'x', ['h', 'app', 't', 'o', 2]])).toEqual([{ handle: 'h', appId: 'app', title: 't', output: 'o', flags: 2 }])
    expect(rowsToWindows(undefined)).toEqual([])
  })
})

describe('panel workspaces (WSOS-DSK-003)', () => {
  it('reads Labwc desktops from the bridge and follows WorkspacesChanged', async () => {
    let current = 1
    const f = fakeBus({
      ListWorkspaces: () => [current, 4, { w1: 1, w2: 3, 'bad;': 2 }],
      Get: () => [{ value: ['activate', 'close', 'minimize', 'workspaces'] }],
      ListWindows: () => [[]],
      ActivateWorkspace: () => [],
      MoveWindowToWorkspace: () => [],
    })
    const workspaces = vi.fn()
    const c = new PanelClient(f.bus, { windows: vi.fn(), tray: vi.fn(), launcher: vi.fn(), workspaces })
    await c.start()
    expect(workspaces).toHaveBeenLastCalledWith({ supported: true, current: 1, count: 4, windows: { w1: 1, w2: 3 } })
    current = 3
    f.emit(new Message({ type: 4, path: BRIDGE_PATH, interface: BRIDGE, member: 'WorkspacesChanged', signature: 'uu', body: [3, 4] }))
    await new Promise((r) => setTimeout(r, 10))
    expect(workspaces).toHaveBeenLastCalledWith(expect.objectContaining({ current: 3 }))
    expect(await c.activateWorkspace(2)).toEqual({ ok: true, value: true })
    expect(await c.moveToWorkspace('w1', 4)).toEqual({ ok: true, value: true })
    const sent = f.calls.filter((m) => m.member === 'ActivateWorkspace' || m.member === 'MoveWindowToWorkspace')
    expect(sent.map((m) => [m.member, m.signature, m.body])).toEqual([['ActivateWorkspace', 'u', [2]], ['MoveWindowToWorkspace', 'su', ['w1', 4]]])
  })

  it('is unsupported without the bridge operation or with one desktop', () => {
    expect(toWorkspaces([1, 4, {}], ['activate']).supported).toBe(false)
    expect(toWorkspaces([1, 1, {}], ['workspaces']).supported).toBe(false)
    expect(toWorkspaces([9, 4, {}], ['workspaces']).current).toBe(4)
    expect(toWorkspaces(null, ['workspaces'])).toEqual({ supported: false, current: 1, count: 1, windows: {} })
  })

  it('reports NotFound from the bridge as not_found', async () => {
    const f = fakeBus({ ActivateWorkspace: () => dbusError('lk.worksuite.WaylandBridge1.Error.NotFound') })
    const c = new PanelClient(f.bus, { windows: vi.fn(), tray: vi.fn(), launcher: vi.fn() })
    expect(await c.activateWorkspace(9)).toEqual({ ok: false, error: 'not_found' })
  })
})

// @vitest-environment jsdom
// WSOS-DSK-004: the taskbar status group shows the real network, Bluetooth, volume and battery state from the bridge,
// and nothing when a service is unavailable (no invented values).
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { QuickPanel, QuickTray, signalBars, trayIndicators, useQuickState, type QuickState } from './QuickSettings'
import { os } from '../lib/os'

const g = globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }
beforeAll(() => { g.IS_REACT_ACT_ENVIRONMENT = true })
let root: Root | null = null
let host: HTMLDivElement | null = null
afterEach(() => { act(() => root?.unmount()); host?.remove(); root = null; host = null; vi.restoreAllMocks() })
const render = (el: React.ReactElement) => { host = document.createElement('div'); document.body.append(host); root = createRoot(host); act(() => root!.render(el)); return host }

const full: QuickState = {
  net: { wifi_enabled: true, devices: [{ device: 'wlan0', type: 'wifi', state: 'connected', connection: 'Office' }], networks: [] },
  bt: { powered: true, name: 'pc', discoverable: false, paired: [{ address: 'AA', name: 'Buds', connected: true }] },
  sound: { volume: 40, muted: false, outputs: [], inputs: [] },
  battery: { present: true, percentage: 81, state: 'discharging', time_to_full_s: null, time_to_empty_s: 5400, on_battery: true },
  light: null, mode: null,
}

describe('WSOS-DSK-004 quick settings', () => {
  it('tray: one icon per live service and the battery text as its tooltip', () => {
    const el = render(<QuickTray state={full} open={false} onToggle={() => {}} />)
    const btn = el.querySelector('button')!
    expect(btn.querySelectorAll('svg')).toHaveLength(4)
    expect(btn.title).toMatch(/81%/)
  })

  it('tray: unavailable services show no invented values; the network says it is unavailable', () => {
    const el = render(<QuickTray state={{ net: null, bt: null, sound: null, battery: null, light: null, mode: null }} open={false} onToggle={() => {}} />)
    const items = [...el.querySelectorAll<HTMLElement>('[data-indicator]')]
    expect(items.map((i) => [i.dataset.indicator, i.title])).toEqual([['net', 'Network status unavailable']])
    expect(items[0].className).toContain('opacity-60')
    expect(el.querySelector('button')!.title).toBe('')
  })

  it('tray (#28): Wi-Fi signal, Bluetooth connections, battery percentage and charging', () => {
    const wifi = { ...full, net: { ...full.net!, networks: [{ ssid: 'Office', signal: 45, security: 'WPA2', in_use: true }] } }
    expect(trayIndicators(wifi).map((i) => i.label)).toEqual(['Wi-Fi Office, signal 45%', 'Bluetooth, 1 connected', 'Volume 40%', 'Battery 81%'])
    expect(trayIndicators(wifi)[0].level).toBe(2)
    expect(trayIndicators(wifi).find((i) => i.id === 'battery')!.text).toBe('81%')
    const charging = { ...full, battery: { ...full.battery!, on_battery: false, state: 'charging' } }
    expect(trayIndicators(charging).at(-1)!.label).toBe('Battery 81%, charging')
    const ac = { ...full, battery: { ...full.battery!, on_battery: false, state: 'fully-charged', percentage: 100 } }
    expect(trayIndicators(ac).at(-1)!.label).toBe('Battery 100%, plugged in')
    const off = { ...full, net: { ...full.net!, wifi_enabled: false }, bt: { ...full.bt!, powered: false } }
    expect(trayIndicators(off).slice(0, 2).map((i) => [i.label, i.dim])).toEqual([['Wi-Fi off', true], ['Bluetooth off', true]])
    const wired = { ...full, net: { wifi_enabled: true, devices: [{ device: 'eth0', type: 'ethernet', state: 'connected', connection: 'Wired' }], networks: [] } }
    expect(trayIndicators(wired)[0].label).toBe('Wired network connected')
    expect([signalBars(90), signalBars(50), signalBars(10), signalBars(0)]).toEqual([3, 2, 1, 0])
  })

  it('tray (#28): right-click on an indicator opens its Settings page', () => {
    const open = vi.fn()
    const el = render(<QuickTray state={full} open={false} onToggle={() => {}} onOpenSettings={open} />)
    act(() => { el.querySelector('[data-indicator="bt"]')!.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true })) })
    act(() => { el.querySelector('[data-indicator="battery"] svg')!.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true })) })
    expect(open.mock.calls).toEqual([['Bluetooth'], ['Power']])
  })

  it('tray (#28): re-reads the state when a service signals a change', async () => {
    let fire: (k: string) => void = () => {}
    ;(os as { onSysChanged?: unknown }).onSysChanged = (cb: (k: string) => void) => { fire = cb; return () => {} }
    const bat = vi.spyOn(os, 'sysBattery').mockResolvedValue({ available: false, reason: 'no_battery' } as never)
    function Probe() { useQuickState(); return null }
    render(<Probe />)
    await act(async () => { await Promise.resolve() })
    const before = bat.mock.calls.length
    await act(async () => { fire('battery') })
    expect(bat.mock.calls.length).toBe(before + 1)
    delete (os as { onSysChanged?: unknown }).onSysChanged
  })

  it('panel: mute goes to the bridge, the connected network is shown', async () => {
    const mute = vi.spyOn(os, 'sysSetMute').mockResolvedValue({ available: true, value: true } as never)
    const el = render(<QuickPanel state={full} refresh={() => {}} dnd={false} setDnd={() => {}} onSettings={() => {}} onLock={() => {}} onPower={() => {}} onClose={() => {}} />)
    expect(el.textContent).toContain('Office')
    const b = el.querySelector<HTMLButtonElement>('button[aria-label="Mute"]')!
    await act(async () => { b.click() })
    expect(mute).toHaveBeenCalledWith(true)
  })

  it('useQuickState reads every service from the bridge', async () => {
    vi.spyOn(os, 'sysNetwork').mockResolvedValue({ available: true, value: full.net! })
    vi.spyOn(os, 'sysBluetooth').mockResolvedValue({ available: false, reason: 'missing' })
    vi.spyOn(os, 'sysSound').mockResolvedValue({ available: true, value: full.sound! })
    vi.spyOn(os, 'sysBattery').mockResolvedValue({ available: true, value: full.battery! })
    let seen: QuickState | null = null
    const Probe = () => { seen = useQuickState()[0]; return null }
    render(<Probe />)
    await act(async () => { await new Promise((r) => setTimeout(r, 0)) })
    expect(seen!.net?.devices[0].connection).toBe('Office')
    expect(seen!.bt).toBeNull()
    expect(seen!.battery?.percentage).toBe(81)
  })
})

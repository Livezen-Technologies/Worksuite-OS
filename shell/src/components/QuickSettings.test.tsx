// @vitest-environment jsdom
// WSOS-DSK-004: the taskbar status group shows the real network, Bluetooth, volume and battery state from the bridge,
// and nothing when a service is unavailable (no invented values).
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { QuickPanel, QuickTray, useQuickState, type QuickState } from './QuickSettings'
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

  it('tray: unavailable services show no icon and no battery text', () => {
    const el = render(<QuickTray state={{ net: null, bt: null, sound: null, battery: null, light: null, mode: null }} open={false} onToggle={() => {}} />)
    expect(el.querySelectorAll('svg')).toHaveLength(1)   // the settings glyph only
    expect(el.querySelector('button')!.title).toBe('')
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

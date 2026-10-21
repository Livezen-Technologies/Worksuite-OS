// @vitest-environment jsdom
// Settings › Display (WSOS-DSK-006) and the per-monitor desktop (DSK-005) against the in-memory display stub.
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import axe from 'axe-core'
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { DisplayPanel, sideOf } from './DisplaySettings'
import OutputDesktop from './OutputDesktop'
import { REVERT_SECONDS, displays, refreshRates, resolutions, secondsLeft, stubDisplays, wallpaperFor, windowsOnOutput, WALLPAPERS, type DisplayState } from '../lib/displays'
import type { PanelWindow } from '../lib/panel'

const g = globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }
beforeAll(() => { g.IS_REACT_ACT_ENVIRONMENT = true })

let root: Root | null = null
let host: HTMLDivElement | null = null
afterEach(() => { act(() => root?.unmount()); host?.remove(); root = null; host = null; vi.useRealTimers() })

async function render(el: React.ReactElement) {
  host = document.createElement('div')
  document.body.append(host)
  root = createRoot(host)
  await act(async () => { root!.render(el) })
  await act(async () => { await Promise.resolve() })
  return host
}
const byLabel = <T extends HTMLElement>(label: string) => document.querySelector<T>(`[aria-label="${label}"]`)!
const button = (text: string) => [...document.querySelectorAll('button')].find((b) => b.textContent === text)!
async function choose(sel: HTMLSelectElement, value: string) {
  await act(async () => {
    sel.value = value
    sel.dispatchEvent(new Event('change', { bubbles: true }))
  })
}

describe('display helpers', () => {
  const w = (handle: string, output: string): PanelWindow => ({ handle, appId: 'foot', title: handle, output, flags: 0 })
  it('lists windows on the monitor they are on; the primary takes unknown ones', () => {
    const ws = [w('a', 'eDP-1'), w('b', 'HDMI-A-1'), w('c', ''), w('d', 'DP-9')]
    expect(windowsOnOutput(ws, 'HDMI-A-1', false, ['eDP-1', 'HDMI-A-1']).map((x) => x.handle)).toEqual(['b'])
    expect(windowsOnOutput(ws, 'eDP-1', true, ['eDP-1', 'HDMI-A-1']).map((x) => x.handle)).toEqual(['a', 'c', 'd'])
  })
  it('counts down in whole seconds', () => {
    expect(secondsLeft(16000, 1000)).toBe(15)
    expect(secondsLeft(16000, 15001)).toBe(1)
    expect(secondsLeft(16000, 20000)).toBe(0)
  })
  it('lists resolutions and refresh rates per output, and picks wallpapers', async () => {
    const s = await stubDisplays().displayState()
    if (!s.ok) throw new Error()
    const ext = s.value.outputs[1]
    expect(resolutions(ext)).toEqual([{ width: 3840, height: 2160 }, { width: 1920, height: 1080 }])
    expect(refreshRates(ext, 1920, 1080)).toEqual([60, 50])
    const st = { ...s.value, wallpapers: { 'HDMI-A-1': 'dusk' } } as DisplayState
    expect(wallpaperFor(st, 'HDMI-A-1', 'x')).toBe(WALLPAPERS.dusk.css)
    expect(wallpaperFor(st, 'eDP-1', 'x')).toBe('x')
  })
  it('reads positions back as sides', () => {
    const p = { name: 'p', enabled: true, width: 1, height: 1, refresh: 0, scale: 1, x: 1000, y: 0 }
    expect(sideOf({ ...p, x: 0 }, p)).toBe('left')
    expect(sideOf({ ...p, x: 2000 }, p)).toBe('right')
    expect(sideOf({ ...p, y: 900 }, p)).toBe('below')
  })
})

describe('Settings › Display', () => {
  it('changes scale per monitor and reverts after 15 seconds without an answer', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'setInterval', 'clearTimeout', 'clearInterval', 'Date'] })
    await render(<DisplayPanel />)
    const ext = [...document.querySelectorAll<HTMLButtonElement>('[aria-label="Connected displays"] button')].find((b) => b.textContent?.includes('HDMI-A-1'))!
    await act(async () => { ext.click() })
    expect(byLabel<HTMLSelectElement>('Scale').value).toBe('2')
    await choose(byLabel('Scale'), '1.25')
    await choose(byLabel('Resolution'), '1920x1080')
    expect(byLabel<HTMLSelectElement>('Refresh rate').value).toBe('60')
    await choose(byLabel('Refresh rate'), '50')
    await act(async () => { button('Apply').click() })
    await act(async () => { await Promise.resolve() })
    const dlg = document.querySelector('[role="alertdialog"]')!
    expect(dlg.textContent).toContain('Keep these display settings?')
    expect(dlg.textContent).toContain(`Reverting in ${REVERT_SECONDS} seconds`)
    let s = await displays.displayState()
    expect(s.ok && s.value.outputs[1].scale).toBe(1.25)
    await act(async () => { vi.advanceTimersByTime(5000) })
    expect(document.querySelector('[role="alertdialog"]')!.textContent).toContain('Reverting in 10 seconds')
    await act(async () => { vi.advanceTimersByTime(10000) })
    expect(document.querySelector('[role="alertdialog"]')).toBeNull()
    s = await displays.displayState()
    expect(s.ok && s.value.outputs[1].scale).toBe(2)
    expect(s.ok && s.value.outputs[1].modes.find((m) => m.current)?.width).toBe(3840)
  })

  it('keeps changes, primary and mirror when confirmed', async () => {
    await render(<DisplayPanel />)
    const ext = [...document.querySelectorAll<HTMLButtonElement>('[aria-label="Connected displays"] button')].find((b) => b.textContent?.includes('HDMI-A-1'))!
    await act(async () => { ext.click() })
    await act(async () => { byLabel<HTMLInputElement>('Make this my main display').click() })
    await choose(byLabel('Multiple displays'), 'mirror')
    await act(async () => { button('Apply').click() })
    await act(async () => { await Promise.resolve() })
    const res = await axe.run(document.querySelector('[role="alertdialog"]') as Element, { rules: { 'color-contrast': { enabled: false } } })
    expect(res.violations.map((v) => v.id)).toEqual([])
    await act(async () => { button('Keep changes').click() })
    await act(async () => { await Promise.resolve() })
    expect(document.querySelector('[role="alertdialog"]')).toBeNull()
    const s = await displays.displayState()
    expect(s.ok && [s.value.layout.primary, s.value.layout.arrangement, s.value.pending]).toEqual(['HDMI-A-1', 'mirror', null])
    await choose(byLabel('Wallpaper'), 'teal')
    const s2 = await displays.displayState()
    expect(s2.ok && s2.value.wallpapers).toEqual({ 'HDMI-A-1': 'teal' })
  })
})

describe('Keep changes errors (#60)', () => {
  it('shows a meaningful message when keeping fails or the IPC call rejects', async () => {
    await render(<DisplayPanel />)
    await choose(byLabel('Scale'), '1.25')
    await act(async () => { button('Apply').click() })
    await act(async () => { await Promise.resolve() })
    const keep = vi.spyOn(displays, 'displayKeep').mockRejectedValueOnce(new Error("Error invoking remote method 'ws:displayKeep'"))
    await act(async () => { button('Keep changes').click() })
    await act(async () => { await Promise.resolve() })
    expect(document.querySelector('[role="alert"]')?.textContent).toBe('Something went wrong while changing the display. Your previous layout is kept; try again.')
    keep.mockResolvedValueOnce({ ok: false, error: 'save_failed' })
    await act(async () => { button('Keep changes').click() })
    await act(async () => { await Promise.resolve() })
    expect(document.querySelector('[role="alert"]')?.textContent).toContain('couldn’t be saved')
    keep.mockRestore()
    await act(async () => { button('Keep changes').click() })
  })
})

describe('Settings › Display modes (#32)', () => {
  const one = (o: Partial<DisplayState['outputs'][number]>): DisplayState => {
    const out = { name: 'Virtual-1', description: 'Virtual', make: '', model: '', serial: '', enabled: true, x: 0, y: 0, scale: 1, transform: 'normal', modes: [{ width: 1280, height: 800, refresh: 60, preferred: true, current: true }], ...o }
    return { outputs: [out], layout: { arrangement: 'extend', primary: out.name, outputs: [{ name: out.name, enabled: true, width: 1280, height: 800, refresh: 60, scale: 1, x: 0, y: 0 }] }, wallpapers: {}, pending: null }
  }
  it('lists every offered mode, custom sizes included', async () => {
    const st = one({ modes: [{ width: 1280, height: 800, refresh: 60, preferred: true, current: true }, { width: 1920, height: 1080, refresh: 0, preferred: false, current: false, custom: true }, { width: 1024, height: 768, refresh: 0, preferred: false, current: false, custom: true }] })
    const spy = vi.spyOn(displays, 'displayState').mockResolvedValue({ ok: true, value: st })
    await render(<DisplayPanel />)
    const opts = [...byLabel<HTMLSelectElement>('Resolution').options].map((o) => o.value)
    expect(opts).toEqual(['1920x1080', '1280x800', '1024x768'])
    expect(document.body.textContent).toContain('3 resolutions available')
    spy.mockRestore()
  })
  it('explains a firmware framebuffer instead of offering modes it cannot set', async () => {
    const spy = vi.spyOn(displays, 'displayState').mockResolvedValue({ ok: true, value: one({ driver: 'simpledrm', fixedMode: true }) })
    await render(<DisplayPanel />)
    expect(byLabel<HTMLSelectElement>('Resolution').options).toHaveLength(1)
    expect(document.body.textContent).toContain('basic firmware framebuffer')
    expect(document.body.textContent).toContain('Settings › Drivers')
    spy.mockRestore()
  })
})

describe('secondary monitor desktop', () => {
  it('shows its own wallpaper and an accessible taskbar', async () => {
    await displays.displayWallpaper('HDMI-A-1', 'sunrise')
    const h = await render(<OutputDesktop output="HDMI-A-1" />)
    const el = h.querySelector<HTMLElement>('[data-output="HDMI-A-1"]')!
    expect(el.style.background).toContain('linear-gradient')
    expect(h.querySelector('nav')).not.toBeNull()
    const res = await axe.run(h, { rules: { 'color-contrast': { enabled: false } } })
    expect(res.violations.map((v) => v.id)).toEqual([])
  })
})

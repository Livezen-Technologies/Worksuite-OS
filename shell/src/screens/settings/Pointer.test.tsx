// @vitest-environment jsdom
// Settings › Mouse & touchpad (#35) against the in-memory pointer stub.
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import axe from 'axe-core'
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { PointerPanel } from './Pointer'
import { speedToStep, stepToSpeed, stubPointer, type PointerApi } from '../../lib/pointer'

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
const byLabel = <T extends HTMLElement>(l: string) => host!.querySelector<T>(`[aria-label="${l}"]`)
const click = async (el: HTMLElement) => { await act(async () => { el.click() }); await act(async () => { await Promise.resolve() }) }

describe('Settings › Mouse & touchpad', () => {
  it('maps the slider to libinput speed', () => {
    expect(speedToStep(-1)).toBe(1)
    expect(speedToStep(0)).toBe(6)
    expect(speedToStep(1)).toBe(11)
    expect(stepToSpeed(6)).toBe(0)
    expect(stepToSpeed(8)).toBe(0.4)
  })

  it('applies switches and sliders through the bridge', async () => {
    const api = stubPointer()
    const spy = vi.spyOn(api, 'set')
    await render(<PointerPanel api={api} />)
    await click(byLabel('Tap to click')!)
    expect(spy).toHaveBeenLastCalledWith({ touchpad: { tap: false } })
    expect(byLabel('Tap and drag')).toBeNull()   // follows tap-to-click
    await click(byLabel('Natural scrolling for the mouse')!)
    expect(spy).toHaveBeenLastCalledWith({ mouse: { naturalScroll: true } })
    vi.useFakeTimers()
    const speed = byLabel<HTMLInputElement>('Mouse pointer speed')!
    await act(async () => {
      const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!
      set.call(speed, '8')
      speed.dispatchEvent(new Event('input', { bubbles: true }))
    })
    expect(spy).toHaveBeenCalledTimes(2)   // not until the slider settles
    await act(async () => { vi.advanceTimersByTime(300) })
    expect(spy).toHaveBeenLastCalledWith({ mouse: { speed: 0.4 } })
    vi.useRealTimers()
    await click([...host!.querySelectorAll<HTMLButtonElement>('[role="radio"]')].find((b) => b.textContent === 'Right')!)
    expect(spy).toHaveBeenLastCalledWith({ mouse: { leftHanded: true } })
    const s = await api.state()
    expect(s.available && s.value.settings.mouse).toMatchObject({ speed: 0.4, naturalScroll: true, leftHanded: true })
  })

  it('hides what the hardware does not have and marks swipes unavailable', async () => {
    await render(<PointerPanel api={stubPointer([{ name: 'USB Mouse', kind: 'mouse', caps: { tap: false, naturalScroll: true, leftHanded: true, accel: true, flat: false, edgeScroll: false, twoFingerScroll: false, clickfinger: false, buttonAreas: false, disableWhileTyping: false, dragLock: false } }])} />)
    expect(host!.textContent).not.toContain('Touchpad sensitivity')
    expect(byLabel('Tap to click')).toBeNull()
    expect(byLabel('Mouse pointer acceleration')).toBeNull()   // no flat profile: nothing to switch
    await act(async () => { root!.unmount() }); host!.remove(); root = null
    await render(<PointerPanel api={stubPointer()} />)
    const swipes = byLabel<HTMLButtonElement>('Three- and four-finger swipes')!
    expect(swipes.getAttribute('aria-disabled')).toBe('true')
    const res = await axe.run(host!, { rules: { 'color-contrast': { enabled: false } } })
    expect(res.violations.map((v) => v.id)).toEqual([])
  })

  it('says when nothing is connected, when the bridge is missing, and when a change fails', async () => {
    await render(<PointerPanel api={stubPointer([])} />)
    expect(host!.textContent).toContain('No mouse or touchpad found')
    await act(async () => { root!.unmount() }); host!.remove(); root = null
    await render(<PointerPanel api={null} />)
    expect(host!.textContent).toContain('Mouse & touchpad')
    await act(async () => { root!.unmount() }); host!.remove(); root = null
    const api: PointerApi = { ...stubPointer(), set: async () => ({ available: false, reason: 'labwc_reload' }) }
    await render(<PointerPanel api={api} />)
    await click(byLabel('Tap to click')!)
    expect(host!.querySelector('[role="alert"]')!.textContent).toContain('couldn’t load the new pointer settings')
    expect(byLabel('Tap to click')!.getAttribute('aria-checked')).toBe('true')
  })
})

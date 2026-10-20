// @vitest-environment jsdom
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { applyTouchMode, installOskFocus, isTextField, oskShowOnFocus, type TouchApi, type TouchState } from './touch'
import { KeyboardPanel, TouchPanel } from '../screens/settings/Touch'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const base: TouchState = {
  devices: [], settings: { touchEnabled: true, mapToOutput: {}, tabletMode: 'auto', rotationLock: false, osk: 'touch', oskSize: 'medium', calibration: {} },
  tabletSwitch: false, touchMode: false, orientation: null, hasAccelerometer: false, osk: { available: true, visible: false }, outputs: ['eDP-1'],
}
function fakeApi(st: TouchState): TouchApi & { set: ReturnType<typeof vi.fn> } {
  return {
    state: async () => ({ available: true, value: st }),
    set: vi.fn(async (p) => ({ available: true as const, value: { ...st, settings: { ...st.settings, ...p } } })),
    osk: async (v) => ({ available: true, value: v }), penTest: async () => ({ available: true, value: true }),
    onChange: () => () => {}, onPen: () => () => {},
  }
}
async function render(el: React.ReactElement) {
  const div = document.createElement('div'); document.body.append(div)
  const root = createRoot(div)
  await act(async () => { root.render(el) })
  await act(async () => { await Promise.resolve() })
  return { div, done: () => { act(() => root.unmount()); div.remove() } }
}
afterEach(() => { delete window.worksuiteTouch })

describe('touch mode class', () => {
  it('sets and clears :root[data-touch]', () => {
    applyTouchMode(true); expect(document.documentElement.hasAttribute('data-touch')).toBe(true)
    applyTouchMode(false); expect(document.documentElement.hasAttribute('data-touch')).toBe(false)
  })
  it('knows text fields', () => {
    const i = document.createElement('input'); expect(isTextField(i)).toBe(true)
    i.type = 'checkbox'; expect(isTextField(i)).toBe(false)
    expect(isTextField(document.createElement('textarea'))).toBe(true)
    expect(isTextField(document.createElement('button'))).toBe(false)
  })
})

describe('Settings › Touchscreen & pen', () => {
  it('says honestly when there is no touchscreen', async () => {
    window.worksuiteTouch = fakeApi(base)
    const r = await render(<TouchPanel />)
    expect(r.div.textContent).toContain('No touchscreen detected')
    expect(r.div.textContent).toContain('No pen detected')
    r.done()
  })
  it('turns the touchscreen off and shows the pen', async () => {
    const api = fakeApi({ ...base, devices: [{ name: 'ELAN', node: '/dev/input/event9', kinds: ['touchscreen'], tabletModeSwitch: false }, { name: 'ELAN Stylus', node: '/dev/input/event10', kinds: ['tablet'], tabletModeSwitch: false }] })
    window.worksuiteTouch = api
    const r = await render(<TouchPanel />)
    const sw = r.div.querySelector<HTMLButtonElement>('[role="switch"][aria-label="Use the touchscreen"]')!
    await act(async () => { sw.click() })
    expect(api.set).toHaveBeenCalledWith({ touchEnabled: false })
    expect(r.div.textContent).toContain('ELAN Stylus')
    r.done()
  })
  it('shows unavailable without the bridge', async () => {
    const r = await render(<TouchPanel />)
    expect(r.div.textContent).not.toContain('No touchscreen detected')
    r.done()
  })
})

describe('Settings › Keyboard', () => {
  it('sets the on-screen keyboard mode and size', async () => {
    const api = fakeApi(base)
    window.worksuiteTouch = api
    const r = await render(<KeyboardPanel />)
    const always = [...r.div.querySelectorAll<HTMLButtonElement>('[role="radio"]')].find((b) => b.textContent === 'Always')!
    await act(async () => { always.click() })
    expect(api.set).toHaveBeenCalledWith({ osk: 'always' })
    const large = [...r.div.querySelectorAll<HTMLButtonElement>('[role="radio"]')].find((b) => b.textContent === 'Large')!
    await act(async () => { large.click() })
    expect(api.set).toHaveBeenCalledWith({ oskSize: 'large' })
    r.done()
  })
})

describe('on-screen keyboard and focus (dismiss reliably, no reappearing)', () => {
  function setup() {
    document.body.innerHTML = '<label id="l">Search <input id="q"></label><button id="b">x</button><input id="other">'
    const calls: boolean[] = []
    let t = 1000
    const off = installOskFocus(document, { osk: async (v) => { calls.push(v); return { available: true, value: v } } }, () => t)
    const tap = (el: Element) => { el.dispatchEvent(new Event('pointerdown', { bubbles: true })); el.dispatchEvent(new Event('pointerup', { bubbles: true })) }
    return { calls, off, tap, advance: (ms: number) => { t += ms }, $: (id: string) => document.getElementById(id) as HTMLElement }
  }
  afterEach(() => { document.body.innerHTML = '' })

  it('shows only for a field the person tapped, not for focus moved by the shell', () => {
    const s = setup()
    s.$('q').focus()                          // a panel focusing its own search field as it opens
    expect(s.calls).toEqual([])
    s.$('q').blur()
    s.$('q').dispatchEvent(new Event('pointerdown', { bubbles: true })); s.$('q').focus()
    expect(s.calls).toEqual([true])
    s.off()
  })

  it('hides when the focus leaves, when the field goes away and when the window loses the focus', () => {
    const s = setup()
    s.$('q').dispatchEvent(new Event('pointerdown', { bubbles: true })); s.$('q').focus()
    s.$('b').focus()
    expect(s.calls).toEqual([true, false])
    s.advance(5000)
    s.$('q').focus()                          // the window getting the focus back: no keyboard
    expect(s.calls).toEqual([true, false])
    s.$('other').dispatchEvent(new Event('pointerdown', { bubbles: true })); s.$('other').focus()
    window.dispatchEvent(new Event('blur'))
    expect(s.calls).toEqual([true, false, true, false])
    s.off()
  })

  it('hides when the focused field is removed (a search panel closing)', async () => {
    const s = setup()
    s.$('q').dispatchEvent(new Event('pointerdown', { bubbles: true })); s.$('q').focus()
    s.$('l').remove()
    await new Promise((r) => setTimeout(r, 0))
    expect(s.calls).toEqual([true, false])
    s.off()
  })

  it('a tap on the focused field brings a closed keyboard back; label taps count', () => {
    const s = setup()
    s.$('l').dispatchEvent(new Event('pointerdown', { bubbles: true })); s.$('q').focus()
    expect(s.calls).toEqual([true])
    s.tap(s.$('q'))
    expect(s.calls).toEqual([true, true])
    expect(oskShowOnFocus(s.$('q'), { target: s.$('q'), at: 0 }, 5000)).toBe(false)   // too long ago
    expect(oskShowOnFocus(s.$('b'), { target: s.$('b'), at: 0 }, 1)).toBe(false)      // not a text field
    s.off()
  })
})

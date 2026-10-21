// @vitest-environment jsdom
// #58: the taskbar language switcher lists the enabled fcitx5 methods, shows the active one and switches to Sinhala.
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeAll, describe, expect, it } from 'vitest'
import { InputMethodSwitcher } from './InputMethodSwitcher'
import { HIDDEN_TRAY_IDS } from './PanelItems'
import type { Avail, ImStatus, PeripheralsApi } from '../lib/peripheralsApi'

const g = globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }
beforeAll(() => { g.IS_REACT_ACT_ENVIRONMENT = true })
let root: Root | null = null
let host: HTMLDivElement | null = null
afterEach(() => { act(() => root?.unmount()); host?.remove(); root = null; host = null })
const flush = () => act(async () => { for (let i = 0; i < 5; i++) await Promise.resolve() })
async function render(el: React.ReactElement) {
  host = document.createElement('div'); document.body.append(host); root = createRoot(host)
  act(() => root!.render(el)); await flush(); return host
}

function fakeApi(state: ImStatus, answer?: (id: string) => Avail<string>) {
  const calls: string[] = []
  const api = {
    async imStatus() { return { available: true, value: { ...state } } },
    async setCurrentIm(id: string) {
      calls.push(id)
      const r = answer ? answer(id) : { available: true as const, value: id }
      if (r.available) state.current = r.value
      return r
    },
  } as unknown as PeripheralsApi
  return { api, calls, state }
}
const ALL = ['keyboard-us', 'm17n_si_wijesekera', 'm17n_ta_tamil99']

describe('#58 taskbar input-method switcher', () => {
  it('shows the active method and switches to Sinhala from its menu', async () => {
    const f = fakeApi({ running: true, current: 'keyboard-us', enabled: ALL })
    const el = await render(<InputMethodSwitcher api={f.api} pollMs={60_000} />)
    const btn = el.querySelector<HTMLButtonElement>('[data-testid="im-switcher"]')!
    expect(btn.textContent).toBe('ENG')
    expect(btn.getAttribute('aria-label')).toMatch(/English/)
    act(() => btn.click()); await flush()
    const items = [...el.querySelectorAll<HTMLButtonElement>('[role="menuitemradio"]')]
    expect(items.map((i) => i.getAttribute('aria-checked'))).toEqual(['true', 'false', 'false'])
    act(() => items[1].click()); await flush()
    expect(f.calls).toEqual(['m17n_si_wijesekera'])
    expect(el.querySelector('[role="menu"]')).toBeNull()
    expect(btn.textContent).toBe('සිං')
  })
  it('explains a failed switch instead of doing nothing', async () => {
    const f = fakeApi({ running: false, current: null, enabled: ALL }, () => ({ available: false, reason: 'im_not_running' }))
    const el = await render(<InputMethodSwitcher api={f.api} pollMs={60_000} />)
    const btn = el.querySelector<HTMLButtonElement>('[data-testid="im-switcher"]')!
    expect(btn.getAttribute('aria-label')).toMatch(/not running/)
    act(() => btn.click()); await flush()
    act(() => el.querySelectorAll<HTMLButtonElement>('[role="menuitemradio"]')[1].click()); await flush()
    expect(el.querySelector('[role="alert"]')?.textContent).toMatch(/did not start/)
  })
  it('is hidden with only the US keyboard on, and replaces fcitx5\'s own tray item', async () => {
    const f = fakeApi({ running: true, current: 'keyboard-us', enabled: ['keyboard-us'] })
    const el = await render(<InputMethodSwitcher api={f.api} pollMs={60_000} />)
    expect(el.querySelector('[data-testid="im-switcher"]')).toBeNull()
    expect(HIDDEN_TRAY_IDS).toContain('Fcitx')
  })
})

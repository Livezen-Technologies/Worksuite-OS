// @vitest-environment jsdom
// #70: the taskbar's Accessibility quick panel — grouped rows, real switches with visible On/Off states, a segmented
// text-size control (radio group, arrow keys), the language picker under its label, rem sizes so it scales.
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeAll, describe, expect, it } from 'vitest'
import A11yPanel from './A11yPanel'
import { DEFAULT_A11Y, getA11y, setA11y } from '../lib/a11y'

const g = globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }
beforeAll(() => { g.IS_REACT_ACT_ENVIRONMENT = true })
let root: Root | null = null
let host: HTMLDivElement | null = null
afterEach(() => { act(() => root?.unmount()); host?.remove(); root = null; host = null; act(() => setA11y(DEFAULT_A11Y)) })
const render = () => { host = document.createElement('div'); document.body.append(host); root = createRoot(host); act(() => root!.render(<A11yPanel onClose={() => {}} />)); return host }

describe('#70 accessibility quick panel', () => {
  it('groups Display and Language, with switches that show On/Off', () => {
    const el = render()
    expect([...el.querySelectorAll('h3')].map((h) => h.textContent)).toEqual(['Display', 'Language'])
    const hc = el.querySelector<HTMLButtonElement>('[role=switch][aria-label="High contrast"]')!
    expect(hc.getAttribute('aria-checked')).toBe('false')
    expect(hc.dataset.state).toBe('off')
    expect(document.activeElement).toBe(hc)
    act(() => hc.click())
    expect(getA11y().highContrast).toBe(true)
    expect(hc.getAttribute('aria-checked')).toBe('true')
    expect(hc.dataset.state).toBe('on')
    expect(hc.parentElement!.textContent).toContain('On')
    const rm = el.querySelector<HTMLButtonElement>('[role=switch][aria-label="Reduce motion"]')!
    act(() => rm.click())
    expect(getA11y().reducedMotion).toBe(true)
  })

  it('text size is a segmented radio group: one checked, arrow keys move the choice', () => {
    const el = render()
    const group = el.querySelector<HTMLElement>('[role=radiogroup]')!
    expect(group.getAttribute('aria-labelledby')).toBe('ws-a11y-size')
    const radios = () => [...group.querySelectorAll<HTMLButtonElement>('[role=radio]')]
    expect(radios().map((r) => `${r.textContent}:${r.getAttribute('aria-checked')}:${r.tabIndex}`)).toEqual(['100%:true:0', '150%:false:-1', '200%:false:-1'])
    act(() => radios()[2].click())
    expect(getA11y().textScale).toBe(2)
    act(() => { group.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true })) })
    expect(getA11y().textScale).toBe(1)
    act(() => { group.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowLeft', bubbles: true })) })
    expect(getA11y().textScale).toBe(2)
    expect(radios()[2].getAttribute('aria-checked')).toBe('true')
  })

  it('the language picker is labelled by its heading, full width; the panel widens with the text size it sets', () => {
    const el = render()
    const sel = el.querySelector('select')!
    expect(sel.getAttribute('aria-labelledby')).toBe('ws-a11y-lang-h')
    expect(sel.className).toContain('w-full')
    const panel = el.querySelector<HTMLElement>('[data-testid=a11y-panel]')!
    // Text size scales the text, not rem (index.css), so the width follows --ws-text-scale: 20rem at 100%, 26rem at 200%.
    expect(panel.className).toContain('w-[calc(14rem+6rem*var(--ws-text-scale,1))]')
    expect(panel.className).toContain('overflow-y-auto')
    expect(panel.className).not.toMatch(/w-\[\d+px\]/)
  })

  it('at large text sizes: switches stay at the end of their row, text-size segments never break inside "200%"', () => {
    const el = render()
    for (const sw of el.querySelectorAll('[role=switch]')) {
      const row = sw.closest('[data-testid=a11y-panel] section > div > div')!
      expect(row.className).not.toContain('flex-wrap')
      expect(row.firstElementChild!.className).toContain('flex-1')
    }
    for (const r of el.querySelectorAll('[role=radio]')) expect(r.className).toContain('whitespace-nowrap')
  })
})

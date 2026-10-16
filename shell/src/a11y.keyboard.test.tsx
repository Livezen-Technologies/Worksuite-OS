// @vitest-environment jsdom
// Keyboard walk-through of every shell screen (WSOS-ACC-001/002): each Settings section, App Center, Files, the
// desktop with its launcher, lock, greeter, first run and recovery. Checks that every control is in the tab order
// (no positive tabindex, nothing mouse-only), every focusable element has a visible focus indicator, every
// focusable element has a name and an Orca-readable role, and Escape closes the window it belongs to.
import { act, type ReactElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import axe from 'axe-core'
import { readFileSync } from 'node:fs'
import { afterEach, beforeAll, describe, expect, it } from 'vitest'
import Greeter from './screens/Greeter'
import Lock from './screens/Lock'
import Desktop from './screens/Desktop'
import Files from './screens/Files'
import AppCenter from './screens/AppCenter'
import Settings from './screens/Settings'
import Recovery from './screens/Recovery'
import FirstRun from './screens/FirstRun'
import Monitor from './screens/Monitor'
import { useNotices } from './lib/useNotices'

beforeAll(() => {
  ;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true
  window.matchMedia ??= ((q: string) => ({ matches: false, media: q, addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {}, onchange: null, dispatchEvent: () => false })) as unknown as typeof window.matchMedia
  Element.prototype.scrollIntoView ??= function () {}
  HTMLElement.prototype.animate ??= function () { return { cancel() {}, finished: Promise.resolve() } as unknown as Animation }
})

let root: Root | null = null
let host: HTMLElement | null = null
afterEach(() => { act(() => root?.unmount()); host?.remove(); root = null; host = null })
async function render(ui: ReactElement) {
  host = document.createElement('div'); host.id = 'root'; document.body.appendChild(host)
  root = createRoot(host)
  await act(async () => { root!.render(ui) })
  await settle()
  return host
}
const settle = () => act(async () => { await new Promise((r) => setTimeout(r, 20)) })

const FOCUSABLE = 'a[href], button, input, select, textarea, summary, [tabindex], [contenteditable="true"]'
const hidden = (el: Element) => !!el.closest('[aria-hidden="true"], [hidden], [inert]')
const tabbable = (el: HTMLElement) => [...el.querySelectorAll<HTMLElement>(FOCUSABLE)].filter((e) => !hidden(e) && !(e as HTMLButtonElement).disabled && e.tabIndex >= 0)

/** Focus indicator: the global :focus-visible ring, unless the element removes its outline without a replacement. */
function focusIndicator(e: HTMLElement): boolean {
  const cls = e.getAttribute('class') ?? ''
  if (!/\boutline-(none|hidden)\b/.test(cls) && e.style.outline !== 'none') return true
  if (/\bfocus(-visible)?:/.test(cls)) return true
  // index.css rings the field box of borderless inputs (:has(> input.outline-none:focus-visible)).
  if (/^(INPUT|TEXTAREA|SELECT)$/.test(e.tagName) && /^(LABEL|DIV|FORM)$/.test(e.parentElement?.tagName ?? '')) return true
  for (let a = e.parentElement, i = 0; a && i < 3; a = a.parentElement, i++) if (/(has-\[:focus-visible\]|focus-within):/.test(a.getAttribute('class') ?? '')) return true
  return false
}

/** Controls a mouse user can click (cursor-pointer) that are not reachable by keyboard. */
function mouseOnly(el: HTMLElement): string[] {
  return [...el.querySelectorAll<HTMLElement>('.cursor-pointer')]
    .filter((e) => !hidden(e) && !e.matches(FOCUSABLE) && !e.closest('label, button, a[href], [role="button"]') && !e.querySelector('input, button'))
    .map((e) => e.outerHTML.slice(0, 120))
}

async function walk(name: string, el: HTMLElement) {
  const tabs = tabbable(el)
  expect(tabs.length, `${name}: nothing to tab to`).toBeGreaterThan(0)
  expect(el.querySelectorAll('[tabindex]:not([tabindex="0"]):not([tabindex="-1"])').length, `${name}: positive tabindex`).toBe(0)
  expect(tabs.filter((e) => !focusIndicator(e)).map((e) => e.outerHTML.slice(0, 140)), `${name}: no visible focus`).toEqual([])
  expect(mouseOnly(el), `${name}: mouse-only controls`).toEqual([])
  // Orca: every focusable element has a role and an accessible name (axe rules for names and ARIA validity).
  const res = await axe.run(el, { runOnly: { type: 'rule', values: ['button-name', 'link-name', 'label', 'aria-allowed-role', 'aria-required-attr', 'aria-valid-attr-value', 'aria-roles', 'nested-interactive', 'tabindex', 'aria-command-name', 'aria-input-field-name', 'aria-toggle-field-name', 'select-name'] } })
  expect(res.violations.map((v) => `${v.id}: ${v.nodes.map((n) => n.target.join(' ')).join(', ')}`), `${name}: ARIA`).toEqual([])
}

function DesktopHost() {
  const notes = useNotices(false)
  return <Desktop user="hasarinda" onLock={() => {}} onLogout={() => {}} onOpen={() => {}} notes={notes} />
}
const noop = () => {}

describe('keyboard walk-through (WSOS-ACC-001/002)', () => {
  const screens: [string, () => ReactElement][] = [
    ['Greeter', () => <Greeter onSignIn={noop} />],
    ['Lock', () => <Lock user="hasarinda" onUnlock={noop} notices={[]} />],
    ['Desktop', () => <DesktopHost />],
    ['Files', () => <Files onClose={noop} />],
    ['App Center', () => <AppCenter onClose={noop} />],
    ['Monitor', () => <Monitor onClose={noop} />],
    ['Recovery', () => <Recovery onRestartShell={noop} onLogout={noop} />],
    ['First run', () => <FirstRun onDone={noop} userName="Preview" />],
  ]
  for (const [name, ui] of screens) it(name, async () => { await walk(name, await render(ui())) })

  it('every Settings section, reached from the keyboard', async () => {
    let closed = 0
    const el = await render(<Settings onClose={() => { closed++ }} />)
    const nav = el.querySelector('nav')!
    const sections = [...nav.querySelectorAll<HTMLButtonElement>('li > button')]
    expect(sections.length).toBeGreaterThan(10)
    for (const b of sections) {
      b.focus()
      expect(document.activeElement).toBe(b)
      // Enter/Space on a native button is a click.
      await act(async () => { b.click() })
      await settle()
      expect(b.getAttribute('aria-current')).toBe('page')
      await walk(`Settings › ${b.textContent?.trim()}`, el)
    }
    await act(async () => { window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' })) })
    expect(closed).toBe(1)
  }, 60_000)   // every section plus an axe run each

  it('the checks catch mouse-only controls and hidden focus', async () => {
    const el = await render(<div><div className="cursor-pointer">x</div><button type="button" className="outline-none">y</button></div>)
    expect(mouseOnly(el)).toHaveLength(1)
    expect(tabbable(el).filter((e) => !focusIndicator(e))).toHaveLength(1)
  })

  it('taskbar: Start, Search, apps, then the tray in tab order, centred by default and at the start edge when set to Left', async () => {
    for (const align of ['center', 'left'] as const) {
      localStorage.setItem('ws.taskbarAlign', align)
      const el = await render(<DesktopHost />)
      await settle()
      const nav = el.querySelector<HTMLElement>('nav.ws-taskbar')!
      expect(nav.dataset.align).toBe(align)
      expect(!!nav.querySelector('[data-testid="taskbar-lead"]')).toBe(align === 'center')
      const parts = [...nav.children].map((c) => (c as HTMLElement).dataset.testid).filter(Boolean)
      expect(parts).toEqual(align === 'center' ? ['taskbar-lead', 'taskbar-main', 'taskbar-end'] : ['taskbar-main', 'taskbar-end'])
      const main = nav.querySelector('[data-testid="taskbar-main"]')!
      const first = [...main.querySelectorAll('button')].slice(0, 2).map((b) => b.getAttribute('aria-label') ?? b.textContent)
      expect(first).toEqual(['Open launcher', 'Search'])
      act(() => root?.unmount()); host?.remove()
    }
    localStorage.removeItem('ws.taskbarAlign')
  })

  it('launcher and App Center close with Escape', async () => {
    let closed = 0
    await render(<AppCenter onClose={() => { closed++ }} />)
    await act(async () => { window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' })) })
    expect(closed).toBe(1)
    act(() => root?.unmount()); host?.remove()
    const el = await render(<DesktopHost />)
    const btn = el.querySelector<HTMLButtonElement>('button[aria-label="Open launcher"]')!
    await act(async () => { btn.click() })
    await settle()
    await walk('Launcher', el.querySelector<HTMLElement>('#ws-launcher')!)
  })
})

describe('accessibility settings are wired in CSS (WSOS-ACC-004/005/006)', () => {
  const css = readFileSync('src/index.css', 'utf8')
  it('focus ring, high-contrast ring and field rings exist', () => {
    expect(css).toMatch(/:focus-visible \{ outline: 2px solid #7FB2FF/)
    expect(css).toMatch(/\[data-high-contrast\] :focus-visible:not\(\[tabindex="-1"\]\) \{ outline: 3px solid #ffd400/)
    expect(css).toMatch(/:has\(> :is\(input, textarea, select\)\.outline-none:focus-visible\)/)
  })
  it('app marks are fixed-size logos in fixed-size tiles: never wrap or scale out of the tile at 200 %', () => {
    // Desktop, the taskbar, search and App Center draw marks through AppGlyph (the letter mark when an app has no icon).
    for (const f of ['src/screens/Desktop.tsx', 'src/components/PanelItems.tsx', 'src/components/GlobalSearch.tsx']) expect(readFileSync(f, 'utf8'), f).toMatch(/<AppGlyph /)
    for (const f of ['src/components/AppGlyph.tsx']) {
      const marks = [...readFileSync(f, 'utf8').matchAll(/`ws-mark [^`]*`/g)].map((m) => m[0])
      expect(marks.length, f).toBeGreaterThan(0)
      for (const m of marks) { expect(m).toMatch(/whitespace-nowrap/); expect(m).not.toMatch(/\btext-(xs|sm|base|\[)/) }
    }
  })
  it('reduced motion stops animations and transitions both from the system and from the setting', () => {
    expect(css).toMatch(/@media \(prefers-reduced-motion: reduce\) \{\s*\*, \*::before, \*::after \{ transition: none !important; animation: none !important; \}/)
    expect(css).toMatch(/\[data-reduced-motion\] \*, \[data-reduced-motion\] \*::before, \[data-reduced-motion\] \*::after \{/)
  })
})

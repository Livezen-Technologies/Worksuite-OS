// @vitest-environment jsdom
// Automated accessibility audit of the shell screens with axe-core (WSOS-ACC-001…006): names/labels for
// every control, valid ARIA, landmarks and list structure. jsdom has no layout, so colour contrast is
// checked separately against the design tokens in lib/contrast.test.ts.
import { act, type ReactElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import axe from 'axe-core'
import { afterEach, beforeAll, describe, expect, it } from 'vitest'
import Greeter from './screens/Greeter'
import Lock from './screens/Lock'
import Desktop from './screens/Desktop'
import Files from './screens/Files'
import AppCenter from './screens/AppCenter'
import Settings from './screens/Settings'
import Recovery from './screens/Recovery'
import FirstRun from './screens/FirstRun'
import Installer from './screens/Installer'
import A11yPanel from './components/A11yPanel'
import { useNotices } from './lib/useNotices'
import { setLocale } from './i18n'

const g = globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }

beforeAll(() => {
  g.IS_REACT_ACT_ENVIRONMENT = true
  // jsdom lacks these browser APIs used by the screens.
  window.matchMedia ??= ((q: string) => ({ matches: false, media: q, addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {}, onchange: null, dispatchEvent: () => false })) as unknown as typeof window.matchMedia
  Element.prototype.scrollIntoView ??= function () {}
  HTMLElement.prototype.animate ??= function () { return { cancel() {}, finished: Promise.resolve() } as unknown as Animation }
  window.requestAnimationFrame ??= (cb: FrameRequestCallback) => setTimeout(() => cb(0), 0) as unknown as number
})

let root: Root | null = null
let host: HTMLElement | null = null
afterEach(() => { act(() => root?.unmount()); host?.remove(); root = null; host = null; setLocale('en') })

async function render(ui: ReactElement): Promise<HTMLElement> {
  host = document.createElement('div')
  host.id = 'root'
  document.body.appendChild(host)
  root = createRoot(host)
  await act(async () => { root!.render(ui) })
  await act(async () => { await new Promise((r) => setTimeout(r, 20)) })
  return host
}

async function audit(el: HTMLElement) {
  const res = await axe.run(el, {
    rules: {
      'color-contrast': { enabled: false },   // no layout in jsdom; see lib/contrast.test.ts
      region: { enabled: false },             // screens render inside the app's single root
      'page-has-heading-one': { enabled: false },
    },
  })
  return res.violations.map((v) => `${v.id}: ${v.nodes.map((n) => n.target.join(' ')).join(', ')}`)
}

async function click(el: HTMLElement, name: string) {
  const b = [...el.querySelectorAll<HTMLElement>('button')].find((x) => x.getAttribute('aria-label') === name || x.textContent?.trim() === name)
  if (!b) throw new Error(`no button ${name}`)
  await act(async () => { b.click() })
  await act(async () => { await new Promise((r) => setTimeout(r, 10)) })
}

function DesktopHost() {
  const notes = useNotices(false)
  return <Desktop user="hasarinda" onLock={() => {}} onLogout={() => {}} onOpen={() => {}} notes={notes} />
}

const noop = () => {}
const screens: [string, () => ReactElement][] = [
  ['Greeter', () => <Greeter onSignIn={noop} />],
  ['Lock', () => <Lock user="hasarinda" onUnlock={noop} notices={[{ id: '1', title: 'Synced', at: Date.now(), tone: 'ok' }]} />],
  ['Desktop', () => <DesktopHost />],
  ['Files', () => <Files onClose={noop} />],
  ['App Center', () => <AppCenter onClose={noop} />],
  ['Settings', () => <Settings onClose={noop} />],
  ['Recovery', () => <Recovery onRestartShell={noop} onLogout={noop} />],
  ['First run', () => <FirstRun onDone={noop} userName="Hasarinda" />],
  ['Installer', () => <Installer onDone={noop} />],
  ['Accessibility panel', () => <A11yPanel onClose={noop} />],
]

describe('axe audit', () => {
  for (const [name, ui] of screens) {
    it(`${name} has no axe violations`, async () => {
      expect(await audit(await render(ui()))).toEqual([])
    })
  }

  it('desktop launcher, notifications and accessibility panel have no violations', async () => {
    const el = await render(<DesktopHost />)
    await click(el, 'Open launcher')
    expect(await audit(el)).toEqual([])
    await click(el, 'Open launcher')
    await click(el, 'Notifications')
    expect(await audit(el)).toEqual([])
    await click(el, 'Notifications')
    await click(el, 'Quick settings')
    expect(await audit(el)).toEqual([])
    await click(el, 'Accessibility')
    expect(el.querySelector('[role="dialog"][aria-labelledby="ws-a11y-title"]')).not.toBeNull()
    expect(await audit(el)).toEqual([])
  })

  it('every taskbar control is reachable and named', async () => {
    const el = await render(<DesktopHost />)
    const nav = el.querySelector('nav')!
    const controls = [...nav.querySelectorAll<HTMLElement>('button')]
    expect(controls.length).toBeGreaterThan(5)
    for (const c of controls) {
      expect(c.tabIndex).toBe(0)
      expect((c.getAttribute('aria-label') ?? c.textContent ?? '').trim()).not.toBe('')
    }
  })

  it('greeter strings follow the selected locale', async () => {
    setLocale('si')
    const el = await render(<Greeter onSignIn={noop} />)
    expect(el.querySelector('#ws-pw')!.getAttribute('placeholder')).toBe('මුරපදය')
    expect(await audit(el)).toEqual([])
  })
})

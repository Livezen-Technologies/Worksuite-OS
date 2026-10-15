// @vitest-environment jsdom
// Settings › Default apps (WSOS-DSK-009), clipboard history (DSK-008) and the minimal launcher (SES-005), against a
// fake bridge that records the calls.
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import type { ClipState, DesktopApi, DefaultAppCategory } from '../lib/desktopApi'
import { safeApps } from '../lib/launcher'

const g = globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }
const calls: string[] = []
let cats: DefaultAppCategory[] = [
  { category: 'pdf', current: 'evince', candidates: [{ id: 'evince', name: 'Document Viewer' }, { id: 'okular', name: 'Okular' }] },
  { category: 'web', current: null, candidates: [] },
]
let clip: ClipState = { enabled: false, entries: [] }
const fake: DesktopApi = {
  async defaultApps() { return { ok: true, value: cats } },
  async setDefaultApp(c, id) { calls.push(`set ${c} ${id}`); cats = cats.map((x) => (x.category === c ? { ...x, current: id } : x)); return { ok: true, value: true } },
  async clipboardState() { return clip },
  async clipboardSetEnabled(on) { calls.push(`clip ${on}`); clip = { enabled: on, entries: on ? [{ id: 1, text: 'copied text', at: 0 }] : [] }; return clip },
  async clipboardClear() { calls.push('clear'); clip = { ...clip, entries: [] }; return clip },
  async clipboardRemove() { return clip },
  async clipboardCopy(id) { calls.push(`copy ${id}`); return true },
  onClipboard() { return () => {} },
  async problemReport() { calls.push('report'); return { ok: true, value: 'Documents/WorkSuite problem report.txt' } },
}

let Mod: typeof import('./DesktopSettings')
let Safe: typeof import('./SafeLauncher').default
beforeAll(async () => {
  g.IS_REACT_ACT_ENVIRONMENT = true
  ;(window as unknown as { worksuiteDesktop: DesktopApi }).worksuiteDesktop = fake
  Mod = await import('./DesktopSettings')
  Safe = (await import('./SafeLauncher')).default
})

let root: Root | null = null
let host: HTMLDivElement | null = null
afterEach(() => { act(() => root?.unmount()); host?.remove(); root = null; host = null; calls.length = 0 })
async function render(el: React.ReactElement) {
  host = document.createElement('div')
  document.body.append(host)
  root = createRoot(host)
  await act(async () => { root!.render(el) })
  await act(async () => { await Promise.resolve() })
  return host
}
const button = (text: string) => [...document.querySelectorAll('button')].find((b) => b.textContent === text)!

describe('Default apps', () => {
  it('shows each category with its current app and writes a new choice', async () => {
    const h = await render(<Mod.DefaultAppsPanel />)
    const sel = h.querySelector<HTMLSelectElement>('select[aria-label="PDF documents"]')!
    expect(sel.value).toBe('evince')
    expect(h.textContent).toContain('No installed app can open these')
    await act(async () => { sel.value = 'okular'; sel.dispatchEvent(new Event('change', { bubbles: true })) })
    expect(calls).toEqual(['set pdf okular'])
  })
})

describe('Clipboard history', () => {
  it('is off, shows entries once turned on, and clears them', async () => {
    clip = { enabled: false, entries: [] }
    const h = await render(<Mod.ClipboardSection />)
    const sw = h.querySelector<HTMLButtonElement>('[role="switch"]')!
    expect(sw.getAttribute('aria-checked')).toBe('false')
    expect(h.textContent).not.toContain('copied text')
    await act(async () => { sw.click() })
    expect(h.textContent).toContain('copied text')
    await act(async () => { button('Copy').click() })
    await act(async () => { button('Clear history').click() })
    expect(calls).toEqual(['clip true', 'copy 1', 'clear'])
    expect(h.textContent).not.toContain('copied text')
  })
})

describe('Minimal launcher (WSOS-SES-005)', () => {
  it('lists apps without terminals and offers Settings, Report problem and Log out', async () => {
    const h = await render(<Safe />)
    // Browser-preview bridge: Firefox and the Foot terminal; the terminal is left out.
    expect(h.textContent).toContain('Firefox ESR')
    expect(h.textContent).not.toContain('Foot')
    expect(button('Settings')).toBeTruthy()
    expect(button('Log out')).toBeTruthy()
    await act(async () => { button('Report problem').click() })
    expect(calls).toEqual(['report'])
    expect(h.querySelector('[role="status"]')?.textContent).toContain('Documents/WorkSuite problem report.txt')
  })

  it('safeApps drops terminals and WorkSuite web app entries', () => {
    const a = (id: string, categories: string[]) => ({ id, name: id, generic_name: null, comment: null, icon: null, categories, keywords: [] })
    expect(safeApps([a('xterm', ['System', 'TerminalEmulator']), a('worksuite-mail', []), a('gedit', ['Utility']), a('abiword', [])]).map((x) => x.id)).toEqual(['abiword', 'gedit'])
  })
})

vi.mock('./Settings', () => ({ default: () => null }))

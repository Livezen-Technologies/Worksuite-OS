// @vitest-environment jsdom
// The Windows-style pieces in the shell: Super+V clipboard history and emoji (ClipboardFlyout), the snipping overlay,
// the shortcut cheat sheet, the text fields' right-click menu, Settings › Clipboard and Settings › Keyboard ›
// Shortcuts — against fake bridges, with axe audits, keyboard use, Sinhala strings and right-to-left layout.
import { act, type ReactElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import axe from 'axe-core'
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import type { ClipState, DesktopApi } from '../lib/desktopApi'
import type { CaptureApi } from '../lib/captureApi'
import { setLocale } from '../i18n'

const g = globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }
const calls: string[] = []
let clip: ClipState = { enabled: true, persist: true, entries: [
  { id: 3, kind: 'text', text: 'Quarterly report draft', at: 0, pinned: false },
  { id: 2, kind: 'files', text: 'a.pdf\nb.txt', files: ['/home/u/a.pdf', '/home/u/b.txt'], at: 0, pinned: false },
  { id: 1, kind: 'text', text: 'Pinned address', at: 0, pinned: true },
] }
const desk: DesktopApi = {
  async defaultApps() { return { ok: true, value: [] } },
  async setDefaultApp() { return { ok: true, value: true } },
  async clipboardState() { return clip },
  async clipboardSetEnabled(on) { calls.push(`enable ${on}`); clip = { ...clip, enabled: on }; return clip },
  async clipboardClear(all) { calls.push(`clear ${all ? 'all' : 'unpinned'}`); clip = { ...clip, entries: all ? [] : clip.entries.filter((e) => e.pinned) }; return clip },
  async clipboardRemove(id) { calls.push(`remove ${id}`); clip = { ...clip, entries: clip.entries.filter((e) => e.id !== id) }; return clip },
  async clipboardCopy(id) { calls.push(`copy ${id}`); return true },
  async clipboardPin(id, on) { calls.push(`pin ${id} ${on}`); clip = { ...clip, entries: clip.entries.map((e) => (e.id === id ? { ...e, pinned: on } : e)) }; return clip },
  async clipboardPaste(id, prev) { calls.push(`paste ${id} ${prev}`); return true },
  async clipboardType(text, prev) { calls.push(`type ${text} ${prev}`); return true },
  onClipboard() { return () => {} },
  async problemReport() { return { ok: true, value: '' } },
}
const cap = {
  async allowed() { return true },
  async settings() { return { printOpensSnip: false, mode: 'rect', delay: 0 } },
  async setSettings(p: object) { calls.push(`capture ${JSON.stringify(p)}`); return { printOpensSnip: true, mode: 'rect', delay: 0 } },
  async snipCancel(id: number) { calls.push(`cancel ${id}`) },
  async shortcutsApply(p: unknown) { calls.push(`apply ${JSON.stringify(p)}`); return { available: true, value: true } },
  async edit(cmd: string) { calls.push(`edit ${cmd}`); return true },
  onSnipOpen: () => () => {}, onSnipClose: () => () => {}, onCaptured: () => () => {}, onShellOpen: () => () => {}, onToastClicked: () => () => {},
} as unknown as CaptureApi

let Flyout: typeof import('./ClipboardFlyout').default
let Overlay: typeof import('./SnipOverlay').default
let Help: typeof import('./ShortcutHelp').default
let Menu: typeof import('./TextContextMenu').default
let ClipPanel: typeof import('../screens/settings/Clipboard').ClipboardPanel
let Shortcuts: typeof import('../screens/settings/Shortcuts').ShortcutsPanel
let Tool: typeof import('../screens/SnippingTool').default
beforeAll(async () => {
  g.IS_REACT_ACT_ENVIRONMENT = true
  const w = window as unknown as { worksuiteDesktop: DesktopApi; worksuiteCapture: CaptureApi }
  w.worksuiteDesktop = desk
  w.worksuiteCapture = cap
  Element.prototype.scrollIntoView ??= function () {}
  HTMLCanvasElement.prototype.getContext = (() => null) as unknown as typeof HTMLCanvasElement.prototype.getContext
  Flyout = (await import('./ClipboardFlyout')).default
  Overlay = (await import('./SnipOverlay')).default
  Help = (await import('./ShortcutHelp')).default
  Menu = (await import('./TextContextMenu')).default
  ClipPanel = (await import('../screens/settings/Clipboard')).ClipboardPanel
  Shortcuts = (await import('../screens/settings/Shortcuts')).ShortcutsPanel
  Tool = (await import('../screens/SnippingTool')).default
})

let root: Root | null = null
let host: HTMLElement | null = null
afterEach(() => { act(() => root?.unmount()); host?.remove(); root = null; host = null; calls.length = 0; setLocale('en'); document.dir = 'ltr' })
async function render(ui: ReactElement) {
  host = document.createElement('div')
  document.body.append(host)
  root = createRoot(host)
  await act(async () => { root!.render(ui) })
  await act(async () => { await new Promise((r) => setTimeout(r, 10)) })
  return host
}
async function audit(el: Element = document.body) {
  const res = await axe.run(el, { rules: { 'color-contrast': { enabled: false }, region: { enabled: false }, 'page-has-heading-one': { enabled: false } } })
  return res.violations.map((v) => `${v.id}: ${v.nodes.map((n) => n.target.join(' ')).join(', ')}`)
}
const byLabel = (l: string) => document.querySelector<HTMLElement>(`[aria-label="${l}"]`)
const byText = (s: string) => [...document.querySelectorAll<HTMLElement>('button')].find((b) => b.textContent?.trim() === s)
const key = (el: Element, k: string, o: KeyboardEventInit = {}) => act(async () => { el.dispatchEvent(new KeyboardEvent('keydown', { key: k, bubbles: true, ...o })) })

describe('Super+V clipboard history', () => {
  it('lists pinned items first, pastes into the previous app, pins and deletes', async () => {
    const onClose = vi.fn()
    await render(<Flyout tab="clipboard" previous="w1a" onClose={onClose} />)
    const items = [...document.querySelectorAll<HTMLElement>('[data-clip]')]
    expect(items.map((b) => b.getAttribute('aria-label'))).toEqual(['Pinned address, pinned', 'Quarterly report draft', '2 files'])
    expect(await audit()).toEqual([])
    await act(async () => { items[1].click() })
    expect(onClose).toHaveBeenCalled()
    expect(calls).toContain('paste 3 w1a')
    await act(async () => { byLabel('Pin')!.click() })
    expect(calls).toContain('pin 3 true')
  })

  it('works from the keyboard: arrows, Delete removes, Ctrl+P pins, Esc closes', async () => {
    clip = { ...clip, entries: [{ id: 5, kind: 'text', text: 'one', at: 0 }, { id: 6, kind: 'text', text: 'two', at: 0 }] }
    const onClose = vi.fn()
    await render(<Flyout tab="clipboard" previous="w1" onClose={onClose} />)
    const search = document.querySelector<HTMLInputElement>('input[type="search"]')!
    expect(document.activeElement).toBe(search)
    await key(search, 'ArrowDown')
    expect(document.activeElement?.getAttribute('aria-label')).toBe('one')
    await key(document.activeElement!, 'ArrowDown')
    expect(document.activeElement?.getAttribute('aria-label')).toBe('two')
    await key(document.activeElement!, 'p', { ctrlKey: true })
    expect(calls).toContain('pin 6 true')
    await key(document.activeElement!, 'Delete')
    expect(calls).toContain('remove 6')
    await key(document.body, 'Escape')
    expect(onClose).toHaveBeenCalled()
  })

  it('searches, says when history is off (and turns it on), and when the organization turned it off', async () => {
    clip = { enabled: true, entries: [{ id: 1, kind: 'text', text: 'apple pie', at: 0 }, { id: 2, kind: 'text', text: 'banana', at: 0 }] }
    await render(<Flyout tab="clipboard" previous="" onClose={() => {}} />)
    const search = document.querySelector<HTMLInputElement>('input[type="search"]')!
    await act(async () => { const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!; set.call(search, 'ban'); search.dispatchEvent(new Event('input', { bubbles: true })) })
    expect([...document.querySelectorAll('[data-clip]')].map((b) => b.getAttribute('aria-label'))).toEqual(['banana'])
    act(() => root?.unmount())
    await render(<Flyout tab="clipboard" previous="" onClose={() => {}} initial={{ enabled: false, entries: [] }} />)
    expect(document.body.textContent).toContain('Clipboard history is off')
    act(() => root?.unmount())
    await render(<Flyout tab="clipboard" previous="" onClose={() => {}} initial={{ enabled: false, entries: [], blocked: true }} />)
    expect(document.body.textContent).toContain('Your organization turned off clipboard history')
    expect(byText('Turn on')).toBeUndefined()
  })

  it('types emoji and symbols into the previous app, with search', async () => {
    const onClose = vi.fn()
    await render(<Flyout tab="emoji" previous="w9" onClose={onClose} />)
    expect(await audit()).toEqual([])
    const search = document.querySelector<HTMLInputElement>('input[type="search"]')!
    await act(async () => { const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!; set.call(search, 'coffee'); search.dispatchEvent(new Event('input', { bubbles: true })) })
    await key(search, 'Enter')
    expect(calls).toContain('type ☕ w9')
    act(() => root?.unmount())
    await render(<Flyout tab="symbols" previous="w9" onClose={() => {}} />)
    await act(async () => { byLabel('රු')!.click() })
    expect(calls).toContain('type රු w9')
  })

  it('is translated and mirrors in right-to-left', async () => {
    setLocale('si')
    document.dir = 'rtl'
    await render(<Flyout tab="clipboard" previous="" onClose={() => {}} />)
    expect(document.querySelector('[role="tab"][aria-selected="true"]')?.textContent).toBe('පසුරු පුවරුව')
    expect(document.querySelector('.end-1\\.5')).not.toBeNull()   // logical (start/end) placement
    expect(await audit()).toEqual([])
  })
})

describe('snipping overlay', () => {
  it('switches modes from its toolbar and cancels with Esc', async () => {
    const onCancel = vi.fn()
    await render(<Overlay open={{ id: 4, mode: 'rect', outputs: [] }} output="" frame={null} onCancel={onCancel} onDone={() => {}} />)
    const tb = document.querySelector('[role="toolbar"]')!
    expect([...tb.querySelectorAll('button[aria-pressed]')].map((b) => `${b.textContent}:${b.getAttribute('aria-pressed')}`)).toEqual(['Rectangle:true', 'Window:false', 'Full screen:false', 'Freeform:false'])
    expect(await audit()).toEqual([])
    await act(async () => { byText('Window')!.click() })
    expect(document.getElementById('ws-snip-help')!.textContent).toBe('Click a window to snip it. Esc cancels.')
    await key(document.querySelector('[data-snip-overlay]')!, 'Escape')
    expect(onCancel).toHaveBeenCalledTimes(1)
  })

  it('without its own cancel handler asks the main process to close it', async () => {
    await render(<Overlay open={{ id: 9, mode: 'free', outputs: [] }} output="" frame={null} onDone={() => {}} />)
    await key(document.querySelector('[data-snip-overlay]')!, 'Escape')
    expect(calls).toEqual(['cancel 9'])
  })
})

describe('keyboard shortcut cheat sheet', () => {
  it('lists the system shortcuts by category with the person\'s changes, and searches', async () => {
    await render(<Help prefs={{ keys: { snip: 'W-S-x', notifications: '' }, custom: [{ id: 'c1', name: 'Calculator', key: 'W-k', app: 'calc' }] }} onClose={() => {}} onSettings={() => {}} />)
    expect([...document.querySelectorAll('h3')].map((h) => h.textContent)).toEqual(['System', 'Windows and desktops', 'Screenshots', 'Clipboard and editing', 'Accessibility', 'Apps'])
    const row = (label: string) => [...document.querySelectorAll('dt')].find((d) => d.textContent === label)?.nextElementSibling
    expect(row('Snip part of the screen')?.querySelector('[role="img"]')?.getAttribute('aria-label')).toBe('Super + Shift + X')
    expect(row('Open notifications')).toBeUndefined()
    expect(row('Calculator')?.textContent).toBe('SuperK')
    expect(await audit()).toEqual([])
    const search = document.querySelector<HTMLInputElement>('input[type="search"]')!
    await act(async () => { const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!; set.call(search, 'clipboard'); search.dispatchEvent(new Event('input', { bubbles: true })) })
    expect([...document.querySelectorAll('dt')].map((d) => d.textContent)).toEqual(['Open clipboard history'])
  })
})

describe('right-click menu in text fields', () => {
  it('offers Cut, Copy, Paste and Select all with their keys, and runs them in the field', async () => {
    await render(<><input aria-label="Name" defaultValue="hello world" /><input aria-label="Secret" type="password" defaultValue="pw" /><Menu /></>)
    const input = byLabel('Name') as HTMLInputElement
    input.setSelectionRange(0, 5)
    await act(async () => { input.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 10, clientY: 10 })) })
    const items = [...document.querySelectorAll('[role="menuitem"]')]
    expect(items.map((b) => b.textContent)).toEqual(['UndoCtrl+Z', 'RedoCtrl+Y', 'CutCtrl+X', 'CopyCtrl+C', 'PasteCtrl+V', 'DeleteDel', 'Select allCtrl+A'])
    expect(await audit()).toEqual([])
    expect(document.activeElement?.textContent).toBe('UndoCtrl+Z')
    await act(async () => { (items[3] as HTMLElement).click() })
    expect(calls).toEqual(['edit copy'])
    expect(document.querySelector('[role="menu"]')).toBeNull()
    // a password field: no cut or copy
    const secret = byLabel('Secret') as HTMLInputElement
    secret.setSelectionRange(0, 2)
    await key(secret, 'F10', { shiftKey: true })
    const dis = [...document.querySelectorAll('[role="menuitem"][aria-disabled="true"]')].map((b) => b.firstElementChild?.textContent)
    expect(dis).toEqual(expect.arrayContaining(['Cut', 'Copy']))
    await key(document.querySelector('[role="menu"]')!, 'Escape')
    expect(document.querySelector('[role="menu"]')).toBeNull()
    expect(document.activeElement).toBe(secret)
  })
})

describe('Settings › Clipboard', () => {
  it('turns history on and off, clears unpinned data, and explains where pins are kept', async () => {
    await render(<ClipPanel initial={{ enabled: true, persist: true, entries: [{ id: 1, kind: 'text', text: 'x', at: 0, pinned: true }, { id: 2, kind: 'text', text: 'y', at: 0 }] }} />)
    expect(document.querySelector('h1')!.textContent).toBe('Clipboard')
    expect(document.body.textContent).toContain('encrypted with a key in your login keyring')
    expect(await audit()).toEqual([])
    await act(async () => { byText('Clear')!.click() })
    expect(calls).toEqual(['clear unpinned'])
    await act(async () => { (document.querySelector('[role="switch"]') as HTMLElement).click() })
    expect(calls).toContain('enable false')
  })

  it('is locked when the organization turned it off', async () => {
    await render(<ClipPanel initial={{ enabled: false, entries: [], blocked: true }} />)
    expect(document.body.textContent).toContain('Your organization turned off clipboard history')
    expect((document.querySelector('[role="switch"]') as HTMLButtonElement).disabled).toBe(true)
  })
})

describe('Settings › Keyboard › Shortcuts', () => {
  it('lists the shortcuts, shows conflicts, and turns one off through the rc.xml writer', async () => {
    await render(<Shortcuts initial={{ keys: { snip: 'W-e' }, custom: [{ id: 'c1', name: 'Notes', key: 'W-k', command: 'foot' }] }} />)
    expect(document.querySelector('[role="alert"]')?.textContent).toContain('These keys do two things')
    expect(document.body.textContent).toContain('Also used by Open Files')
    expect(document.body.textContent).toContain('Runs foot')
    expect(await audit()).toEqual([])
    await act(async () => { byLabel('Turn off the shortcut for Open the AI assistant')!.click() })
    await act(async () => { await new Promise((r) => setTimeout(r, 0)) })
    expect(calls.find((c) => c.startsWith('apply'))).toBe('apply {"keys":{"snip":"W-e","ai":""},"custom":[{"id":"c1","name":"Notes","key":"W-k","command":"foot"}]}')
    expect(document.querySelector('[role="status"]')?.textContent).toBe('Shortcuts saved.')
  })

  it('records a new key combination and refuses one that is taken', async () => {
    await render(<Shortcuts initial={{}} />)
    await act(async () => { byLabel('Change the shortcut for Open clipboard history')!.click() })
    const box = document.querySelector<HTMLElement>('[role="dialog"] button[aria-labelledby]')!
    await act(async () => { box.focus() })
    await key(box, 'e', { metaKey: true, code: 'KeyE' } as KeyboardEventInit)
    expect(document.querySelector('[role="dialog"] [role="alert"]')?.textContent).toBe('Already used by Open Files.')
    expect((byText('Save') as HTMLButtonElement).disabled).toBe(true)
    await key(box, 'h', { metaKey: true, shiftKey: true, code: 'KeyH' } as KeyboardEventInit)
    expect(box.querySelector('[role="img"]')?.getAttribute('aria-label')).toBe('Super + Shift + H')
    expect(await audit(document.querySelector('[role="dialog"]')!)).toEqual([])
    await act(async () => { byText('Save')!.click() })
    await act(async () => { await new Promise((r) => setTimeout(r, 0)) })
    expect(calls.find((c) => c.startsWith('apply'))).toBe('apply {"keys":{"history":"S-W-h"}}')
  })

  it('sets "Print Screen opens snipping"', async () => {
    await render(<Shortcuts initial={{}} />)
    await act(async () => { byLabel('Use the Print Screen key to open screen snipping')!.click() })
    expect(calls).toContain('capture {"printOpensSnip":true}')
  })
})

describe('Snipping Tool', () => {
  it('offers New with mode and delay', async () => {
    const onNew = vi.fn()
    await render(<Tool onClose={() => {}} onNew={onNew} />)
    expect(await audit()).toEqual([])
    const delay = byLabel('Delay') as HTMLSelectElement
    await act(async () => { delay.value = '5'; delay.dispatchEvent(new Event('change', { bubbles: true })) })
    await act(async () => { byText('New')!.click() })
    expect(onNew).toHaveBeenCalledWith('rect', 5)
    expect([...delay.options].map((o) => o.textContent)).toEqual(['No delay', '3 seconds', '5 seconds', '10 seconds'])
  })
})

// @vitest-environment jsdom
// Task View, desktops, the taskbar's desktop filter and Settings › Multitasking (WSOS-DSK-003).
import { afterEach, describe, expect, it, vi } from 'vitest'
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { panel, type PanelWindow, type Workspaces } from '../lib/panel'
import TaskView, { DesktopToast, DesktopsFlyout } from './TaskView'
import { RunningApps } from './PanelItems'
import { MultitaskingPanel } from '../screens/settings/Multitasking'
import { desktopPrefsFrom, moved, savedList, setDesktopPrefs, taskbarWindows, wallpapersFor, DEFAULT_DESKTOP_PREFS } from '../lib/desktops'
import { shellPrefsFrom } from '../lib/shellPrefs'

const ws: Workspaces = { supported: true, dynamic: true, current: 1, count: 3, windows: { w1: 1, w2: 1, w3: 2, w4: 3 }, names: ['', 'Finance', ''], ids: ['d1', 'd2', 'd3'], sticky: [], stickyApps: [] }
const windows: PanelWindow[] = [
  { handle: 'w1', appId: 'firefox-esr', title: 'Web', output: '', flags: 1 },
  { handle: 'w2', appId: 'foot', title: 'Terminal', output: '', flags: 0 },
  { handle: 'w3', appId: 'office', title: 'Budget', output: '', flags: 0 },
  { handle: 'w4', appId: 'mail', title: 'Inbox', output: '', flags: 0 },
  { handle: 'ws', appId: 'worksuite-shell', title: 'WorkSuite', output: '', flags: 0 },
]
const info = (id: string) => ({ id, name: id, mark: id.slice(0, 2), bg: '#123', fg: '#fff' })
const ok = () => vi.fn().mockResolvedValue({ ok: true, value: true })

let root: ReturnType<typeof createRoot>, el: HTMLDivElement
function render(node: React.ReactNode) {
  el = document.createElement('div'); document.body.append(el)
  root = createRoot(el)
  return act(async () => root.render(node))
}
afterEach(() => { act(() => root.unmount()); el.remove(); vi.restoreAllMocks() })
const $$ = (sel: string) => [...document.querySelectorAll<HTMLElement>(sel)]
const key = (target: Element, k: string, extra: KeyboardEventInit = {}) => act(() => { target.dispatchEvent(new KeyboardEvent('keydown', { key: k, bubbles: true, cancelable: true, ...extra })) })
function dt() {
  const data: Record<string, string> = {}
  return { data, types: [] as string[], setData(k: string, v: string) { data[k] = v; this.types.push(k) }, getData: (k: string) => data[k] ?? '', effectAllowed: '' }
}
const drag = (target: Element, type: string, dataTransfer: unknown) => act(() => { const e = new Event(type, { bubbles: true, cancelable: true }); Object.assign(e, { dataTransfer }); target.dispatchEvent(e) })

function view(over: Partial<Workspaces> = {}, onClose = vi.fn()) {
  return render(<TaskView ws={{ ...ws, ...over }} windows={windows} info={info} wallpaper={() => '#000'} capture={null} onClose={onClose} onBackground={vi.fn()} />)
}

describe('Task View (WSOS-DSK-003)', () => {
  it('shows the current desktop’s windows, a card per desktop and New desktop; a click focuses the window', async () => {
    const activate = vi.spyOn(panel, 'activate').mockResolvedValue({ ok: true, value: true })
    const onClose = vi.fn()
    await view({}, onClose)
    expect($$('[data-window]').map((b) => b.dataset.window)).toEqual(['w1', 'w2'])   // never the shell's own window
    expect($$('[data-desktop]').map((b) => b.getAttribute('aria-label'))).toEqual([
      'Desktop 1, current desktop, 2 windows', 'Finance, 1 windows', 'Desktop 3, 1 windows', 'New desktop'])
    expect(document.activeElement).toBe($$('[data-window]')[0])
    act(() => $$('[data-window]')[1].click())
    expect(activate).toHaveBeenCalledWith('w2')
    expect(onClose).toHaveBeenCalledWith(true)
  })

  it('previews a desktop’s windows on hover and focus, and switches on click', async () => {
    panel.activateWorkspace = ok()
    await view()
    act(() => { $$('[data-desktop="2"]')[0].focus() })
    expect($$('[data-window]').map((b) => b.dataset.window)).toEqual(['w3'])
    act(() => $$('[data-desktop="2"]')[0].click())
    expect(panel.activateWorkspace).toHaveBeenCalledWith(2)
  })

  it('works from the keyboard: arrows, Esc, Alt+Shift+arrows to reorder, F2 to rename, Delete to close', async () => {
    panel.moveWorkspace = ok(); panel.renameWorkspace = ok(); panel.removeWorkspace = ok()
    const onClose = vi.fn()
    await view({}, onClose)
    key($$('[data-window]')[0], 'ArrowRight')
    expect(document.activeElement).toBe($$('[data-window]')[1])
    const d1 = $$('[data-desktop="1"]')[0]
    act(() => d1.focus())
    key(d1, 'ArrowRight')
    expect(document.activeElement).toBe($$('[data-desktop="2"]')[0])
    key(document.activeElement!, 'ArrowRight', { altKey: true, shiftKey: true })
    expect(panel.moveWorkspace).toHaveBeenCalledWith(2, 3)
    key(document.activeElement!, 'F2')
    const input = document.querySelector<HTMLInputElement>('input[aria-label="Desktop name"]')!
    expect(input.value).toBe('Finance')
    act(() => { Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, 'Money'); input.dispatchEvent(new Event('input', { bubbles: true })) })
    key(input, 'Enter')
    expect(panel.renameWorkspace).toHaveBeenCalledWith(2, 'Money')
    act(() => $$('[data-desktop="3"]')[0].focus())
    key($$('[data-desktop="3"]')[0], 'Delete')
    expect(panel.removeWorkspace).toHaveBeenCalledWith(3)
    key(document.body, 'Escape')
    expect(onClose).toHaveBeenCalledWith(false)
  })

  it('moves a window by dragging it onto a desktop card, or onto New desktop', async () => {
    panel.moveToWorkspace = ok(); panel.createWorkspace = ok()
    await view()
    const d = dt()
    drag($$('[data-window]')[0], 'dragstart', d)
    drag($$('[data-desktop="3"]')[0], 'dragover', d)
    drag($$('[data-desktop="3"]')[0], 'drop', d)
    expect(panel.moveToWorkspace).toHaveBeenCalledWith('w1', 3)
    const d2 = dt()
    drag($$('[data-window]')[1], 'dragstart', d2)
    await act(async () => { const e = new Event('drop', { bubbles: true, cancelable: true }); Object.assign(e, { dataTransfer: d2 }); $$('[data-desktop="0"]')[0].dispatchEvent(e) })
    expect(panel.createWorkspace).toHaveBeenCalled()
    expect(panel.moveToWorkspace).toHaveBeenLastCalledWith('w2', 4)
    // Dragging a desktop card onto another reorders.
    panel.moveWorkspace = ok()
    const d3 = dt()
    drag($$('[data-desktop="1"]')[0], 'dragstart', d3)
    drag($$('[data-desktop="3"]')[0], 'drop', d3)
    expect(panel.moveWorkspace).toHaveBeenCalledWith(1, 3)
  })

  it('moves a window with a plain pointer drag too (when the native drag never starts), but not after pointercancel', async () => {
    panel.moveToWorkspace = ok()
    await view()
    const card = $$('[data-desktop="3"]')[0]
    const orig = document.elementFromPoint
    document.elementFromPoint = (() => card) as typeof document.elementFromPoint
    try {
      const ptr = (target: EventTarget, type: string, x: number, y: number) => act(() => {
        const e = new MouseEvent(type, { bubbles: true, cancelable: true, clientX: x, clientY: y, button: 0 })
        target.dispatchEvent(e)
      })
      await ptr($$('[data-window]')[0], 'pointerdown', 10, 10)
      await ptr(window, 'pointermove', 200, 300)
      expect(card.className).toContain('border-[#18D4F0]')        // the desktop under the pointer lights up
      await ptr(window, 'pointerup', 200, 300)
      expect(panel.moveToWorkspace).toHaveBeenCalledWith('w1', 3)
      await ptr($$('[data-window]')[0], 'pointerdown', 10, 10)
      await ptr(window, 'pointermove', 200, 300)
      await ptr(window, 'pointercancel', 200, 300)               // the native drag took over: its drop moves it
      await ptr(window, 'pointerup', 200, 300)
      expect(panel.moveToWorkspace).toHaveBeenCalledTimes(1)
    } finally { document.elementFromPoint = orig }
  })

  it('desktop menu: rename, background, move left/right and close', async () => {
    panel.removeWorkspace = ok(); panel.moveWorkspace = ok()
    const onBackground = vi.fn()
    await render(<TaskView ws={ws} windows={windows} info={info} wallpaper={() => '#000'} capture={null} onClose={vi.fn()} onBackground={onBackground} />)
    act(() => { $$('[data-desktop="2"]')[0].dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true })) })
    const items = () => $$('[role=menu] [role=menuitem]')
    expect(items().map((b) => b.textContent)).toEqual(['Rename', 'Choose background', 'Move left', 'Move right', 'Close'])
    expect(document.activeElement).toBe(items()[0])
    act(() => items()[2].click())
    expect(panel.moveWorkspace).toHaveBeenCalledWith(2, 1)
    act(() => { $$('[data-desktop="2"]')[0].dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true })) })
    act(() => items()[1].click())
    act(() => (document.querySelector('[aria-label="Dusk"]') as HTMLElement).click())
    expect(onBackground).toHaveBeenCalledWith(2, 'dusk')
    act(() => { $$('[data-desktop="2"]')[0].dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true })) })
    act(() => items()[4].click())
    expect(panel.removeWorkspace).toHaveBeenCalledWith(2)
  })

  it('window menu: Move to, and show on all desktops', async () => {
    panel.moveToWorkspace = ok(); panel.setWindowOnAllDesktops = ok(); panel.setAppOnAllDesktops = ok()
    await view()
    const open = () => act(() => { $$('[data-window]')[0].dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true })) })
    open()
    expect($$('[role=menu] button').map((b) => b.textContent)).toEqual(['Finance', 'Desktop 3', 'New desktop', 'Show this window on all desktops', 'Show windows from this app on all desktops', 'Close'])
    act(() => $$('[role=menu] button')[1].click())
    expect(panel.moveToWorkspace).toHaveBeenCalledWith('w1', 3)
    open()
    act(() => $$('[role=menuitemcheckbox]')[0].click())
    expect(panel.setWindowOnAllDesktops).toHaveBeenCalledWith('w1', true)
    open()
    act(() => $$('[role=menuitemcheckbox]')[1].click())
    expect(panel.setAppOnAllDesktops).toHaveBeenCalledWith('firefox-esr', true)
  })

  it('has no New desktop or desktop menu where desktops are fixed, and none past 16', async () => {
    await view({ dynamic: false })
    expect($$('[data-desktop="0"]')).toEqual([])
    act(() => root.unmount()); el.remove()
    await view({ count: 16, names: [], windows: {} })
    expect($$('[data-desktop="0"]')).toEqual([])
  })

  it('the taskbar flyout lists desktops and switches; the toast names the new desktop', async () => {
    panel.activateWorkspace = ok()
    await render(<DesktopsFlyout ws={ws} windows={windows} info={info} wallpaper={() => '#000'} onLeave={vi.fn()} />)
    const cards = $$('[role=group] button')
    expect(cards.map((b) => b.getAttribute('aria-label'))).toEqual(['Desktop 1, current desktop, 2 windows', 'Finance, 1 windows', 'Desktop 3, 1 windows', 'New desktop'])
    act(() => cards[1].click())
    expect(panel.activateWorkspace).toHaveBeenCalledWith(2)
    act(() => root.unmount()); el.remove()
    await render(<DesktopToast ws={ws} />)
    expect(document.querySelector('[role=status]')).toBeNull()
    await act(async () => root.render(<DesktopToast ws={{ ...ws, current: 2 }} />))
    expect(document.querySelector('[role=status]')?.textContent).toContain('Switched to Finance')
  })
})

describe('taskbar and Alt+Tab scope (Settings › Multitasking)', () => {
  it('the taskbar shows the current desktop’s windows (and ones on all desktops), or every desktop’s', async () => {
    expect(taskbarWindows(windows, ws, 'current').map((w) => w.handle)).toEqual(['w1', 'w2', 'ws'])
    expect(taskbarWindows(windows, { ...ws, sticky: ['w4'] }, 'current').map((w) => w.handle)).toEqual(['w1', 'w2', 'w4', 'ws'])
    expect(taskbarWindows(windows, ws, 'all')).toHaveLength(5)
    vi.spyOn(panel, 'workspaces').mockResolvedValue(ws)
    vi.spyOn(panel, 'windows').mockResolvedValue(windows)
    await render(<RunningApps pinned={[]} info={() => undefined} onLaunch={() => undefined} scope="all" />)
    expect($$('[role=toolbar] > button').map((b) => b.getAttribute('title'))).toEqual(['Web', 'Terminal', 'Budget', 'Inbox'])
  })

  it('the taskbar menu moves a window and shows it on all desktops', async () => {
    vi.spyOn(panel, 'workspaces').mockResolvedValue(ws)
    vi.spyOn(panel, 'windows').mockResolvedValue(windows)
    panel.moveToWorkspace = ok(); panel.setWindowOnAllDesktops = ok()
    await render(<RunningApps pinned={[]} info={() => undefined} onLaunch={() => undefined} />)
    const apps = $$('[role=toolbar] > button')
    act(() => { apps[0].dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true })) })
    expect($$('[role=menuitem]').map((b) => b.textContent)).toEqual(['Finance', 'Desktop 3', 'New desktop'])
    act(() => $$('[role=menuitem]')[1].click())
    expect(panel.moveToWorkspace).toHaveBeenCalledWith('w1', 3)
    act(() => { apps[0].dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true })) })
    act(() => $$('[role=menuitemcheckbox]')[0].click())
    expect(panel.setWindowOnAllDesktops).toHaveBeenCalledWith('w1', true)
  })

  it('Settings › Multitasking saves the Task View button and both scopes; Alt+Tab goes to Labwc', async () => {
    vi.spyOn(panel, 'workspaces').mockResolvedValue(ws)
    panel.setSwitcherAllDesktops = ok()
    setDesktopPrefs(DEFAULT_DESKTOP_PREFS)
    let stored: unknown = { taskbarAlign: 'left' }
    const sync = { shellPrefs: vi.fn(async () => ({ ok: true, value: stored })), setShellPrefs: vi.fn(async (p: unknown) => { stored = p }) }
    await render(<MultitaskingPanel sync={sync} />)
    const [taskbar, altTab] = $$('select') as HTMLSelectElement[]
    expect([taskbar.value, altTab.value]).toEqual(['current', 'current'])
    expect(document.body.textContent).toContain('3 of 16 desktops')
    await act(async () => { taskbar.value = 'all'; taskbar.dispatchEvent(new Event('change', { bubbles: true })) })
    await act(async () => { altTab.value = 'all'; altTab.dispatchEvent(new Event('change', { bubbles: true })) })
    expect(panel.setSwitcherAllDesktops).toHaveBeenCalledWith(true)
    await act(async () => { ($$('[role=switch]')[0] as HTMLElement).click() })
    const saved = shellPrefsFrom(stored).desktops!
    expect(saved).toMatchObject({ taskbar: 'all', altTab: 'all', taskViewButton: false })
    expect(shellPrefsFrom(stored).taskbarAlign).toBe('left')   // the rest of the preferences stay
  })
})

describe('desktops preferences (synced, restored at sign-in)', () => {
  it('validates what comes from the sync store', () => {
    expect(desktopPrefsFrom(null)).toBeUndefined()
    const p = desktopPrefsFrom({ list: [{ name: '  Work\u0007 ', wallpaper: 'dusk' }, { name: 'x'.repeat(80), wallpaper: '../evil' }, ...Array(20).fill({})], stickyApps: ['foot', 'bad id;'], taskbar: 'all', altTab: 'weird', taskViewButton: 0 })!
    expect(p.list).toHaveLength(16)
    expect(p.list[0]).toEqual({ name: 'Work', wallpaper: 'dusk' })
    expect(p.list[1]).toEqual({ name: 'x'.repeat(40), wallpaper: '' })
    expect(p.stickyApps).toEqual(['foot'])
    expect([p.taskbar, p.altTab, p.taskViewButton]).toEqual(['all', 'current', true])
  })

  it('keeps wallpapers with their desktop through moves (by the bridge’s ids)', () => {
    const wps = { d2: 'teal' }
    expect(savedList(ws, wps)).toEqual([{ name: '', wallpaper: '' }, { name: 'Finance', wallpaper: 'teal' }, { name: '', wallpaper: '' }])
    const after = { ...ws, names: moved(ws.names!, 2, 1), ids: moved(ws.ids!, 2, 1) }
    expect(savedList(after, wps)[0]).toEqual({ name: 'Finance', wallpaper: 'teal' })
    expect(wallpapersFor({ ...ws, ids: ['a', 'b', 'c'] }, savedList(ws, wps))).toEqual({ b: 'teal' })
  })
})

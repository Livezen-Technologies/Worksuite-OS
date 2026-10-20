// @vitest-environment jsdom
// Desktop right-click menu and the Desktop folder on the wallpaper (#27).
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { DesktopIcons, DesktopMenu, createOnDesktop, type DesktopFolder } from './DesktopIcons'
import { DEFAULT_DESK_VIEW, loadDeskView, saveDeskView, sortDesk, uniqueName } from '../lib/desktopIcons'
import { os, type FileEntry } from '../lib/os'

const g = globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }
beforeAll(() => { g.IS_REACT_ACT_ENVIRONMENT = true })
let root: Root | null = null
let host: HTMLDivElement | null = null
afterEach(() => { act(() => root?.unmount()); host?.remove(); document.body.innerHTML = ''; root = null; host = null; vi.restoreAllMocks() })
const render = (el: React.ReactElement) => { host = document.createElement('div'); document.body.append(host); root = createRoot(host); act(() => root!.render(el)); return host }

const f = (name: string, dir = false, size = 0, modified = 0): FileEntry => ({ name, dir, size, modified, state: 'local', local: true })
const folder = (entries: FileEntry[]): DesktopFolder => ({ rel: 'Desktop', entries, error: null, reload: async () => {} })

describe('desktop items model', () => {
  it('sorts folders first, then by name, date, type or size; hides dot files', () => {
    const es = [f('b.txt', false, 5, 3), f('A folder', true), f('a.pdf', false, 9, 1), f('.hidden'), f('c.docx', false, 1, 2)]
    expect(sortDesk(es, 'name').map((e) => e.name)).toEqual(['A folder', 'a.pdf', 'b.txt', 'c.docx'])
    expect(sortDesk(es, 'modified').map((e) => e.name)).toEqual(['A folder', 'b.txt', 'c.docx', 'a.pdf'])
    expect(sortDesk(es, 'type').map((e) => e.name)).toEqual(['A folder', 'c.docx', 'a.pdf', 'b.txt'])
    expect(sortDesk(es, 'size').map((e) => e.name)).toEqual(['A folder', 'a.pdf', 'b.txt', 'c.docx'])
  })
  it('picks free names', () => {
    expect(uniqueName(['x'], 'New folder')).toBe('New folder')
    expect(uniqueName(['New folder', 'new folder (2)'], 'New folder')).toBe('New folder (3)')
    expect(uniqueName(['New text document.txt'], 'New text document.txt')).toBe('New text document (2).txt')
  })
  it('keeps the view per computer and ignores bad stored values', () => {
    const m = new Map<string, string>()
    const store = { getItem: (k: string) => m.get(k) ?? null, setItem: (k: string, v: string) => { m.set(k, v) } }
    saveDeskView({ show: false, size: 'large', sort: 'size' }, store)
    expect(loadDeskView(store)).toEqual({ show: false, size: 'large', sort: 'size' })
    m.set('ws.desktopView', '{"size":"huge","sort":"x"}')
    expect(loadDeskView(store)).toEqual(DEFAULT_DESK_VIEW)
  })
  it('creates the folder or file in the Desktop folder with a free name', async () => {
    const mk = vi.spyOn(os, 'filesMkdir').mockResolvedValue({ ok: true, value: 'Desktop/New folder (2)' })
    const nf = vi.fn(async () => ({ ok: true as const, value: '' }))
    ;(os as { filesNewFile?: unknown }).filesNewFile = nf
    const names = { folder: 'New folder', text: 'New text document' }
    expect(await createOnDesktop(folder([f('New folder', true)]), { folder: true }, names)).toEqual({ ok: true, name: 'New folder (2)' })
    expect(mk).toHaveBeenCalledWith('home', 'Desktop', 'New folder (2)')
    await createOnDesktop(folder([]), { template: null }, names)
    await createOnDesktop(folder([]), { template: 'Letter.odt' }, names)
    expect(nf.mock.calls).toEqual([['home', 'Desktop', 'New text document.txt', null], ['home', 'Desktop', 'Letter.odt', 'Letter.odt']])
    expect(await createOnDesktop({ ...folder([]), rel: null }, { folder: true }, names)).toMatchObject({ ok: false, error: 'unavailable' })
    delete (os as { filesNewFile?: unknown }).filesNewFile
  })
})

describe('<DesktopMenu>', () => {
  const props = () => ({
    x: 10, y: 10, view: DEFAULT_DESK_VIEW, onView: vi.fn(), templates: ['Letter.odt'], canCreate: true,
    onRefresh: vi.fn(), onNewFolder: vi.fn(), onNewFile: vi.fn(), onWallpaper: vi.fn(), onDisplay: vi.fn(), onPersonalize: vi.fn(), onClose: vi.fn(),
  })
  const btn = (el: HTMLElement, name: string) => [...el.querySelectorAll<HTMLButtonElement>('button')].find((b) => b.textContent?.includes(name))!

  it('has the expected entries and runs them', () => {
    const p = props()
    const el = render(<DesktopMenu {...p} />)
    for (const n of ['View', 'Sort by', 'Refresh', 'New', 'Change wallpaper', 'Display settings', 'Personalize']) expect(btn(el, n), n).toBeTruthy()
    act(() => btn(el, 'Refresh').click()); expect(p.onRefresh).toHaveBeenCalled(); expect(p.onClose).toHaveBeenCalled()
    act(() => btn(el, 'Change wallpaper').click()); expect(p.onWallpaper).toHaveBeenCalled()
    act(() => btn(el, 'Display settings').click()); expect(p.onDisplay).toHaveBeenCalled()
    act(() => btn(el, 'Personalize').click()); expect(p.onPersonalize).toHaveBeenCalled()
    act(() => btn(el, 'New').click())
    act(() => btn(el, 'Folder').click()); expect(p.onNewFolder).toHaveBeenCalled()
    act(() => btn(el, 'Text document').click()); expect(p.onNewFile).toHaveBeenCalledWith(null)
    act(() => btn(el, 'Letter').click()); expect(p.onNewFile).toHaveBeenCalledWith('Letter.odt')
    act(() => btn(el, 'Sort by').click())
    act(() => btn(el, 'Date modified').click()); expect(p.onView).toHaveBeenCalledWith({ ...DEFAULT_DESK_VIEW, sort: 'modified' })
    act(() => btn(el, 'View').click())
    act(() => btn(el, 'Large icons').click()); expect(p.onView).toHaveBeenCalledWith({ ...DEFAULT_DESK_VIEW, size: 'large' })
    act(() => btn(el, 'Show desktop icons').click()); expect(p.onView).toHaveBeenCalledWith({ ...DEFAULT_DESK_VIEW, show: false })
  })

  it('closes on Escape and on a click outside, not on a click inside', () => {
    const p = props()
    const el = render(<DesktopMenu {...p} />)
    expect(document.activeElement?.getAttribute('role')).toBe('menuitem')
    act(() => { el.querySelector('#ws-wall-menu')!.dispatchEvent(new MouseEvent('mousedown', { bubbles: true })) })
    expect(p.onClose).not.toHaveBeenCalled()
    act(() => { document.body.dispatchEvent(new MouseEvent('mousedown', { bubbles: true })) })
    expect(p.onClose).toHaveBeenCalledTimes(1)
    act(() => { document.activeElement!.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })) })
    expect(p.onClose).toHaveBeenCalledTimes(2)
  })
})

describe('<DesktopIcons>', () => {
  it('shows the Desktop folder, selects on click and opens on double-click or Enter', () => {
    const open = vi.fn(), select = vi.fn()
    const el = render(<DesktopIcons folder={folder([f('b.txt'), f('Projects', true)])} view={DEFAULT_DESK_VIEW} selected={null} onSelect={select} onOpen={open} />)
    const items = [...el.querySelectorAll<HTMLButtonElement>('[data-desk-item]')]
    expect(items.map((i) => i.dataset.deskItem)).toEqual(['Projects', 'b.txt'])
    act(() => items[1].click()); expect(select).toHaveBeenCalledWith('b.txt')
    act(() => { items[1].dispatchEvent(new MouseEvent('dblclick', { bubbles: true })) }); expect(open).toHaveBeenCalledTimes(1)
    act(() => { items[0].dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true })) }); expect(open.mock.calls[1][0].name).toBe('Projects')
  })
  it('hides when "Show desktop icons" is off', () => {
    const el = render(<DesktopIcons folder={folder([f('a')])} view={{ ...DEFAULT_DESK_VIEW, show: false }} selected={null} onSelect={() => {}} onOpen={() => {}} />)
    expect(el.querySelector('[data-desk-item]')).toBeNull()
  })
})

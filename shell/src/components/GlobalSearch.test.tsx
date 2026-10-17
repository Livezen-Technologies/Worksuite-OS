// @vitest-environment jsdom
// Global search (GlobalSearch.dc.html board): grouping, categories and keyboard navigation over bridge results.
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import GlobalSearch from './GlobalSearch'
import { os } from '../lib/os'
import { buildGroups, categories, coverage, navigate } from '../lib/globalSearch'
import type { SearchHit } from '../../electron/search'
import type { LauncherApp } from '../lib/launcher'

const g = globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }
beforeAll(() => { g.IS_REACT_ACT_ENVIRONMENT = true })
let root: Root | null = null
let host: HTMLDivElement | null = null
afterEach(() => { act(() => root?.unmount()); host?.remove(); root = null; host = null; vi.restoreAllMocks() })

const hit = (id: string, type: string, title: string, score = 0.5): SearchHit =>
  ({ id, source: type === 'file' ? 'drive' : 'worksuite', type, title, subtitle: 'sub', icon: type === 'file' ? 'file' : 'mail', link: `worksuite://x/${id}`, score, ext: 'xlsx' }) as SearchHit
const app: LauncherApp = { id: 'budget', name: 'Budget Planner', mark: 'B', bg: '#fff', fg: '#000', kind: 'Linux app', launch: { desktop: 'budget' }, keywords: [] }

describe('global search model', () => {
  it('groups in board order with the "Search in WorkSuite" row last', () => {
    const gs = buildGroups({ apps: [app], settings: [{ label: 'Power', section: 'Power' }], local: [], hits: [hit('f', 'file', 'B.xlsx'), hit('m', 'mail', 'Budget'), hit('c', 'contact', 'Buddhika')], query: 'bu' }, true)
    expect(gs.map((x) => x.id)).toEqual(['apps', 'settings', 'mail', 'contact', 'files', 'record'])
    expect(gs.at(-1)!.items[0].kind).toBe('more')
    expect(categories(gs)).toEqual([{ id: 'all', n: 5 }, { id: 'apps', n: 1 }, { id: 'settings', n: 1 }, { id: 'mail', n: 1 }, { id: 'contact', n: 1 }, { id: 'files', n: 1 }])
    expect(buildGroups({ apps: [], settings: [], local: [], hits: [], query: 'x' }, false)).toEqual([])
  })

  it('"Ask AI" closes the list when the assistant is there, and is not counted as a result', () => {
    const gs = buildGroups({ apps: [app], settings: [], local: [], hits: [], query: 'what is a gguf' }, false, true)
    expect(gs.at(-1)).toEqual({ id: 'ai', items: [{ kind: 'ai', id: 'ai' }] })
    expect(categories(gs)).toEqual([{ id: 'all', n: 1 }, { id: 'apps', n: 1 }])
    expect(buildGroups({ apps: [], settings: [], local: [], hits: [], query: ' ' }, false, true)).toEqual([])
  })

  it('navigates with wrapping arrows, Home/End and Tab between categories', () => {
    const cats = ['all', 'apps', 'mail'] as const
    let s = { sel: 0, cat: 'all' as (typeof cats)[number] }
    s = navigate(s, 'ArrowUp', 3, [...cats]) as typeof s; expect(s.sel).toBe(2)
    s = navigate(s, 'ArrowDown', 3, [...cats]) as typeof s; expect(s.sel).toBe(0)
    s = navigate(s, 'End', 3, [...cats]) as typeof s; expect(s.sel).toBe(2)
    s = navigate(s, 'Tab', 3, [...cats]) as typeof s; expect(s).toEqual({ sel: 0, cat: 'apps' })
    s = navigate(s, 'ShiftTab', 3, [...cats]) as typeof s; expect(s.cat).toBe('all')
    s = navigate(s, 'ShiftTab', 3, [...cats]) as typeof s; expect(s.cat).toBe('mail')
  })

  it('states coverage from the sources', () => {
    expect(coverage([{ source: 'worksuite', state: 'ok', hits: [] }, { source: 'drive', state: 'ok', hits: [] }], false)).toBe('search.status.all')
    expect(coverage([{ source: 'worksuite', state: 'not_signed_in', hits: [] }], false)).toBe('search.status.signedOut')
    expect(coverage(null, true)).toBe('search.status.searching')
  })
})

describe('<GlobalSearch>', () => {
  async function render(results: SearchHit[], props: Partial<React.ComponentProps<typeof GlobalSearch>> = {}) {
    vi.spyOn(os, 'search').mockResolvedValue({ query: 'bu', sources: [{ source: 'worksuite', state: 'ok', hits: [] }, { source: 'drive', state: 'ok', hits: [] }], hits: results })
    vi.spyOn(os, 'recentFiles').mockResolvedValue({ local: [], cloud: { state: 'ok', hits: [] } })
    const open = vi.spyOn(os, 'openSearchResult').mockResolvedValue({ ok: true })
    const p = { query: 'bu', onQuery: vi.fn(), apps: [app], settings: [], onLaunchApp: vi.fn(), onOpenSettings: vi.fn(), onClose: vi.fn(), ...props }
    host = document.createElement('div'); document.body.append(host); root = createRoot(host)
    await act(async () => { root!.render(<GlobalSearch {...p} />) })
    await act(async () => { await Promise.resolve() })
    return { p, open }
  }
  const input = () => document.querySelector<HTMLInputElement>('input[role="combobox"]')!
  const key = async (k: string, o: KeyboardEventInit = {}) => { await act(async () => { input().dispatchEvent(new KeyboardEvent('keydown', { key: k, bubbles: true, ...o })) }) }
  const selected = () => document.querySelector('[role="option"][aria-selected="true"]')?.textContent ?? ''

  it('shows grouped results and moves the selection with the keyboard', async () => {
    const { p, open } = await render([hit('m', 'mail', 'Budget review', 0.9), hit('f', 'file', 'Budget.xlsx')])
    expect([...document.querySelectorAll('[role="group"]')].map((x) => x.getAttribute('aria-label'))).toEqual(['Apps', 'Mail', 'Files', 'More results'])
    expect(selected()).toContain('Budget Planner')
    await key('ArrowDown')
    expect(selected()).toContain('Budget review')
    expect(input().getAttribute('aria-activedescendant')).toBe('ws-sr-1')
    await key('Enter')
    expect(open).toHaveBeenCalledWith('worksuite://x/m', 'open')
    expect(p.onClose).toHaveBeenCalled()
    await key('ArrowDown'); await key('Enter', { ctrlKey: true })
    expect(open).toHaveBeenLastCalledWith('worksuite://x/f', 'location')
    await key('ArrowDown'); await key('Enter')
    expect(open).toHaveBeenLastCalledWith('worksuite://search?q=bu')
  })

  it('switches category with Tab and launches apps', async () => {
    const { p } = await render([hit('m', 'mail', 'Budget review')])
    await key('Tab')
    expect(document.querySelector('[role="tab"][aria-selected="true"]')!.textContent).toContain('Apps')
    expect(document.querySelectorAll('[role="option"]').length).toBe(1)
    await key('Enter')
    expect(p.onLaunchApp).toHaveBeenCalledWith('budget')
  })

  it('says when WorkSuite cannot be searched', async () => {
    vi.spyOn(os, 'search').mockResolvedValue({ query: 'zz', sources: [{ source: 'worksuite', state: 'not_signed_in', hits: [] }, { source: 'drive', state: 'not_signed_in', hits: [] }], hits: [] })
    vi.spyOn(os, 'recentFiles').mockResolvedValue({ local: [], cloud: { state: 'not_signed_in', hits: [] } })
    host = document.createElement('div'); document.body.append(host); root = createRoot(host)
    await act(async () => { root!.render(<GlobalSearch query="zz" onQuery={() => {}} apps={[]} settings={[]} onLaunchApp={() => {}} onOpenSettings={() => {}} onClose={() => {}} />) })
    await act(async () => { await Promise.resolve() })
    expect(host.textContent).toContain('WorkSuite: not signed in')
    expect(host.textContent).toContain('No results for "zz"')
    expect(host.textContent).toContain('not signed in to WorkSuite')
  })
})

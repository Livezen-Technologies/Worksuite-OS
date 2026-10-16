// @vitest-environment jsdom
// Desktop widgets on the wallpaper: each widget's loading, empty, error and offline states, the signed-out card,
// absent modules, opening items through the worksuite:// launch path, editing and the picker, and escaped content.
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import DesktopWidgets, { useWidgetData } from './DesktopWidgets'
import { os } from '../lib/os'
import { DEFAULT_LAYOUT, WIDGETS, type WidgetLayout } from '../lib/widgets'
import { emptySnapshot, type WidgetsSnapshot } from '../../electron/widgets'

const g = globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }
beforeAll(() => { g.IS_REACT_ACT_ENVIRONMENT = true })
let root: Root | null = null
let host: HTMLDivElement | null = null
afterEach(() => { act(() => root?.unmount()); host?.remove(); root = null; host = null; vi.restoreAllMocks() })

const NOW = new Date(2026, 9, 16, 10, 30)
const ALL: WidgetLayout = { ...DEFAULT_LAYOUT, hidden: [] }

function full(): WidgetsSnapshot {
  return {
    state: 'ok', fetchedAt: NOW.getTime(), cached: false, today: '2026-10-16',
    tasks: { state: 'ok', data: [
      { id: '1', title: 'Send invoice', due: '2026-10-16', dueAt: null, priority: 'high', status: 'todo', link: 'worksuite://tasks/1' },
      { id: '2', title: 'File VAT return', due: '2026-10-14', dueAt: null, priority: 'none', status: 'todo', link: 'worksuite://tasks/2' },
    ] },
    events: { state: 'ok', data: [{ id: 'm1', title: 'Design review', start: '2026-10-16T14:00:00', end: '2026-10-16T15:00:00', allDay: false, location: 'Room 2', meeting: true, color: '#7A4FE0', link: 'worksuite://calendar' }] },
    announcements: { state: 'ok', data: [{ id: '3', title: '<img src=x onerror=alert(1)>', preview: '<script>alert(1)</script>', priority: 'urgent', pinned: false, read: false, at: null, expires: null, link: 'worksuite://home' }] },
    approvals: { state: 'ok', data: { count: 1, items: [{ id: '9', kind: 'leave', title: 'Annual leave', who: 'Kamal Perera', at: '2026-10-15T08:00:00Z', link: 'worksuite://hr/leave/9' }] } },
    dashboard: { state: 'ok', data: { unreadMail: 4, unreadChat: 150, notifications: 0, files: [{ id: '7', name: 'Budget.xlsx', ext: 'xlsx', size: 10, location: 'Finance', at: '2026-10-16T08:00:00', status: null, link: 'worksuite://files/7' }], activity: [{ id: '1', user: 'Nimal', text: 'updated the Q4 plan', module: 'crm', count: 2, at: null, link: 'worksuite://crm/leads/12' }] } },
    summary: { state: 'ok', data: { text: 'Three meetings today.', points: [{ text: 'Reply to Nimal', link: null }] } },
  }
}

function render(snap: WidgetsSnapshot | null, over: Partial<Parameters<typeof DesktopWidgets>[0]> = {}) {
  host = document.createElement('div'); document.body.appendChild(host); root = createRoot(host)
  const props = { snap, loading: false, online: true, layout: ALL, onLayout: vi.fn(), editing: false, onEditing: vi.fn(), picker: false, onPicker: vi.fn(), onRefresh: vi.fn(), onSignIn: vi.fn(), now: NOW, ...over }
  act(() => root!.render(<DesktopWidgets {...props} />))
  return { props, el: host }
}
const card = (el: HTMLElement, name: string) => el.querySelector<HTMLElement>(`article[aria-label="${name}"]`)
const button = (el: HTMLElement, name: string) => [...el.querySelectorAll('button')].find((b) => b.getAttribute('aria-label') === name || b.textContent?.trim() === name)

describe('desktop widgets', () => {
  it('shows nothing when disabled, a loading line, and one sign-in card when signed out', () => {
    expect(render(emptySnapshot('disabled', '2026-10-16')).el.textContent).toBe('')
    act(() => root!.unmount()); host!.remove()
    expect(render(null, { loading: true }).el.textContent).toContain('Loading…')
    act(() => root!.unmount()); host!.remove()
    const { el, props } = render(emptySnapshot('not_signed_in', '2026-10-16'))
    expect(el.textContent).toContain('Sign in to WorkSuite to see your widgets')
    expect(el.querySelectorAll('article')).toHaveLength(0)
    act(() => button(el, 'Sign in')!.click())
    expect(props.onSignIn).toHaveBeenCalled()
  })

  it('says offline with retry when there is nothing cached yet', () => {
    const { el, props } = render(emptySnapshot('offline', '2026-10-16'))
    expect(el.textContent).toContain('You’re offline')
    act(() => button(el, 'Retry')!.click())
    expect(props.onRefresh).toHaveBeenCalled()
  })

  it('renders every widget with its data, as text', () => {
    const { el } = render(full())
    expect([...el.querySelectorAll('article')].map((a) => a.getAttribute('aria-label'))).toEqual(['At a glance', 'Today’s work', 'Today’s agenda', 'Waiting for me', 'Announcements', 'Your daily brief', 'Recent activity', 'Recent files'])
    expect(card(el, 'At a glance')!.textContent).toMatch(/Due today1.*1 overdue.*Meetings today1.*Unread mail4.*Unread chats99\+/)
    expect(card(el, 'Today’s work')!.textContent).toMatch(/File VAT return.*Overdue.*Send invoice/)
    expect(card(el, 'Today’s agenda')!.textContent).toContain('Design review')
    expect(card(el, 'Waiting for me')!.textContent).toContain('Kamal Perera')
    expect(card(el, 'Recent files')!.textContent).toContain('Budget.xlsx')
    expect(card(el, 'Recent activity')!.textContent).toContain('Nimal updated the Q4 plan')
    expect(card(el, 'Your daily brief')!.textContent).toContain('Three meetings today.')
    // Server text is never markup.
    expect(el.querySelector('img, script')).toBeNull()
    expect(card(el, 'Announcements')!.textContent).toContain('<img src=x onerror=alert(1)>')
  })

  it('opens items and widget headers through the worksuite:// launch path', () => {
    const open = vi.spyOn(os, 'openSearchResult').mockResolvedValue({ ok: true })
    const { el } = render(full())
    act(() => [...card(el, 'Today’s work')!.querySelectorAll('button')].find((b) => b.textContent?.includes('Send invoice'))!.click())
    expect(open).toHaveBeenLastCalledWith('worksuite://tasks/1')
    act(() => button(card(el, 'Recent files')!, 'Recent files')!.click())
    expect(open).toHaveBeenLastCalledWith('worksuite://files')
    act(() => [...card(el, 'At a glance')!.querySelectorAll('button')].find((b) => b.textContent?.includes('Unread mail'))!.click())
    expect(open).toHaveBeenLastCalledWith('worksuite://mail')
  })

  it('gives each widget its empty and error states, and leaves out modules that are not enabled', () => {
    const s = full()
    s.tasks = { state: 'ok', data: [] }
    s.events = { state: 'ok', data: [] }
    s.approvals = { state: 'unavailable', data: null }
    s.announcements = { state: 'error', data: null }
    s.dashboard = { state: 'offline', data: null }
    s.summary = { state: 'ok', data: { text: null, points: [] } }
    const { el } = render(s)
    expect(card(el, 'Waiting for me')).toBeNull()
    expect(card(el, 'Today’s work')!.textContent).toContain('Nothing due today.')
    expect(card(el, 'Today’s agenda')!.textContent).toContain('Nothing scheduled today.')
    expect(card(el, 'Announcements')!.textContent).toContain('Couldn’t load this.')
    expect(card(el, 'Recent files')!.textContent).toContain('You’re offline')
    expect(card(el, 'Your daily brief')!.textContent).toContain('No brief for today yet.')
  })

  it('marks cached data as offline with when it was updated', () => {
    const { el } = render({ ...full(), cached: true }, { online: false })
    expect(el.querySelector('[role="status"]')!.textContent).toMatch(/^Offline · updated /)
  })

  it('edits: remove, move, resize, and add from the picker', () => {
    const onLayout = vi.fn()
    const { el } = render(full(), { editing: true, layout: DEFAULT_LAYOUT, onLayout })
    expect(button(el, 'Move At a glance up')!.disabled).toBe(true)
    act(() => button(el, 'Remove Today’s work')!.click())
    expect(onLayout.mock.calls.at(-1)![0].hidden).toContain('work')
    act(() => button(el, 'Move Today’s agenda up')!.click())
    expect(onLayout.mock.calls.at(-1)![0].order.indexOf('calendar')).toBeLessThan(onLayout.mock.calls.at(-1)![0].order.indexOf('work'))
    act(() => button(el, 'Make Waiting for me wide')!.click())
    expect(onLayout.mock.calls.at(-1)![0].wide).toEqual(['waiting'])
    act(() => root!.unmount()); host!.remove()
    const r = render(full(), { editing: true, picker: true, layout: DEFAULT_LAYOUT, onLayout })
    const picker = r.el.querySelector<HTMLElement>('[role="dialog"]')!
    expect([...picker.querySelectorAll('li')].map((li) => li.textContent)).toEqual(['Your daily briefA summary of your day', 'Recent activityWhat changed lately', 'Recent filesFiles you worked on lately'])
    act(() => [...picker.querySelectorAll('li button')][2]!.dispatchEvent(new MouseEvent('click', { bubbles: true })))
    expect(onLayout.mock.calls.at(-1)![0].hidden).not.toContain('files')
  })

  it('every control is a named button reachable by keyboard', () => {
    const { el } = render(full(), { editing: true })
    const unnamed = [...el.querySelectorAll('button')].filter((b) => !(b.getAttribute('aria-label') || b.textContent?.trim()))
    expect(unnamed).toEqual([])
    expect(el.querySelectorAll('[tabindex="-1"]')).toHaveLength(0)
    expect(WIDGETS.every((id) => el.querySelector(`[data-widget="${id}"]`))).toBe(true)
  })
})

describe('widget data refresh', () => {
  it('loads once, again on reconnect, and not at all when off', async () => {
    const load = vi.fn(async () => full())
    let seen: ReturnType<typeof useWidgetData> | null = null
    function Probe({ on }: { on: boolean }) { seen = useWidgetData(on, load); return null }
    host = document.createElement('div'); root = createRoot(host)
    await act(async () => root!.render(<Probe on={false} />))
    expect(load).not.toHaveBeenCalled()
    await act(async () => root!.render(<Probe on />))
    expect(load).toHaveBeenCalledTimes(1)
    expect(seen!.snap?.state).toBe('ok')
    await act(async () => { window.dispatchEvent(new Event('offline')) })
    expect(seen!.online).toBe(false)
    await act(async () => { window.dispatchEvent(new Event('online')) })
    expect(load).toHaveBeenCalledTimes(2)
    expect(seen!.online).toBe(true)
  })
})

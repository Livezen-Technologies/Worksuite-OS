// @vitest-environment jsdom
// Desktop widgets' layout (add, remove, move, resize, persistence) and what they count, as WorkSuite Desktop's Home.
import { afterEach, describe, expect, it } from 'vitest'
import { DEFAULT_LAYOUT, WIDGETS, add, agendaOf, available, loadLocalLayout, move, normaliseLayout, place, rankNotices, remove, resize, saveLocalLayout, shown, sizeOf, taskBuckets, widgetsAllowed } from './widgets'
import { shellPrefsFrom } from './shellPrefs'
import { emptySnapshot, type WEvent, type WNotice, type WTask } from '../../electron/widgets'

const task = (id: string, over: Partial<WTask> = {}): WTask => ({ id, title: id, due: null, dueAt: null, priority: 'none', status: 'todo', link: `worksuite://tasks/${id}`, ...over })
const ev = (id: string, start: string, over: Partial<WEvent> = {}): WEvent => ({ id, title: id, start, end: null, allDay: false, location: null, meeting: false, color: null, link: 'worksuite://calendar', ...over })
const notice = (id: string, over: Partial<WNotice> = {}): WNotice => ({ id, title: id, preview: null, priority: 'normal', pinned: false, read: false, at: null, expires: null, link: 'worksuite://home', ...over })

describe('widget layout', () => {
  it('starts with Desktop’s busiest cards and keeps every widget in the order', () => {
    expect(shown(DEFAULT_LAYOUT)).toEqual(['glance', 'work', 'calendar', 'waiting', 'announcements'])
    expect(DEFAULT_LAYOUT.order).toEqual(WIDGETS)
  })

  it('normalises untrusted saved layouts', () => {
    expect(normaliseLayout(null)).toEqual(DEFAULT_LAYOUT)
    const l = normaliseLayout({ order: ['files', 'evil', 'files', 7], hidden: ['glance', '<x>'], wide: ['calendar'] })
    expect(l.order[0]).toBe('files')
    expect(l.order).toHaveLength(WIDGETS.length)
    expect(l.hidden).toEqual(['glance'])
    expect(l.wide).toEqual(['calendar'])
  })

  it('adds, removes, moves, places and resizes', () => {
    let l = remove(DEFAULT_LAYOUT, 'work')
    expect(shown(l)).not.toContain('work')
    l = add(l, 'files')
    expect(shown(l).at(-1)).toBe('files')
    l = move(l, 'files', -1)
    expect(shown(l).slice(-2)).toEqual(['files', 'announcements'])
    expect(move(l, shown(l)[0], -1)).toBe(l)
    l = place(l, 'announcements', 'glance')
    expect(shown(l)[0]).toBe('announcements')
    l = resize(l, 'calendar', 'wide')
    expect(sizeOf(l, 'calendar')).toBe('wide')
    expect(sizeOf(resize(l, 'calendar', 'normal'), 'calendar')).toBe('normal')
  })

  it('is saved with the synced shell preferences, and locally as a fallback', () => {
    const l = resize(remove(DEFAULT_LAYOUT, 'glance'), 'work', 'wide')
    expect(shellPrefsFrom({ favorites: ['mail'], widgets: l })).toEqual({ favorites: ['mail'], widgets: l })
    expect(shellPrefsFrom({ widgets: 'bad' })).toEqual({})
    saveLocalLayout('kasun', l)
    expect(loadLocalLayout('kasun')).toEqual(l)
    expect(loadLocalLayout('nimal')).toBeNull()
  })
  afterEach(() => localStorage.clear())
})

describe('widget policy', () => {
  it('is on unless the org turns it off, and never on a kiosk', () => {
    expect(widgetsAllowed(null)).toBe(true)
    expect(widgetsAllowed({ desktop_widgets: null })).toBe(true)
    expect(widgetsAllowed({ desktop_widgets: false })).toBe(false)
    expect(widgetsAllowed({ desktop_widgets: true, kiosk: true })).toBe(false)
  })
})

describe('what the widgets count', () => {
  it('splits today’s work into overdue and due today, open tasks only', () => {
    const now = new Date('2026-10-16T10:00:00').getTime()
    const b = taskBuckets([task('a', { due: '2026-10-16' }), task('b', { due: '2026-10-14' }), task('c', { due: '2026-10-16', status: 'done' }), task('d', { dueAt: '2026-10-16T08:00:00' }), task('e', { due: '2026-10-20' })], '2026-10-16', now)
    expect(b.today.map((t) => t.id)).toEqual(['a'])
    expect(b.overdue.map((t) => t.id)).toEqual(['b', 'd'])
  })

  it('lays out today’s agenda with what is on now and the next meeting', () => {
    const a = agendaOf([ev('late', '2026-10-16T14:00:00', { meeting: true }), ev('on', '2026-10-16T10:00:00', { end: '2026-10-16T11:00:00' }), ev('past', '2026-10-16T08:00:00', { end: '2026-10-16T08:30:00', meeting: true }), ev('all', '2026-10-16', { allDay: true }), ev('tomorrow', '2026-10-17T09:00:00')], '2026-10-16', 10 * 60 + 30)
    expect(a.allDay.map((e) => e.id)).toEqual(['all'])
    expect(a.timed.map((r) => r.e.id)).toEqual(['past', 'on', 'late'])
    expect(a.timed.find((r) => r.e.id === 'on')?.live).toBe(true)
    expect(a.meetings).toBe(2)
    expect(a.next?.e.id).toBe('late')
  })

  it('ranks announcements as Desktop does and drops expired ones', () => {
    const now = Date.parse('2026-10-16T10:00:00Z')
    const r = rankNotices([notice('plain', { at: '2026-10-15' }), notice('pin', { pinned: true }), notice('urgent', { priority: 'urgent' }), notice('old', { expires: '2026-10-01 00:00:00' }), notice('imp', { priority: 'important' })], now)
    expect(r.map((n) => n.id)).toEqual(['urgent', 'pin', 'imp', 'plain'])
  })

  it('leaves out a widget whose module is not enabled', () => {
    const s = emptySnapshot('ok', '2026-10-16')
    s.approvals = { state: 'unavailable', data: null }
    expect(available(s)).toMatchObject({ waiting: false, work: true, glance: true })
  })
})

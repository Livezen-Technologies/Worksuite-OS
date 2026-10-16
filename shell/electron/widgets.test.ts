// Desktop widgets' data path (main process): the broker token, the platform endpoints WorkSuite Desktop's Home reads,
// strict parsing of server data, per-source states, the per-account offline cache and the policy switch.
import { describe, expect, it } from 'vitest'
import { createWidgets, fromCache, linkOf, parseAnnouncements, parseApprovals, parseDashboard, parseEvents, parseSummary, parseTasks, type WidgetsCache, type WidgetsFetch, type WidgetsSnapshot } from './widgets'

const NOW = new Date(2026, 9, 16, 10, 30)
const BODIES: Record<string, unknown> = {
  '/api/dashboard/home': { data: { stats: { unread_mail: 4, unread_chats: 120, notifications_unread: 2 }, recent_files: [{ id: 7, name: 'Budget.xlsx', extension: 'xlsx', size: 1200, location: 'Finance', at: '2026-10-16T08:00:00Z' }, { id: 8, name: '~$Budget.xlsx', extension: 'xlsx' }], activity: [{ id: 1, description: 'updated the Q4 plan', user: 'Nimal', at: '2026-10-16T09:00:00Z', link: '/crm/leads/12', count: 3 }, { id: 2, description: 'upload part 3 of 9', user: 'x' }] } },
  '/api/dashboard/summary': { data: { total: 3, digest: { text: 'Three meetings today.', reason: null, points: [{ text: 'Reply to Nimal', link: 'javascript:alert(1)' }] } } },
  '/api/tasks': { data: { tasks: [{ id: 1, title: 'Send invoice', status: 'todo', priority: 'high', due_date: '2026-10-16', due_at: null }, { id: 2, title: 'Old', status: 'done', due_date: '2026-10-01' }] } },
  '/api/calendar/events': { data: { events: [{ source: 'meeting', id: 'm:5', title: 'Standup', start_at: '2026-10-16T11:00:00', end_at: '2026-10-16T11:15:00', all_day: false, color: '#1F6BFF' }] } },
  '/api/hr/announcements/mine': { data: { items: [{ id: 3, title: 'Office closed Friday', priority: 'urgent', pinned: false, read: false, preview: '<b>bold</b>', published_at: '2026-10-15T08:00:00Z', expires_at: null }] } },
  '/api/hr/approvals/pending': { data: { count: 2, items: [{ id: 9, kind: 'leave', title: 'Annual leave — Kamal', at: '2026-10-15T08:00:00Z' }] } },
}

function world(o: { status?: number | ((path: string) => number); throws?: boolean; accounts?: unknown; token?: { ok: boolean; value?: unknown; error?: string }; enabled?: boolean } = {}) {
  const calls: { url: string; headers?: Record<string, string> }[] = []
  const store = new Map<string, WidgetsSnapshot>()
  let cleared = 0
  const cache: WidgetsCache = { read: (id) => (store.has(id) ? JSON.parse(JSON.stringify(store.get(id))) : null), write: (id, s) => { store.set(id, s) }, clear: () => { cleared++; store.clear() } }
  const fetch: WidgetsFetch = async (url, init) => {
    calls.push({ url, headers: init.headers })
    if (o.throws) throw new Error('offline')
    const path = new URL(url).pathname
    const status = typeof o.status === 'function' ? o.status(path) : o.status ?? 200
    return { ok: status < 400, status, json: async () => BODIES[path] }
  }
  let accounts: unknown = o.accounts ?? [{ id: 'acc-1', server_url: 'https://work.example.com', state: 'signed_in' }]
  const broker = async (m: string) => (m === 'Status' ? { ok: true as const, value: accounts as {} } : (o.token as { ok: true; value: unknown }) ?? { ok: true as const, value: 'tok-secret' })
  const w = createWidgets({ broker, fetch, cache, device: () => 'dev-cred', enabled: () => o.enabled ?? true, now: () => NOW })
  return { w, calls, store, cleared: () => cleared, setAccounts: (a: unknown) => { accounts = a } }
}

describe('desktop widgets data (main process)', () => {
  it('reads the same endpoints as Desktop Home with the broker token and device credential', async () => {
    const { w, calls } = world()
    const s = await w.load()
    expect(s.state).toBe('ok')
    expect(calls.map((c) => c.url).sort()).toEqual([
      'https://work.example.com/api/calendar/events?from=2026-10-16&to=2026-10-16', 'https://work.example.com/api/dashboard/home', 'https://work.example.com/api/dashboard/summary',
      'https://work.example.com/api/hr/announcements/mine', 'https://work.example.com/api/hr/approvals/pending', 'https://work.example.com/api/tasks',
    ])
    expect(calls.every((c) => c.headers?.authorization === 'Bearer tok-secret' && c.headers['x-ws-device'] === 'dev-cred')).toBe(true)
    // The token is used for requests only: the renderer's answer never carries it.
    expect(JSON.stringify(s)).not.toContain('tok-secret')
    expect(s.tasks.data?.map((t) => t.title)).toEqual(['Send invoice', 'Old'])
    expect(s.tasks.data?.[0].link).toBe('worksuite://tasks/1')
    expect(s.dashboard.data).toMatchObject({ unreadMail: 4, unreadChat: 120 })
    expect(s.dashboard.data?.files.map((f) => f.name)).toEqual(['Budget.xlsx'])
    expect(s.dashboard.data?.activity.map((a) => a.text)).toEqual(['updated the Q4 plan'])
    expect(s.dashboard.data?.activity[0].link).toBe('worksuite://crm/leads/12')
    expect(s.approvals.data).toMatchObject({ count: 2, items: [{ link: 'worksuite://hr/leave/9' }] })
    expect(s.summary.data?.points[0]).toEqual({ text: 'Reply to Nimal', link: null })
    expect(s.announcements.data?.[0]).toMatchObject({ priority: 'urgent', preview: '<b>bold</b>' })
  })

  it('makes no request when policy turns the widgets off', async () => {
    const { w, calls } = world({ enabled: false })
    expect((await w.load()).state).toBe('disabled')
    expect(calls).toEqual([])
  })

  it('says signed out, locked or sign-in needed without data', async () => {
    expect((await world({ accounts: [] }).w.load()).state).toBe('not_signed_in')
    expect((await world({ accounts: [{ id: 'a', server_url: 'https://x.example', state: 'locked' }] }).w.load()).state).toBe('locked')
    expect((await world({ token: { ok: false, error: 'auth_required' } }).w.load()).state).toBe('auth_required')
    expect((await world({ status: 401 }).w.load()).state).toBe('auth_required')
    // Plain http to a remote server is refused, as for search.
    expect((await world({ accounts: [{ id: 'a', server_url: 'http://evil.example', state: 'signed_in' }] }).w.load()).state).toBe('error')
  })

  it('marks a module the person cannot open as unavailable, and a failing one as an error', async () => {
    const s = await world({ status: (p) => (p.startsWith('/api/hr') ? 404 : p === '/api/tasks' ? 500 : 200) }).w.load()
    expect(s.approvals.state).toBe('unavailable')
    expect(s.announcements.state).toBe('unavailable')
    expect(s.tasks.state).toBe('error')
    expect(s.events.state).toBe('ok')
  })

  it('works offline from the per-account cache, and keeps a source’s last good answer', async () => {
    const x = world()
    await x.w.load()
    expect(x.store.has('acc-1')).toBe(true)
    // Offline: every source fails, the cached data comes back marked cached.
    const off = createWidgets({ broker: async (m) => (m === 'Status' ? { ok: true, value: [{ id: 'acc-1', server_url: 'https://work.example.com', state: 'signed_in' }] } : { ok: true, value: 't' }), fetch: async () => { throw new Error('down') }, cache: { read: (id) => x.store.get(id) ?? null, write: () => undefined, clear: () => undefined }, now: () => NOW })
    const s = await off.load()
    expect(s).toMatchObject({ state: 'offline', cached: true })
    expect(s.tasks.data?.[0].title).toBe('Send invoice')
    // Nothing cached and offline: an offline state, never invented data.
    expect((await world({ throws: true }).w.load())).toMatchObject({ state: 'offline', fetchedAt: null, tasks: { data: null } })
  })

  it('drops the cache when the account changes or signs out', async () => {
    const x = world()
    await x.w.load()
    x.setAccounts([{ id: 'acc-2', server_url: 'https://work.example.com', state: 'signed_in' }])
    await x.w.load()
    expect(x.cleared()).toBe(1)
    expect([...x.store.keys()]).toEqual(['acc-2'])
    x.setAccounts([])
    await x.w.load()
    expect(x.store.size).toBe(0)
  })
})

describe('desktop widgets parsing', () => {
  it('passes only worksuite links and Desktop routes', () => {
    expect(linkOf('/crm/leads/12')).toBe('worksuite://crm/leads/12')
    expect(linkOf('worksuite://tasks/4')).toBe('worksuite://tasks/4')
    for (const bad of ['javascript:alert(1)', 'https://evil.example', '/../etc/passwd', '//evil.example/x', 'file:///etc/passwd', 42, null]) expect(linkOf(bad)).toBeNull()
  })

  it('drops malformed rows and caps text', () => {
    expect(parseTasks({ data: { tasks: [{ id: 1 }, { title: 'x' }, { id: 'a b', title: 'x' }, { id: 2, title: 'x'.repeat(900), archived: true }, 'junk'] } })).toEqual([])
    expect(parseTasks({ data: { tasks: [{ id: 3, title: 'a\u0000b'.padEnd(500, 'c') }] } })[0].title).toHaveLength(300)
    expect(parseEvents({ events: [{ id: 1, title: 'No start' }, { id: 2, title: 'x', start_at: 'tomorrow' }] })).toEqual([])
    expect(parseEvents({ events: [{ id: 2, title: 'x', start_at: '2026-10-16T09:00:00', color: 'red;background:url(x)' }] })[0].color).toBeNull()
    expect(parseAnnouncements(null)).toEqual([])
    expect(parseApprovals({ data: { items: [{ id: 1, kind: 'timesheet', title: 'Week 41', link: 'https://x' }] } }).items[0].link).toBe('worksuite://hr')
    expect(parseDashboard({})).toEqual({ unreadMail: 0, unreadChat: 0, notifications: 0, files: [], activity: [] })
    expect(parseSummary({ data: { digest: { text: 5 } } })).toEqual({ text: null, points: [] })
  })

  it('checks a cached snapshot again before use', () => {
    expect(fromCache('nope', '2026-10-16')).toBeNull()
    const c = fromCache({ fetchedAt: 1, tasks: { state: 'ok', data: [{ id: '1', title: 'T', link: 'javascript:x' }, { id: '2', title: 'U', link: 'worksuite://tasks/2' }] }, events: { state: 'unavailable' } }, '2026-10-16')!
    expect(c.tasks.data?.map((t) => t.id)).toEqual(['2'])
    expect(c.events.state).toBe('unavailable')
    expect(c.summary.state).toBe('offline')
  })
})

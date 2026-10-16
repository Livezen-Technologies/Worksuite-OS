// Desktop widgets (WorkSuite Desktop's Home dashboard on the OS wallpaper). Runs in the Electron main process like
// launcher search (search.ts): the broker's access token is attached here and never reaches the renderer, which only
// gets the parsed, size-capped data below. Every string from a server is plain text; links are worksuite:// only.
//
// Sources, the same platform endpoints WorkSuite Desktop's Home (src/modules/home) reads, on the account's server:
//   dashboard   GET /api/dashboard/home                 stats (unread mail/chat), recent_files, activity
//   summary     GET /api/dashboard/summary              the daily brief (digest text and points)
//   tasks       GET /api/tasks                          Today's work: due today and overdue
//   events      GET /api/calendar/events?from=&to=      Today's agenda
//   notices     GET /api/hr/announcements/mine          Announcements
//   approvals   GET /api/hr/approvals/pending           Waiting for me (HR approvals)
// A source that answers 404 or 403 is 'unavailable' (the module is not enabled for the person): its widget is absent,
// as on Desktop (FR-REG-06). The last good answer is cached per account so the widgets work offline; a switch of
// account never shows the previous account's data (the cache is keyed by account id and dropped on sign-out).

export type WidgetsState = 'ok' | 'not_signed_in' | 'locked' | 'auth_required' | 'offline' | 'disabled' | 'error'
export type SectionState = 'ok' | 'unavailable' | 'error' | 'auth_required' | 'offline'
export interface Section<T> { state: SectionState; data: T | null }

export interface WTask { id: string; title: string; due: string | null; dueAt: string | null; priority: string; status: string; link: string }
export interface WEvent { id: string; title: string; start: string; end: string | null; allDay: boolean; location: string | null; meeting: boolean; color: string | null; link: string }
export interface WNotice { id: string; title: string; preview: string | null; priority: 'normal' | 'important' | 'urgent'; pinned: boolean; read: boolean; at: string | null; expires: string | null; link: string }
export interface WApproval { id: string; kind: string; title: string; who: string | null; at: string | null; link: string }
export interface WFile { id: string; name: string; ext: string; size: number; location: string | null; at: string | null; status: string | null; link: string }
export interface WActivity { id: string; user: string | null; text: string; module: string | null; count: number; at: string | null; link: string | null }
export interface WDashboard { unreadMail: number; unreadChat: number; notifications: number; files: WFile[]; activity: WActivity[] }
export interface WSummary { text: string | null; points: { text: string; link: string | null }[] }

export interface WidgetsSnapshot {
  state: WidgetsState
  /** When the data was fetched (ms); null when there is none. */
  fetchedAt: number | null
  /** True when the sections come from the offline cache, not this request. */
  cached: boolean
  /** The day the lists are about (YYYY-MM-DD, local). */
  today: string
  tasks: Section<WTask[]>
  events: Section<WEvent[]>
  announcements: Section<WNotice[]>
  approvals: Section<{ count: number; items: WApproval[] }>
  dashboard: Section<WDashboard>
  summary: Section<WSummary>
}

type Resp = { ok: boolean; status: number; json(): Promise<unknown> }
export type WidgetsFetch = (url: string, init: { headers?: Record<string, string>; signal?: AbortSignal }) => Promise<Resp>
export type WidgetsBroker = (method: string, params?: Record<string, unknown>) => Promise<{ ok: true; value: unknown } | { ok: false; error: string }>
export interface WidgetsCache { read(accountId: string): unknown; write(accountId: string, snap: WidgetsSnapshot): void; clear(): void }
export interface WidgetsOptions {
  broker: WidgetsBroker
  fetch: WidgetsFetch
  device?: () => string | null
  cache?: WidgetsCache
  /** Policy: false turns the widgets off (no requests at all). Read fresh on each load. */
  enabled?: () => boolean
  timeoutMs?: number
  now?: () => Date
}

const MAX_TEXT = 300
const MAX_ITEMS = 20
const str = (v: unknown, max = MAX_TEXT): string | null => (typeof v === 'string' && v.trim() ? v.replace(/[\u0000-\u001f\u007f]/g, ' ').trim().slice(0, max) : null)
const num = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) && v >= 0 ? Math.floor(v) : 0)
const idOf = (v: unknown): string | null => (typeof v === 'number' && Number.isFinite(v) ? String(v) : typeof v === 'string' && /^[A-Za-z0-9:_-]{1,64}$/.test(v) ? v : null)
const ISO = /^\d{4}-\d{2}-\d{2}([T ]\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:?\d{2})?)?$/
const when = (v: unknown): string | null => (typeof v === 'string' && ISO.test(v) ? v : null)
const SEG = /^[A-Za-z0-9_-]{1,64}$/
const ws = (...parts: string[]) => `worksuite://${parts.map(encodeURIComponent).join('/')}`
/** A Desktop route ("/crm/leads/12") or a worksuite:// link from a server, as a worksuite:// link; anything else is dropped. */
export function linkOf(v: unknown): string | null {
  const s = str(v, 512)
  if (!s) return null
  const path = s.startsWith('worksuite://') ? s.slice(12) : s.startsWith('/') ? s.slice(1) : null
  if (path === null) return null
  const segs = path.split('?')[0]!.split('/').filter(Boolean)
  if (!segs.length || segs.length > 4 || !segs.every((x) => SEG.test(x)) || !/^[a-z]/.test(segs[0]!)) return null
  return `worksuite://${segs.join('/')}`
}
const list = (v: unknown): Record<string, unknown>[] => (Array.isArray(v) ? v.filter((x): x is Record<string, unknown> => !!x && typeof x === 'object') : [])
/** Platform answers are `{ data: … }` envelopes (WorkSuite Desktop core/api.ts); a bare body is accepted too. */
const unwrap = (b: unknown): unknown => (b && typeof b === 'object' && 'data' in (b as object) ? (b as { data: unknown }).data : b)
const field = (b: unknown, k: string): unknown => (b && typeof b === 'object' ? (b as Record<string, unknown>)[k] : undefined)

export function parseTasks(body: unknown): WTask[] {
  const b = unwrap(body)
  return list(Array.isArray(b) ? b : field(b, 'tasks')).flatMap((t) => {
    const id = idOf(t.id); const title = str(t.title)
    const status = str(t.status, 32) ?? 'todo'
    if (!id || !title || t.archived === true) return []
    return [{ id, title, due: when(t.due_date)?.slice(0, 10) ?? null, dueAt: when(t.due_at), priority: str(t.priority, 16) ?? 'none', status, link: ws('tasks', id) }]
  })
}

export function parseEvents(body: unknown): WEvent[] {
  return list(field(unwrap(body), 'events')).flatMap((e) => {
    const id = idOf(e.id); const title = str(e.title); const start = when(e.start_at)
    if (!id || !title || !start) return []
    const meeting = e.source === 'meeting' || e.source === 'businessmeeting' || !!str(e.meeting_uuid) || !!str(e.join_url)
    const color = typeof e.color === 'string' && /^#[0-9a-fA-F]{3,8}$/.test(e.color) ? e.color : null
    return [{ id, title, start, end: when(e.end_at), allDay: e.all_day === true, location: str(e.location, 120), meeting, color, link: 'worksuite://calendar' }]
  }).slice(0, 50)
}

export function parseAnnouncements(body: unknown): WNotice[] {
  const b = unwrap(body)
  return list(Array.isArray(b) ? b : field(b, 'items')).flatMap((a): WNotice[] => {
    const id = idOf(a.id); const title = str(a.title)
    if (!id || !title) return []
    const priority: WNotice['priority'] = a.priority === 'urgent' || a.priority === 'important' ? a.priority : 'normal'
    return [{ id, title, preview: str(a.preview), priority, pinned: a.pinned === true, read: a.read === true, at: when(a.published_at), expires: when(a.expires_at), link: 'worksuite://home' }]
  }).slice(0, MAX_ITEMS)
}

export function parseApprovals(body: unknown): { count: number; items: WApproval[] } {
  const b = unwrap(body)
  const items = list(field(b, 'items')).flatMap((a) => {
    const id = idOf(a.id); const kind = str(a.kind, 32) ?? 'approval'
    const title = str(a.title) ?? str(a.label) ?? str(a.description)
    if (!id || !title) return []
    return [{ id, kind, title, who: str(a.user ?? a.employee ?? a.requested_by, 80), at: when(a.at ?? a.created_at), link: kind === 'leave' ? ws('hr', 'leave', id) : linkOf(a.link) ?? 'worksuite://hr' }]
  }).slice(0, MAX_ITEMS)
  return { count: Math.max(num(field(b, 'count')), items.length), items }
}

/** Upload chunks and the like are not activity (Desktop #104). */
const NOISE = /\b(chunk|part \d+ of \d+|upload(ed)? part|transfer part)\b/i
/** Temporary and system files Desktop leaves out of Recent files. */
const JUNK = /^(~\$|\.~lock\.|\.DS_Store$|Thumbs\.db$|desktop\.ini$)|\.(tmp|crdownload|part)$/i

export function parseDashboard(body: unknown): WDashboard {
  const b = unwrap(body)
  const stats = field(b, 'stats')
  const files = list(field(b, 'recent_files')).flatMap((f) => {
    const id = idOf(f.id); const name = str(f.name, 200)
    if (!id || !name || JUNK.test(name)) return []
    const ext = (str(f.extension, 10) ?? (name.includes('.') ? name.split('.').pop()! : '')).toLowerCase().replace(/[^a-z0-9]/g, '')
    const status = f.status === 'processing' || f.status === 'failed' ? f.status : null
    return [{ id, name, ext, size: num(f.size), location: str(f.location, 120), at: when(f.at), status, link: ws('files', id) }]
  }).slice(0, MAX_ITEMS)
  const activity = list(field(b, 'activity')).flatMap((a) => {
    const id = idOf(a.id); const text = str(a.description)
    if (!id || !text || NOISE.test(text)) return []
    return [{ id, user: str(a.user, 80), text, module: str(a.module, 32), count: Math.max(1, num(a.count)), at: when(a.at), link: linkOf(a.link) }]
  }).slice(0, MAX_ITEMS)
  return { unreadMail: num(field(stats, 'unread_mail')), unreadChat: num(field(stats, 'unread_chats')), notifications: num(field(stats, 'notifications_unread')), files, activity }
}

export function parseSummary(body: unknown): WSummary {
  const d = field(unwrap(body), 'digest')
  const points = list(field(d, 'points')).flatMap((p) => { const text = str(p.text); return text ? [{ text, link: linkOf(p.link) }] : [] }).slice(0, 6)
  return { text: str(field(d, 'text'), 1200), points }
}

export function ymd(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}

const none = <T>(state: SectionState = 'error'): Section<T> => ({ state, data: null })
export function emptySnapshot(state: WidgetsState, today: string): WidgetsSnapshot {
  return { state, fetchedAt: null, cached: false, today, tasks: none(), events: none(), announcements: none(), approvals: none(), dashboard: none(), summary: none() }
}

/** A cached snapshot, checked again: the cache is a file on disk, so it is untrusted like any input. */
export function fromCache(v: unknown, today: string): WidgetsSnapshot | null {
  if (!v || typeof v !== 'object') return null
  const c = v as Record<string, unknown>
  if (typeof c.fetchedAt !== 'number') return null
  const sec = <T>(k: string, parse: (b: unknown) => T): Section<T> => {
    const s = c[k] as { state?: unknown; data?: unknown } | undefined
    return s?.state === 'ok' ? { state: 'ok', data: parse(s.data) } : s?.state === 'unavailable' ? none('unavailable') : none('offline')
  }
  // The cache holds the parsed shapes; re-parsing them through the raw parsers would drop fields, so check shape only.
  const arr = (x: unknown) => (Array.isArray(x) ? x : [])
  return {
    state: 'ok', fetchedAt: c.fetchedAt, cached: true, today: typeof c.today === 'string' ? c.today : today,
    tasks: sec('tasks', (d) => arr(d).filter((t) => typeof t?.id === 'string' && typeof t.title === 'string' && typeof t.link === 'string' && t.link.startsWith('worksuite://')) as WTask[]),
    events: sec('events', (d) => arr(d).filter((e) => typeof e?.id === 'string' && typeof e.title === 'string' && typeof e.start === 'string') as WEvent[]),
    announcements: sec('announcements', (d) => arr(d).filter((a) => typeof a?.id === 'string' && typeof a.title === 'string') as WNotice[]),
    approvals: sec('approvals', (d) => ({ count: num(field(d, 'count')), items: arr(field(d, 'items')).filter((a) => typeof a?.id === 'string' && typeof a.title === 'string') as WApproval[] })),
    dashboard: sec('dashboard', (d) => ({
      unreadMail: num(field(d, 'unreadMail')), unreadChat: num(field(d, 'unreadChat')), notifications: num(field(d, 'notifications')),
      files: arr(field(d, 'files')).filter((f) => typeof f?.id === 'string' && typeof f.name === 'string') as WFile[],
      activity: arr(field(d, 'activity')).filter((a) => typeof a?.id === 'string' && typeof a.text === 'string') as WActivity[],
    })),
    summary: sec('summary', (d) => ({ text: typeof field(d, 'text') === 'string' ? (field(d, 'text') as string) : null, points: arr(field(d, 'points')).filter((p) => typeof p?.text === 'string') })),
  }
}

export function createWidgets(o: WidgetsOptions) {
  const timeoutMs = o.timeoutMs ?? 8000
  const now = o.now ?? (() => new Date())
  let lastAccount: string | null = null

  async function account(): Promise<{ ok: true; id: string; token: string; server: URL } | { ok: false; state: WidgetsState }> {
    const st = await o.broker('Status')
    if (!st.ok) return { ok: false, state: 'not_signed_in' }
    const accts = (Array.isArray(st.value) ? st.value : []) as { id: string; server_url: string; state?: string }[]
    const acct = accts.find((a) => a.state === 'signed_in') ?? accts[0]
    if (!acct) return { ok: false, state: 'not_signed_in' }
    if (acct.state === 'locked') return { ok: false, state: 'locked' }
    const t = await o.broker('GetAccessToken', { account_id: acct.id })
    if (!t.ok || typeof t.value !== 'string') return { ok: false, state: t.ok ? 'error' : t.error === 'broker_unavailable' ? 'not_signed_in' : 'auth_required' }
    let server: URL
    try { server = new URL(acct.server_url); if (server.protocol !== 'https:' && server.hostname !== '127.0.0.1' && server.hostname !== 'localhost') throw new Error() } catch { return { ok: false, state: 'error' } }
    return { ok: true, id: acct.id, token: t.value, server }
  }

  async function get<T>(a: { token: string; server: URL }, path: string, parse: (b: unknown) => T): Promise<Section<T>> {
    const ctl = new AbortController()
    const timer = setTimeout(() => ctl.abort(), timeoutMs)
    try {
      const headers: Record<string, string> = { authorization: `Bearer ${a.token}`, accept: 'application/json' }
      const d = o.device?.()
      if (d) headers['x-ws-device'] = d
      const r = await o.fetch(new URL(path, a.server).toString(), { headers, signal: ctl.signal })
      if (r.status === 401) return none('auth_required')
      if (r.status === 404 || r.status === 403) return none('unavailable')
      if (!r.ok) return none('error')
      return { state: 'ok', data: parse(await r.json()) }
    } catch {
      return none('offline')
    } finally { clearTimeout(timer) }
  }

  async function load(): Promise<WidgetsSnapshot> {
    const today = ymd(now())
    if (o.enabled && !o.enabled()) return emptySnapshot('disabled', today)
    const a = await account().catch(() => ({ ok: false as const, state: 'error' as const }))
    if (!a.ok) {
      // Signed out or a different account: nothing of the previous one stays.
      if (a.state === 'not_signed_in') { o.cache?.clear(); lastAccount = null }
      return emptySnapshot(a.state, today)
    }
    if (lastAccount && lastAccount !== a.id) o.cache?.clear()
    lastAccount = a.id
    const q = `from=${today}&to=${today}`
    const [dashboard, summary, tasks, events, announcements, approvals] = await Promise.all([
      get(a, '/api/dashboard/home', parseDashboard),
      get(a, '/api/dashboard/summary', parseSummary),
      get(a, '/api/tasks', parseTasks),
      get(a, `/api/calendar/events?${q}`, parseEvents),
      get(a, '/api/hr/announcements/mine', parseAnnouncements),
      get(a, '/api/hr/approvals/pending', parseApprovals),
    ])
    const fresh: WidgetsSnapshot = { state: 'ok', fetchedAt: now().getTime(), cached: false, today, dashboard, summary, tasks, events, announcements, approvals }
    const sections = ['dashboard', 'summary', 'tasks', 'events', 'announcements', 'approvals'] as const
    if (sections.some((k) => fresh[k].state === 'auth_required')) return { ...emptySnapshot('auth_required', today) }
    const allOffline = sections.every((k) => fresh[k].state === 'offline')
    if (!allOffline && sections.some((k) => fresh[k].state === 'ok')) {
      // Keep the last good answer of a source that failed this time, so one hiccup doesn't empty a widget.
      const old = o.cache ? fromCache(o.cache.read(a.id), today) : null
      if (old) for (const k of sections) if (fresh[k].state === 'error' || fresh[k].state === 'offline') if (old[k].state === 'ok') (fresh as unknown as Record<string, unknown>)[k] = old[k]
      o.cache?.write(a.id, fresh)
      return fresh
    }
    const cached = o.cache ? fromCache(o.cache.read(a.id), today) : null
    if (cached) return { ...cached, state: allOffline ? 'offline' : 'ok', today }
    return emptySnapshot(allOffline ? 'offline' : 'error', today)
  }

  return { load }
}

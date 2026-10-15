// Launcher global search and recent files (WSOS-LCH-*, WSOS-DSK-010). Runs in the Electron main process: the broker's
// access token is attached here and never reaches the renderer, which only sees results.
//
// Sources, both on the account's api_base (desktop/v1 contract, api-contracts/openapi.yaml):
//   worksuite  GET desktop/v1/search?q=&types=   records (mail, contacts, CRM, tasks, chat, calendar…)
//                                                 platform: GET /api/search/global (Search/GlobalSearchController)
//   drive      GET desktop/v1/files/search?q=     Drive files; platform: GET /api/files/search
//   recent     GET desktop/v1/files/recent        platform: GET /api/drive/list?view=recent
// The server scopes every answer to what the caller may open. Nothing is cached across searches except each server's
// api_base, so a switch of account can never show the previous account's results.

export type SourceId = 'worksuite' | 'drive'
export type SourceState = 'ok' | 'not_signed_in' | 'locked' | 'auth_required' | 'offline' | 'timeout' | 'error'
export type IconKind = 'mail' | 'contact' | 'crm' | 'task' | 'chat' | 'event' | 'note' | 'project' | 'document' | 'file' | 'record'

export interface SearchHit {
  id: string
  source: SourceId | 'local'
  /** Result type: a WorkSuite record type, or 'file'. */
  type: string
  title: string
  subtitle: string | null
  icon: IconKind
  /** worksuite:// deep link, or file:// for a local file. */
  link: string
  ext?: string
  at?: string | null
  score: number
}
export interface SourceResult { source: SourceId; state: SourceState; hits: SearchHit[] }
export interface SearchResponse { query: string; cancelled?: boolean; sources: SourceResult[]; hits: SearchHit[] }

type Resp = { ok: boolean; status: number; json(): Promise<unknown> }
export type SearchFetch = (url: string, init: { headers?: Record<string, string>; signal?: AbortSignal }) => Promise<Resp>
export type SearchBroker = (method: string, params?: Record<string, unknown>) => Promise<{ ok: true; value: unknown } | { ok: false; error: string }>

export interface SearchOptions { broker: SearchBroker; fetch: SearchFetch; debounceMs?: number; timeoutMs?: number; limit?: number }

const ICONS = new Set<IconKind>(['mail', 'contact', 'crm', 'task', 'chat', 'event', 'note', 'project', 'document', 'file'])
const iconOf = (type: string): IconKind => (ICONS.has(type as IconKind) ? (type as IconKind) : 'record')
const str = (v: unknown) => (typeof v === 'string' ? v : null)
const num = (v: unknown, d = 0) => (typeof v === 'number' && Number.isFinite(v) ? v : d)
/** Only worksuite:// links pass through; anything else from a server is dropped. */
const wsLink = (v: unknown) => { const s = str(v); return s && /^worksuite:\/\/[a-z][a-z0-9_-]*(\/|$)/.test(s) ? s : null }

type Account = { accountId: string; token: string; apiBase: string }
type AccountResult = { ok: true; value: Account } | { ok: false; state: SourceState }

/** Merge by relevance: score descending, ties keep source order (WorkSuite records, then Drive). */
export function mergeHits(lists: SearchHit[][]): SearchHit[] {
  return lists.flatMap((l, s) => l.map((h, i) => ({ h, s, i }))).sort((a, b) => b.h.score - a.h.score || a.s - b.s || a.i - b.i).map((x) => x.h)
}

export function parseRecordHits(body: unknown): SearchHit[] {
  const results = (body as { results?: unknown })?.results
  if (!Array.isArray(results)) return []
  return results.flatMap((r: Record<string, unknown>) => {
    const link = wsLink(r?.link); const title = str(r?.title); const type = str(r?.type) ?? 'record'
    if (!link || !title) return []
    return [{ id: `ws:${String(r.id)}`, source: 'worksuite' as const, type, title, subtitle: str(r.subtitle), icon: iconOf(type), link, at: str(r.at), score: num(r.score) }]
  })
}

export function parseFileHits(body: unknown, source: SourceId = 'drive'): SearchHit[] {
  const files = (body as { files?: unknown })?.files
  if (!Array.isArray(files)) return []
  return files.flatMap((f: Record<string, unknown>) => {
    const link = wsLink(f?.link); const name = str(f?.name)
    if (!link || !name) return []
    const ext = str(f.ext) ?? ''
    return [{ id: `drive:${String(f.id)}`, source, type: 'file', title: name, subtitle: str(f.folder), icon: 'file' as const, link, ext, at: str(f.modified), score: num(f.score) }]
  })
}

export function createSearch(o: SearchOptions) {
  const debounceMs = o.debounceMs ?? 150
  const timeoutMs = o.timeoutMs ?? 4000
  const limit = o.limit ?? 20
  const apiBases = new Map<string, string>()
  let current: AbortController | null = null

  async function account(signal: AbortSignal): Promise<AccountResult> {
    const st = await o.broker('Status')
    if (!st.ok) return { ok: false, state: 'not_signed_in' }
    const list = (Array.isArray(st.value) ? st.value : []) as { id: string; server_url: string; state?: string }[]
    const acct = list.find((a) => a.state === 'signed_in') ?? list[0]
    if (!acct) return { ok: false, state: 'not_signed_in' }
    if (acct.state === 'locked') return { ok: false, state: 'locked' }
    const t = await o.broker('GetAccessToken', { account_id: acct.id })
    if (!t.ok || typeof t.value !== 'string') return { ok: false, state: t.ok ? 'error' : t.error === 'broker_unavailable' ? 'not_signed_in' : 'auth_required' }
    let server: URL
    try { server = new URL(acct.server_url); if (server.protocol !== 'https:' && server.hostname !== '127.0.0.1' && server.hostname !== 'localhost') throw new Error() } catch { return { ok: false, state: 'error' } }
    let apiBase = apiBases.get(server.origin)
    if (!apiBase) {
      apiBase = server.toString()
      try {
        const wk = await o.fetch(new URL('/.well-known/worksuite-desktop', server).toString(), { signal })
        if (wk.ok) { const b = (await wk.json()) as { api_base?: unknown }; if (typeof b.api_base === 'string' && /^https?:\/\//.test(b.api_base)) apiBase = b.api_base }
      } catch { if (signal.aborted) throw new DOMException('aborted', 'AbortError'); return { ok: false, state: 'offline' } }
      apiBase = apiBase.replace(/\/?$/, '/')
      apiBases.set(server.origin, apiBase)
    }
    return { ok: true, value: { accountId: acct.id, token: t.value, apiBase } }
  }

  /** One source with its own timeout; the parent signal cancels it too. */
  async function source(a: Account, path: string, parse: (b: unknown) => SearchHit[], parent: AbortSignal): Promise<{ state: SourceState; hits: SearchHit[] }> {
    const ctl = new AbortController()
    let timedOut = false
    const timer = setTimeout(() => { timedOut = true; ctl.abort() }, timeoutMs)
    const onAbort = () => ctl.abort()
    parent.addEventListener('abort', onAbort)
    try {
      const r = await o.fetch(new URL(path, a.apiBase).toString(), { headers: { authorization: `Bearer ${a.token}` }, signal: ctl.signal })
      if (r.status === 401) return { state: 'auth_required', hits: [] }
      if (!r.ok) return { state: 'error', hits: [] }
      return { state: 'ok', hits: parse(await r.json()) }
    } catch {
      return { state: timedOut ? 'timeout' : parent.aborted ? 'error' : 'offline', hits: [] }
    } finally { clearTimeout(timer); parent.removeEventListener('abort', onAbort) }
  }

  const failed = (state: SourceState): SourceResult[] => (['worksuite', 'drive'] as const).map((source) => ({ source, state, hits: [] }))

  /** Debounced: a newer call cancels this one, which then resolves with cancelled: true. */
  async function search(query: string, types: string[] = []): Promise<SearchResponse> {
    current?.abort()
    const ctl = new AbortController()
    current = ctl
    const q = query.trim().slice(0, 200)
    const cancelled = (): SearchResponse => ({ query: q, cancelled: true, sources: [], hits: [] })
    if (!q) return { query: q, sources: [], hits: [] }
    await new Promise((r) => setTimeout(r, debounceMs))
    if (ctl.signal.aborted) return cancelled()
    let a: AccountResult
    try { a = await account(ctl.signal) } catch { return cancelled() }
    if (ctl.signal.aborted) return cancelled()
    if (!a.ok) return { query: q, sources: failed(a.state), hits: [] }
    const enc = encodeURIComponent(q)
    const t = types.length ? `&types=${encodeURIComponent(types.join(','))}` : ''
    const [ws, drive] = await Promise.all([
      source(a.value, `desktop/v1/search?q=${enc}${t}&limit=${limit}`, parseRecordHits, ctl.signal),
      source(a.value, `desktop/v1/files/search?q=${enc}&limit=${limit}`, (b) => parseFileHits(b), ctl.signal),
    ])
    if (ctl.signal.aborted) return cancelled()
    if (current === ctl) current = null
    return { query: q, sources: [{ source: 'worksuite', ...ws }, { source: 'drive', ...drive }], hits: mergeHits([ws.hits, drive.hits]) }
  }

  async function recent(): Promise<{ state: SourceState; hits: SearchHit[] }> {
    const ctl = new AbortController()
    const a = await account(ctl.signal).catch(() => ({ ok: false, state: 'offline' }) as AccountResult)
    if (!a.ok) return { state: a.state, hits: [] }
    return source(a.value, `desktop/v1/files/recent?limit=${limit}`, (b) => parseFileHits(b), ctl.signal)
  }

  return { search, recent, cancel: () => current?.abort() }
}

// ---- local recent files: XDG recently-used.xbel ----

export interface LocalRecent { href: string; name: string; path: string; modified: string | null; mime: string | null }

const unescapeXml = (s: string) => s.replace(/&(lt|gt|quot|apos|amp|#\d+|#x[0-9a-f]+);/gi, (m, e: string) =>
  e === 'lt' ? '<' : e === 'gt' ? '>' : e === 'quot' ? '"' : e === 'apos' ? "'" : e === 'amp' ? '&' : e[1].toLowerCase() === 'x' ? String.fromCodePoint(parseInt(e.slice(2), 16)) : String.fromCodePoint(parseInt(e.slice(1), 10)))

/** Bookmarks from ~/.local/share/recently-used.xbel: local file:// entries only, newest first. */
export function parseXbel(xml: string, max = 20): LocalRecent[] {
  const out: LocalRecent[] = []
  for (const m of xml.matchAll(/<bookmark\b([^>]*?)\/>|<bookmark\b([^>]*)>([\s\S]*?)<\/bookmark>/g)) {
    const attrs = m[1] ?? m[2] ?? ''
    const attr = (n: string) => { const a = new RegExp(`\\b${n}="([^"]*)"`).exec(attrs); return a ? unescapeXml(a[1]) : null }
    const href = attr('href')
    if (!href || !href.startsWith('file://')) continue
    let path: string
    try { path = decodeURIComponent(new URL(href).pathname) } catch { continue }
    const mime = /<mime:mime-type\b[^>]*\btype="([^"]*)"/.exec(m[3] ?? '')?.[1] ?? null
    out.push({ href, name: path.split('/').pop() || path, path, modified: attr('modified') ?? attr('visited') ?? attr('added'), mime })
  }
  return out.sort((a, b) => (b.modified ?? '').localeCompare(a.modified ?? '')).slice(0, max)
}

export function localRecentHits(items: LocalRecent[], home: string): SearchHit[] {
  return items.map((r) => ({
    id: `local:${r.href}`, source: 'local' as const, type: 'file', title: r.name, icon: 'file' as const, link: r.href, at: r.modified, score: 0,
    subtitle: (r.path.startsWith(home + '/') ? '~' + r.path.slice(home.length) : r.path).replace(/\/[^/]*$/, '') || '/',
    ext: r.name.includes('.') ? r.name.split('.').pop()!.toLowerCase() : '',
  }))
}

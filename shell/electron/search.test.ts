import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createSearch, localRecentHits, mergeHits, parseXbel, type SearchBroker, type SearchHit } from './search'

// Fake WorkSuite server: per-token data, a slow route for timeouts, and a log of auth headers.
let server: Server
let base: string
const seen: { path: string; auth: string | undefined }[] = []
const DATA: Record<string, { records: unknown[]; files: unknown[] }> = {
  'tok-ana': {
    records: [{ id: 'mail:1', type: 'mail', title: 'Budget review', subtitle: 'Kamal', link: 'worksuite://mail/1', score: 0.6 }, { id: 'x', type: 'mail', title: 'Bad link', link: 'https://evil.test/', score: 1 }],
    files: [{ id: 'files:9', name: 'Budget.xlsx', ext: 'xlsx', folder: 'Finance', link: 'worksuite://files/9', score: 0.8 }],
  },
  'tok-ben': { records: [{ id: 'mail:2', type: 'mail', title: 'Ben only', link: 'worksuite://mail/2', score: 1 }], files: [] },
}
let slow = false

beforeAll(async () => {
  server = createServer((req, res) => {
    const u = new URL(req.url!, 'http://x')
    seen.push({ path: u.pathname + u.search, auth: req.headers.authorization })
    if (u.pathname === '/.well-known/worksuite-desktop') { res.end(JSON.stringify({ api_base: `${base}/api/` })); return }
    const tok = /^Bearer (.+)$/.exec(req.headers.authorization ?? '')?.[1] ?? ''
    const d = DATA[tok]
    if (!d) { res.statusCode = 401; res.end('{}'); return }
    const send = (b: unknown) => res.end(JSON.stringify(b))
    if (u.pathname === '/api/desktop/v1/search') { if (slow) setTimeout(() => send({ results: d.records }), 500); else send({ results: d.records }); return }
    if (u.pathname === '/api/desktop/v1/files/search' || u.pathname === '/api/desktop/v1/files/recent') { send({ files: d.files }); return }
    res.statusCode = 404; res.end('{}')
  })
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r))
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
})
afterAll(() => server.close())

const brokerFor = (who: { acct: string; token: string } | null): SearchBroker => async (m) => {
  if (!who) return { ok: false, error: 'broker_unavailable' }
  if (m === 'Status') return { ok: true, value: [{ id: who.acct, server_url: base, state: 'signed_in' }] }
  if (m === 'GetAccessToken') return { ok: true, value: who.token }
  return { ok: false, error: 'nope' }
}
const realFetch = (url: string, init: { headers?: Record<string, string>; signal?: AbortSignal }) => fetch(url, init)

describe('search bridge', () => {
  it('sends the broker token server-side and merges by relevance, dropping non-worksuite links', async () => {
    seen.length = 0
    const s = createSearch({ broker: brokerFor({ acct: 'a', token: 'tok-ana' }), fetch: realFetch, debounceMs: 0 })
    const r = await s.search('budget')
    expect(r.hits.map((h) => h.title)).toEqual(['Budget.xlsx', 'Budget review'])
    expect(r.hits[0]).toMatchObject({ type: 'file', icon: 'file', link: 'worksuite://files/9', subtitle: 'Finance', ext: 'xlsx' })
    expect(r.sources.map((x) => x.state)).toEqual(['ok', 'ok'])
    const api = seen.filter((x) => x.path.startsWith('/api/'))
    expect(api.length).toBe(2)
    expect(api.every((x) => x.auth === 'Bearer tok-ana')).toBe(true)
    expect(seen.find((x) => x.path.startsWith('/.well-known'))?.auth).toBeUndefined()
  })

  it('times out one source without losing the other', async () => {
    slow = true
    try {
      const s = createSearch({ broker: brokerFor({ acct: 'a', token: 'tok-ana' }), fetch: realFetch, debounceMs: 0, timeoutMs: 100 })
      const r = await s.search('budget')
      expect(r.sources).toEqual([{ source: 'worksuite', state: 'timeout', hits: [] }, expect.objectContaining({ source: 'drive', state: 'ok' })])
      expect(r.hits.map((h) => h.title)).toEqual(['Budget.xlsx'])
    } finally { slow = false }
  })

  it('debounces: a newer query cancels the older one', async () => {
    seen.length = 0
    const s = createSearch({ broker: brokerFor({ acct: 'a', token: 'tok-ana' }), fetch: realFetch, debounceMs: 30 })
    const [a, b] = await Promise.all([s.search('bu'), s.search('budget')])
    expect(a.cancelled).toBe(true)
    expect(b.hits.length).toBe(2)
    expect(seen.filter((x) => x.path.includes('q=bu&') || x.path.includes('q=bu&')).length).toBe(0)
  })

  it('never carries results across accounts', async () => {
    let who = { acct: 'a', token: 'tok-ana' }
    const s = createSearch({ broker: (m, p) => brokerFor(who)(m, p), fetch: realFetch, debounceMs: 0 })
    expect((await s.search('b')).hits.some((h) => h.title === 'Budget review')).toBe(true)
    who = { acct: 'b', token: 'tok-ben' }
    const r = await s.search('b')
    expect(r.hits.map((h) => h.title)).toEqual(['Ben only'])
  })

  it('says signed out or offline instead of returning results', async () => {
    const out = await createSearch({ broker: brokerFor(null), fetch: realFetch, debounceMs: 0 }).search('x')
    expect(out.sources.map((x) => x.state)).toEqual(['not_signed_in', 'not_signed_in'])
    expect(out.hits).toEqual([])
    const offline = await createSearch({ broker: brokerFor({ acct: 'a', token: 'tok-ana' }), fetch: async () => { throw new TypeError('fetch failed') }, debounceMs: 0 }).search('x')
    expect(offline.sources.map((x) => x.state)).toEqual(['offline', 'offline'])
    const expired = await createSearch({ broker: brokerFor({ acct: 'a', token: 'tok-gone' }), fetch: realFetch, debounceMs: 0 }).search('x')
    expect(expired.sources.map((x) => x.state)).toEqual(['auth_required', 'auth_required'])
  })

  it('reads Drive recent files', async () => {
    const r = await createSearch({ broker: brokerFor({ acct: 'a', token: 'tok-ana' }), fetch: realFetch }).recent()
    expect(r).toMatchObject({ state: 'ok', hits: [{ title: 'Budget.xlsx', link: 'worksuite://files/9' }] })
  })

  it('merges ties in source order', () => {
    const h = (id: string, score: number) => ({ id, score }) as SearchHit
    expect(mergeHits([[h('a', 1), h('b', 0.5)], [h('c', 1), h('d', 0.9)]]).map((x) => x.id)).toEqual(['a', 'c', 'd', 'b'])
  })
})

describe('recently-used.xbel', () => {
  const XBEL = `<?xml version="1.0" encoding="UTF-8"?>
<xbel version="1.0" xmlns:bookmark="http://www.freedesktop.org/standards/desktop-bookmarks" xmlns:mime="http://www.freedesktop.org/standards/shared-mime-info">
  <bookmark href="file:///home/ana/Documents/Budget%202027.xlsx" added="2026-10-01T10:00:00Z" modified="2026-10-14T09:00:00Z" visited="2026-10-14T09:00:00Z">
    <info><metadata owner="http://freedesktop.org"><mime:mime-type type="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"/></metadata></info>
  </bookmark>
  <bookmark href="https://example.test/page" added="2026-10-02T10:00:00Z" modified="2026-10-15T09:00:00Z"/>
  <bookmark href="file:///home/ana/Notes%20%26%20ideas.txt" added="2026-10-03T10:00:00Z" modified="2026-10-15T08:00:00Z"/>
  <bookmark href="file:///tmp/a&amp;b.pdf" modified="2026-09-01T00:00:00Z"></bookmark>
</xbel>`

  it('keeps local files only, newest first, decoded', () => {
    const r = parseXbel(XBEL)
    expect(r.map((x) => x.path)).toEqual(['/home/ana/Notes & ideas.txt', '/home/ana/Documents/Budget 2027.xlsx', '/tmp/a&b.pdf'])
    expect(r[1].mime).toBe('application/vnd.openxmlformats-officedocument.spreadsheetml.sheet')
    expect(parseXbel(XBEL, 1).length).toBe(1)
  })

  it('tolerates garbage', () => {
    expect(parseXbel('not xml')).toEqual([])
    expect(parseXbel('<bookmark href="file:///%E0%A4%A">x</bookmark>')).toEqual([])
  })

  it('turns entries into local hits with a ~ location', () => {
    const [n] = localRecentHits(parseXbel(XBEL), '/home/ana')
    expect(n).toMatchObject({ source: 'local', title: 'Notes & ideas.txt', subtitle: '~', ext: 'txt', link: 'file:///home/ana/Notes%20%26%20ideas.txt' })
    expect(localRecentHits(parseXbel(XBEL), '/home/ana')[1].subtitle).toBe('~/Documents')
  })
})

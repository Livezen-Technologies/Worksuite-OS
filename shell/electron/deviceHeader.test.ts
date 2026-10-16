import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { deviceCredential } from './device'
import { createSearch, type SearchBroker } from './search'
import { appAuthHeaders, loadSession, resolveLink, type Fetch } from './webapps'

const ORIGINS = new Set(['https://mail.acme.test'])
let dir = ''
afterEach(() => { if (dir) rmSync(dir, { recursive: true, force: true }); dir = '' })
function agent(status: unknown | null, token: string | null) {
  dir = mkdtempSync(path.join(tmpdir(), 'wsdev-'))
  const s = path.join(dir, 'status.json'), t = path.join(dir, 'device-token')
  if (status !== null) writeFileSync(s, JSON.stringify(status))
  if (token !== null) writeFileSync(t, token)
  return () => deviceCredential(s, t)
}

describe('deviceCredential', () => {
  it('returns the token only when enrolled, and re-reads on every call', () => {
    const cred = agent({ device: { id: 'd1' } }, 'dev-tok\n')
    expect(cred()).toBe('dev-tok')
    writeFileSync(path.join(dir, 'status.json'), JSON.stringify({ device: null }))
    expect(cred()).toBeNull()
  })
  it('is null without the agent status', () => {
    expect(agent(null, 'x')()).toBeNull()
  })
  it('is null without the token file', () => {
    expect(agent({ device: { id: 'd' } }, null)()).toBeNull()
  })
})

describe('app window headers', () => {
  it('adds X-WS-Device with Authorization only for the allowed origin', () => {
    expect(appAuthHeaders('https://mail.acme.test/inbox', ORIGINS, 't', () => 'dev')).toEqual({ Authorization: 'Bearer t', 'X-WS-Device': 'dev' })
    expect(appAuthHeaders('https://evil.test/x', ORIGINS, 't', () => 'dev')).toEqual({})
    expect(appAuthHeaders('https://mail.acme.test.evil.test/x', ORIGINS, 't', () => 'dev')).toEqual({})
  })
  it('omits X-WS-Device when not enrolled', () => {
    expect(appAuthHeaders('https://mail.acme.test/', ORIGINS, 't', () => null)).toEqual({ Authorization: 'Bearer t' })
  })
  it('bootstrap and link resolve send it when enrolled, not otherwise', async () => {
    const calls: { url: string; h?: Record<string, string> }[] = []
    const f: Fetch = async (url, init) => {
      calls.push({ url, h: init?.headers })
      const body = url.includes('links') ? { web_url: 'https://mail.acme.test/m/1' } : url.includes('bootstrap') ? { apps: [] } : {}
      return { ok: !url.includes('well-known'), status: 200, json: async () => body }
    }
    const broker = async (m: string) => m === 'Status'
      ? { ok: true as const, value: [{ id: 'a', server_url: 'https://acme.test', state: 'signed_in' }] }
      : { ok: true as const, value: 'tok' }
    const r = await loadSession(broker, f, () => 'dev')
    expect(r.ok).toBe(true)
    expect(calls.find((c) => c.url.includes('bootstrap'))?.h).toEqual({ authorization: 'Bearer tok', 'x-ws-device': 'dev' })
    expect(calls.find((c) => c.url.includes('well-known'))?.h).toBeUndefined()
    if (r.ok) await resolveLink(r.value, 'worksuite://mail/1', f, () => null)
    expect(calls.find((c) => c.url.includes('links'))?.h).toEqual({ authorization: 'Bearer tok' })
  })
})

describe('search bridge device header', () => {
  const broker: SearchBroker = async (m) => m === 'Status'
    ? { ok: true, value: [{ id: 'a', server_url: 'https://acme.test', state: 'signed_in' }] }
    : { ok: true, value: 'tok' }
  const run = async (device: () => string | null) => {
    const seen: { url: string; h?: Record<string, string> }[] = []
    const s = createSearch({
      broker, device, debounceMs: 0,
      fetch: async (url, init) => { seen.push({ url, h: init.headers }); return { ok: true, status: 200, json: async () => ({ results: [] }) } },
    })
    await s.search('budget')
    return seen
  }
  it('sends X-WS-Device to the API when enrolled, not to discovery', async () => {
    const seen = await run(() => 'dev')
    const api = seen.filter((x) => !x.url.includes('well-known'))
    expect(api.length).toBeGreaterThan(0)
    expect(api.every((x) => x.h?.['x-ws-device'] === 'dev')).toBe(true)
    expect(seen.filter((x) => x.url.includes('well-known')).every((x) => !x.h?.['x-ws-device'])).toBe(true)
  })
  it('omits it when not enrolled', async () => {
    expect((await run(() => null)).every((x) => !x.h?.['x-ws-device'])).toBe(true)
  })
})

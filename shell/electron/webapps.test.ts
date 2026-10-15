import { describe, expect, it } from 'vitest'
import { allowedOrigins, linkRequest, loadSession, navDecision, parseAppArgs, resolveLink, safeUrl, signInTarget, startUrl, wantsToken, webAppsFrom, type Fetch } from './webapps'

const mail = { id: 'mail', name: 'Mail', web_url: 'https://apps.example.com/mail/' }

describe('worksuite-app arguments', () => {
  it('takes a module key or a worksuite:// link', () => {
    expect(parseAppArgs(['electron', '/app', '--worksuite-app=mail'])).toEqual({ id: 'mail', link: null })
    expect(parseAppArgs(['electron', '/app', '--worksuite-app', 'pdf-studio'])).toEqual({ id: 'pdf-studio', link: null })
    expect(parseAppArgs(['e', '--worksuite-app=worksuite://drive/files/1'])).toEqual({ id: 'drive', link: 'worksuite://drive/files/1' })
    expect(parseAppArgs(['e', '--worksuite-app=drive', 'worksuite://drive/x'])).toEqual({ id: 'drive', link: 'worksuite://drive/x' })
    expect(parseAppArgs(['e', '--worksuite-app=drive', 'worksuite://mail/x'])).toEqual({ id: 'drive', link: null })
  })
  it('ignores anything else so the shell starts normally', () => {
    expect(parseAppArgs(['e', '/app'])).toBeNull()
    expect(parseAppArgs(['e', '--worksuite-app=../etc'])).toBeNull()
    expect(parseAppArgs(['e', '--worksuite-app=Mail;rm'])).toBeNull()
    expect(linkRequest('https://drive/x')).toBeNull()
  })
})

describe('URL allowlist', () => {
  const o = allowedOrigins(mail)
  it('keeps navigation on the module origin', () => {
    expect(navDecision('https://apps.example.com/mail/inbox', o)).toBe('allow')
    expect(navDecision('https://evil.example.com/', o)).toBe('external')
    expect(navDecision('http://apps.example.com/mail/', o)).toBe('deny')
    expect(navDecision('https://apps.example.com:8443/', o)).toBe('external')
    expect(navDecision('mailto:a@b.c', o)).toBe('external')
    expect(navDecision('file:///etc/passwd', o)).toBe('deny')
    expect(navDecision('javascript:alert(1)', o)).toBe('deny')
    expect(navDecision('not a url', o)).toBe('deny')
  })
  it('sends the token only to the module origin', () => {
    expect(wantsToken('https://apps.example.com/api', o)).toBe(true)
    expect(wantsToken('https://cdn.example.com/x.js', o)).toBe(false)
    expect(wantsToken('https://user:pw@apps.example.com/', o)).toBe(false)
  })
  it('opens resolved links only within the module', () => {
    expect(startUrl(mail, 'https://apps.example.com/mail/m/1')).toBe('https://apps.example.com/mail/m/1')
    expect(startUrl(mail, 'https://elsewhere.test/')).toBe(mail.web_url)
    expect(startUrl(mail, null)).toBe(mail.web_url)
  })
  it('accepts https and loopback http only', () => {
    expect(safeUrl('https://a.test/')).not.toBeNull()
    expect(safeUrl('http://localhost:8080/')).not.toBeNull()
    expect(safeUrl('http://a.test/')).toBeNull()
    expect(safeUrl(42)).toBeNull()
  })
})

describe('bootstrap apps', () => {
  it('uses the contract field and drops unsafe entries', () => {
    expect(webAppsFrom({ apps: [mail, { id: 'x', web_url: 'http://bad/' }, { id: 'BAD', web_url: 'https://a/' }, mail] }, 'https://s/')).toEqual([mail])
  })
  it('keeps the declared offline level and drops unknown values (WSOS-SYN-009)', () => {
    const r = webAppsFrom({ apps: [{ ...mail, offline_level: 'cached_read' }, { id: 'chat', name: 'Chat', web_url: 'https://s/chat/', offline_level: 'sometimes' }] }, 'https://s/')
    expect(r.map((a) => a.offline_level)).toEqual(['cached_read', undefined])
  })
  it('falls back to <api_base>/apps/<id>/ for servers without apps', () => {
    expect(webAppsFrom({ modules: [] }, 'https://s.test/api', ['mail'])).toEqual([{ id: 'mail', name: 'mail', web_url: 'https://s.test/api/apps/mail/' }])
  })
  it('chooses the sign-in server', () => {
    expect(signInTarget('https://corp.test', [])).toEqual({ server_url: 'https://corp.test', mode: 'enterprise' })
    expect(signInTarget(null, [{ server_url: 'https://worksuitecloud.com' }]).mode).toBe('personal')
    expect(signInTarget(null, [])).toEqual({ server_url: 'https://worksuitecloud.com', mode: 'personal' })
  })
})

describe('session', () => {
  const res = (status: number, body: unknown) => ({ ok: status < 300, status, json: async () => body })
  const signedIn = { ok: true as const, value: [{ id: 'a1', server_url: 'https://ws.test', state: 'signed_in' }] }
  it('gets a token from the broker and the apps from bootstrap', async () => {
    const seen: [string, Record<string, string> | undefined][] = []
    const f: Fetch = async (url, init) => {
      seen.push([url, init?.headers])
      if (url.endsWith('/.well-known/worksuite-desktop')) return res(200, { api_base: 'https://api.test/' })
      if (url.includes('links/resolve')) return res(200, { web_url: 'https://apps.example.com/mail/m/1' })
      return res(200, { apps: [mail] })
    }
    const r = await loadSession(async (m) => (m === 'Status' ? signedIn : { ok: true as const, value: 'tok' }), f)
    expect(r.ok && r.value.apps).toEqual([mail])
    expect(seen[1]).toEqual(['https://api.test/desktop/v1/bootstrap', { authorization: 'Bearer tok' }])
    if (r.ok) expect(await resolveLink(r.value, 'worksuite://mail/m/1', f)).toBe('https://apps.example.com/mail/m/1')
  })
  it('reports not signed in, auth required, device required and offline', async () => {
    expect(await loadSession(async () => ({ ok: true as const, value: [] }), async () => res(200, {}))).toEqual({ ok: false, error: 'not_signed_in' })
    expect(await loadSession(async (m) => (m === 'Status' ? signedIn : { ok: false as const, error: 'invalid_grant' }), async () => res(200, {}))).toEqual({ ok: false, error: 'auth_required' })
    const ok = async (m: string) => (m === 'Status' ? signedIn : { ok: true as const, value: 't' })
    expect(await loadSession(ok, async (u) => (u.includes('bootstrap') ? res(403, { error: { code: 'DEVICE_REQUIRED' } }) : res(404, {})))).toEqual({ ok: false, error: 'device_required' })
    expect(await loadSession(ok, async () => { throw new Error('net') })).toEqual({ ok: false, error: 'offline' })
  })
})

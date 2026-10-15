import { readFileSync } from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { externalAllowed, loadGrants, parseGrants, permissionAllowed, SHELL_CSP, shellWebPreferences } from './webSecurity'

const here = path.dirname(new URL(import.meta.url).pathname)

describe('WSOS-SEC-001 shell renderer', () => {
  it('is sandboxed and isolated without Node', () => {
    expect(shellWebPreferences('/p.cjs')).toMatchObject({ sandbox: true, contextIsolation: true, nodeIntegration: false, nodeIntegrationInSubFrames: false, webviewTag: false, webSecurity: true, allowRunningInsecureContent: false })
  })
  it('main.ts uses the guard on every shell window', () => {
    const main = readFileSync(path.join(here, 'main.ts'), 'utf8')
    expect(main).not.toMatch(/nodeIntegration:\s*true/)
    expect(main).not.toMatch(/contextIsolation:\s*false/)
    expect(main).not.toMatch(/sandbox:\s*false/)
    expect(main).toMatch(/shellWebPreferences\(/)
    // Shell windows never navigate away from the local bundle and never open new windows.
    expect(main.match(/wc\.on\('will-navigate', \(e\) => e\.preventDefault\(\)\)|win\.webContents\.on\('will-navigate', \(e\) => e\.preventDefault\(\)\)/g)?.length).toBe(2)
    expect(main).not.toMatch(/action: 'allow'/)
  })
})

describe('WSOS-SEC-002 CSP', () => {
  it('production CSP has no inline or remote sources', () => {
    expect(SHELL_CSP).not.toMatch(/unsafe-inline|unsafe-eval|https?:|\*/)
    expect(SHELL_CSP).toMatch(/script-src 'self'/)
    expect(SHELL_CSP).toMatch(/object-src 'none'/)
  })
  it('index.html never allows inline script or eval, and the build swaps in the strict CSP', () => {
    const html = readFileSync(path.join(here, '../index.html'), 'utf8')
    const csp = /Content-Security-Policy" content="([^"]+)"/.exec(html)?.[1] ?? ''
    expect(csp).toMatch(/script-src 'self'(;|$)/)
    expect(csp).not.toMatch(/unsafe-eval/)
    expect(readFileSync(path.join(here, '../vite.config.ts'), 'utf8')).toMatch(/SHELL_CSP/)
  })
})

describe('WSOS-SEC-003 per-origin permission grants', () => {
  const g = parseGrants(JSON.stringify({
    'https://meet.example.org': ['media', 'notifications', 'openExternal'],
    'http://plain.example.org': ['media'],
    'https://x.example.org/path': ['media'],
    'https://bad.example.org': 'media',
  }))
  it('denies by default', () => {
    expect(permissionAllowed(new Map(), 'https://meet.example.org/a', 'media')).toBe(false)
    expect(permissionAllowed(g, undefined, 'media')).toBe(false)
    expect(permissionAllowed(g, 'https://other.example.org/', 'media')).toBe(false)
  })
  it('grants only listed permissions to the exact HTTPS origin', () => {
    expect(permissionAllowed(g, 'https://meet.example.org/room/1', 'media')).toBe(true)
    expect(permissionAllowed(g, 'https://meet.example.org/room/1', 'geolocation')).toBe(false)
    expect(permissionAllowed(g, 'https://meet.example.org:8443/', 'media')).toBe(false)
    expect(permissionAllowed(g, 'http://meet.example.org/', 'media')).toBe(false)
  })
  it('drops non-grantable permissions and malformed entries', () => {
    expect(permissionAllowed(g, 'https://meet.example.org/', 'openExternal')).toBe(false)
    expect([...g.keys()]).toEqual(['https://meet.example.org'])
    expect(parseGrants('nope').size).toBe(0)
    expect(parseGrants('[]').size).toBe(0)
  })
  it('a missing policy file means deny all', () => {
    expect(loadGrants('/nonexistent', () => { throw new Error('ENOENT') }).size).toBe(0)
  })
})

describe('WSOS-SEC-006 scheme allow-list', () => {
  it.each(['https://a.example/', 'mailto:a@b.example', 'tel:+94112', 'worksuite://settings'])('allows %s', (u) => expect(externalAllowed(u)).toBe(true))
  it.each(['http://a.example/', 'file:///etc/passwd', 'javascript:alert(1)', 'data:text/html,x', 'smb://host/share', 'https://u:p@a.example/', '', 'xx'])('refuses %s', (u) => expect(externalAllowed(u)).toBe(false))
})

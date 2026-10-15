import { describe, expect, it } from 'vitest'
import { appWebPreferences, appWindows, navigationDecision, partitionFor, type AppWindowHost, type WindowLike } from './appwindows'

function fakeHost() {
  const partitions: string[] = []
  const denied: string[] = []
  const external: string[] = []
  const windows: (WindowLike & { url?: string; partition: string; nav?: (e: { preventDefault(): void }, u: string) => void; closed?: () => void; focused: number })[] = []
  const host: AppWindowHost = {
    session(p) {
      partitions.push(p)
      return { setPermissionRequestHandler: (fn) => fn(null, 'media', (ok) => { if (!ok) denied.push(p) }) }
    },
    window({ partition }) {
      const w = {
        partition, focused: 0,
        async loadURL(u: string) { w.url = u },
        focus() { w.focused++ },
        isDestroyed: () => false,
        on(_ev: 'closed', fn: () => void) { w.closed = fn },
        webContents: { on(_ev: 'will-navigate', fn: (e: { preventDefault(): void }, u: string) => void) { w.nav = fn }, setWindowOpenHandler() {} },
      } as (typeof windows)[number]
      windows.push(w)
      return w
    },
    openExternal: (u) => external.push(u),
  }
  return { host, partitions, denied, external, windows }
}

describe('per-app session partitions (WSOS-SEC-004)', () => {
  it('each app gets its own persistent partition, never the default session', () => {
    expect(partitionFor('notes')).toBe('persist:ws-app-notes')
    expect(partitionFor('chat')).not.toBe(partitionFor('notes'))
    expect(() => partitionFor('../x')).toThrow()
    expect(() => partitionFor('')).toThrow()
    expect(appWebPreferences('persist:ws-app-notes')).toMatchObject({ sandbox: true, contextIsolation: true, nodeIntegration: false })
  })

  it('opens apps in separate partitions with permissions denied; reopening focuses', () => {
    const f = fakeHost()
    const w = appWindows(f.host)
    expect(w.open('notes', 'https://notes.worksuite.test/')).toEqual({ ok: true })
    expect(w.open('chat', 'https://chat.worksuite.test/')).toEqual({ ok: true })
    expect(w.open('notes', 'https://notes.worksuite.test/')).toEqual({ ok: true })
    expect(f.windows.map((x) => x.partition)).toEqual(['persist:ws-app-notes', 'persist:ws-app-chat'])
    expect(f.denied).toEqual(['persist:ws-app-notes', 'persist:ws-app-chat'])
    expect(f.windows[0].focused).toBe(1)
    f.windows[0].closed!()
    w.open('notes', 'https://notes.worksuite.test/')
    expect(f.windows).toHaveLength(3)
  })

  it('refuses insecure URLs and bad ids', () => {
    const w = appWindows(fakeHost().host)
    expect(w.open('notes', 'http://notes.worksuite.test/')).toEqual({ ok: false, error: 'insecure_url' })
    expect(w.open('notes', 'https://u:p@notes.worksuite.test/')).toEqual({ ok: false, error: 'insecure_url' })
    expect(w.open('Notes!', 'https://notes.worksuite.test/')).toEqual({ ok: false, error: 'invalid_app' })
  })

  it('keeps navigation on the app origin', () => {
    expect(navigationDecision('https://a.test/x', 'https://a.test/y')).toBe('allow')
    expect(navigationDecision('https://a.test/x', 'https://b.test/')).toBe('external')
    expect(navigationDecision('https://a.test/x', 'file:///etc/passwd')).toBe('deny')
    expect(navigationDecision('https://a.test/x', 'javascript:alert(1)')).toBe('deny')
    const f = fakeHost()
    appWindows(f.host).open('notes', 'https://a.test/')
    let prevented = 0
    f.windows[0].nav!({ preventDefault: () => { prevented++ } }, 'https://evil.test/')
    f.windows[0].nav!({ preventDefault: () => { prevented++ } }, 'https://a.test/page')
    expect(prevented).toBe(1)
    expect(f.external).toEqual(['https://evil.test/'])
  })
})

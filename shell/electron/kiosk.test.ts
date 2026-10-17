// Kiosk mode (WSOS-AUTH-002): config parsing, the web kiosk's URL allowlist, webPreferences, blocked keys, exit codes.
import { describe, expect, it } from 'vitest'
import { blockedKey, desktopExecArgv, exitResult, isExitGesture, kioskWebPreferences, parseKioskConfig, restartDelay, screenState, tapCounter, urlAllowlist } from './kiosk'

const cfg = { app: { type: 'url' as const, url: 'https://visitors.example.com/check-in' }, allowed_urls: ['https://*.cdn.example.net', 'https://help.example.org/kiosk', 'http://insecure.example.com', 'https://*'] }
const key = (k: string, m: Partial<{ control: boolean; alt: boolean; shift: boolean; meta: boolean }> = {}) => ({ type: 'keyDown', key: k, control: false, alt: false, shift: false, meta: false, ...m })

describe('kiosk config', () => {
  it('parses the agent-written kiosk.json', () => {
    const c = parseKioskConfig(JSON.stringify({ user: 'kiosk', app: cfg.app, allowed_urls: ['https://a.example.com'], idle_reset_minutes: 10, show_on_screen_keyboard: true, exit_pin: true }))
    expect(c).toEqual({ user: 'kiosk', app: cfg.app, allowed_urls: ['https://a.example.com'], idle_reset_minutes: 10, show_on_screen_keyboard: true, exit_pin: true })
    expect(parseKioskConfig(JSON.stringify({ user: 'kiosk', app: { type: 'module', id: 'calendar' } }))?.app).toEqual({ type: 'module', id: 'calendar' })
  })
  it('refuses anything unexpected', () => {
    for (const app of [{ type: 'url', url: 'http://x.example.com' }, { type: 'url', url: 'file:///etc/passwd' }, { type: 'module', id: 'terminal' }, { type: 'desktop', id: '../sh' }, { type: 'exec' }])
      expect(parseKioskConfig(JSON.stringify({ user: 'kiosk', app }))).toBeNull()
    expect(parseKioskConfig('not json')).toBeNull()
  })
})

describe('web kiosk URL allowlist', () => {
  const allowed = urlAllowlist(cfg)
  it('allows the start site and the policy patterns', () => {
    expect(allowed('https://visitors.example.com/check-in')).toBe(true)
    expect(allowed('https://visitors.example.com/other/page?x=1')).toBe(true)
    expect(allowed('https://img.cdn.example.net/a.png')).toBe(true)
    expect(allowed('https://a.b.cdn.example.net/')).toBe(true)
    expect(allowed('https://help.example.org/kiosk')).toBe(true)
    expect(allowed('https://help.example.org/kiosk/faq')).toBe(true)
  })
  it('blocks everything else', () => {
    expect(allowed('http://visitors.example.com/check-in')).toBe(false)          // not https
    expect(allowed('https://evil.example.com/')).toBe(false)
    expect(allowed('https://visitors.example.com.evil.net/')).toBe(false)
    expect(allowed('https://cdn.example.net/')).toBe(false)                      // *.host is subdomains only
    expect(allowed('https://help.example.org/kiosk-admin')).toBe(false)          // path prefix on segment boundaries
    expect(allowed('https://help.example.org/')).toBe(false)
    expect(allowed('https://visitors.example.com:8443/')).toBe(false)            // other port
    expect(allowed('https://user:pw@visitors.example.com/')).toBe(false)
    expect(allowed('http://insecure.example.com/')).toBe(false)                  // http pattern ignored
    expect(allowed('file:///etc/passwd')).toBe(false)
    expect(allowed('javascript:alert(1)')).toBe(false)
    expect(allowed('chrome://settings')).toBe(false)
    expect(allowed('devtools://devtools/bundled/inspector.html')).toBe(false)
    expect(allowed('data:text/html,hi')).toBe(false)
    expect(allowed('not a url')).toBe(false)
  })
})

describe('web kiosk lockdown', () => {
  it('webPreferences: sandboxed, no Node, no devtools, in-memory profile per generation', () => {
    const p = kioskWebPreferences('/p.cjs', 3)
    expect(p).toMatchObject({ sandbox: true, contextIsolation: true, nodeIntegration: false, devTools: false, webviewTag: false, partition: 'kiosk-3' })
    expect(p.partition.startsWith('persist:')).toBe(false)
    expect(kioskWebPreferences('/p.cjs', 4).partition).not.toBe(p.partition)
  })
  it('blocks browser shortcuts but not typing', () => {
    for (const k of [key('F12'), key('F5'), key('F11'), key('i', { control: true, shift: true }), key('r', { control: true }), key('w', { control: true }), key('n', { control: true }),
      key('p', { control: true }), key('s', { control: true }), key('ArrowLeft', { alt: true }), key('F4', { alt: true }), key('d', { meta: true }), key('Meta', { meta: true }), key('+', { control: true })])
      expect(blockedKey(k), JSON.stringify(k)).toBe(true)
    for (const k of [key('a'), key('A', { shift: true }), key('Enter'), key('Backspace'), key('Tab'), key('Escape'), key('ArrowLeft'), key('c', { control: true }), key('v', { control: true }), key('a', { control: true })])
      expect(blockedKey(k), JSON.stringify(k)).toBe(false)
  })
  it('recognises the exit gesture', () => {
    expect(isExitGesture(key('K', { control: true, alt: true, shift: true }))).toBe(true)
    expect(isExitGesture(key('k', { control: true, alt: true }))).toBe(false)
    expect(isExitGesture({ ...key('k', { control: true, alt: true, shift: true }), type: 'keyUp' })).toBe(false)
  })
  it('five taps in the corner within 3 s', () => {
    let now = 0
    const tap = tapCounter(() => now)
    for (let i = 0; i < 4; i++) { expect(tap(10, 10)).toBe(false); now += 500 }
    expect(tap(10, 10)).toBe(true)
    for (let i = 0; i < 4; i++) { tap(10, 10); now += 1000 }
    expect(tap(10, 10)).toBe(false)              // too slow: older taps dropped
    expect(tap(300, 10)).toBe(false)             // outside the corner resets
  })
})

describe('kiosk app supervision and exit', () => {
  it('exit helper codes', () => {
    expect([0, 3, 4, 5, 126, 127, 1, null].map(exitResult)).toEqual(['ok', 'wrong_pin', 'locked_out', 'pin_disabled', 'cancelled', 'cancelled', 'failed', 'failed'])
  })
  it('restart back-off', () => {
    expect([1, 2, 3, 6, 20].map(restartDelay)).toEqual([1000, 2000, 4000, 30_000, 30_000])
  })
  it('desktop Exec lines become argv without a shell', () => {
    expect(desktopExecArgv('/usr/bin/viewer --kiosk %U')).toEqual(['/usr/bin/viewer', '--kiosk'])
    expect(desktopExecArgv('"/opt/My App/app" --title "a b" 100%%')).toEqual(['/opt/My App/app', '--title', 'a b', '100%'])
    expect(desktopExecArgv('sh -c "rm -rf ~"')).toBeNull()
    expect(desktopExecArgv('env FOO=1 app')).toBeNull()
    expect(desktopExecArgv('')).toBeNull()
  })
})

describe('night screen-off notice', () => {
  it('reads only "off HH:MM" from worksuite-kiosk-ctl', () => {
    expect(screenState('off 07:00\n')).toBe('07:00')
    expect(screenState('on\n')).toBeNull()
    expect(screenState('off 7:00')).toBeNull()
    expect(screenState('off 07:00; reboot')).toBeNull()
    expect(screenState('')).toBeNull()
  })
})

// Renderer → system boundary (SRS §13.1 security layer). Static checks over the Electron main-process sources:
// WSOS-ARC-001 (main runs as the user and is not a general root command runner) and WSOS-ARC-003 (native apps stay
// independent compositor windows; nothing embeds foreign windows in React).
import { readFileSync, readdirSync } from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'

const dir = __dirname
const sources = readdirSync(dir).filter((f) => f.endsWith('.ts') && !f.endsWith('.test.ts'))
const read = (f: string) => readFileSync(path.join(dir, f), 'utf8')
const all = sources.map((f) => [f, read(f)] as const)
const repo = path.resolve(dir, '../..')

describe('WSOS-ARC-001: Electron main is not a root command runner', () => {
  it('has main-process sources to check', () => {
    expect(sources).toContain('main.ts')
    expect(sources.length).toBeGreaterThan(10)
  })

  it('never runs a shell: no exec/execSync, no shell: true, no sh -c', () => {
    for (const [f, s] of all) {
      expect(s, f).not.toMatch(/\bimport\s*\{[^}]*\bexec(Sync)?\b[^}]*\}\s*from\s*'node:child_process'/)
      expect(s, f).not.toMatch(/\bexecSync\s*\(|\bspawnSync\s*\(/)
      expect(s, f).not.toMatch(/shell:\s*true/)
      expect(s, f).not.toMatch(/'(?:ba|da|z)?sh',\s*\[\s*'-c'/)
    }
  })

  it('elevates only through the kiosk-exit helper; enrollment and sign-in methods are D-Bus methods behind polkit', () => {
    const elevations: string[] = []
    for (const [f, s] of all) {
      expect(s, f).not.toMatch(/['"`](sudo|doas|su|runuser|setpriv)['"`]\s*,/)
      for (const m of s.matchAll(/['"`]pkexec['"`]\s*,\s*\[\s*'([^']+)'/g)) elevations.push(`${f}:${m[1]}`)
      // pkexec with a computed program would make it a general runner
      expect(s, f).not.toMatch(/['"`]pkexec['"`]\s*,\s*\[\s*[^'\s]/)
    }
    // kioskMain.ts: leaving kiosk mode (PIN or administrator password, polkit lk.worksuite.kiosk.exit-*).
    // Enrollment is lk.worksuite.DeviceAgent1.Enroll (polkit lk.worksuite.device.enroll, WSOS-ARC-002), not pkexec.
    expect(all.find(([f]) => f === 'device.ts')?.[1]).toMatch(/getInterface\('lk\.worksuite\.DeviceAgent1'\)\.Enroll\(/)
    // Sign-in methods are lk.worksuite.SignIn1 methods (polkit lk.worksuite.signin.manage).
    expect(all.find(([f]) => f === 'signin.ts')?.[1]).toMatch(/getInterface\('lk\.worksuite\.SignIn1'\)/)
    // sessionHost.ts: Settings › About › Diagnostics, the system journal and the boot-details entry, through the fixed
    // helper behind polkit lk.worksuite.diagnostics (auth_admin_keep); its arguments are checked there and here.
    // "Restart anyway": always the fixed helper behind lk.worksuite.power-force, which
    // accepts only reboot|poweroff (tests/session/session-test.sh).
    // printers.ts: Settings › Printers when cupsd refuses the person, the fixed helper behind lk.worksuite.printers;
    // it re-checks every argument (tests/session/printer-admin.test.sh).
    expect(elevations.sort()).toEqual(['kioskMain.ts:/usr/lib/worksuite/worksuite-kiosk-exit', 'printers.ts:/usr/lib/worksuite/worksuite-printer-admin', 'sessionHost.ts:/usr/lib/worksuite/worksuite-diagnostics', 'sessionHost.ts:/usr/lib/worksuite/worksuite-diagnostics', 'sessionHost.ts:/usr/lib/worksuite/worksuite-power-force'])
  })

  it('every IPC handler goes through the sender check', () => {
    for (const [f, s] of all) {
      const raw = [...s.matchAll(/ipcMain\.(handle|on|once|handleOnce)\(/g)]
      if (f === 'main.ts') {
        expect(raw.length, f).toBe(1)
        expect(s).toMatch(/ipcMain\.handle\(channel, \(e, \.\.\.args\) => \{\s*if \(!validSender\(e\)\) throw new Error\('Rejected IPC sender'\)/)
        expect(s).toMatch(/shellContents\.has\(e\.sender\) && e\.senderFrame\?\.url\.startsWith\('file:\/\/'\) === true/)
      } else if (f === 'kioskMain.ts') {
        // The kiosk app is its own main process: each handler checks the sender window itself.
        for (const m of s.matchAll(/ipcMain\.(?:handle|on)\('[^']+', (?:async )?\(e[^)]*\) => \{?\s*(.{0,60})/g))
          expect(m[1], f).toMatch(/^(if \(!?fromPrompt\(e\)|\(?fromPrompt\(e\)|if \(main && e\.sender === main\.webContents\))/)
        expect(raw.length, f).toBe([...s.matchAll(/ipcMain\.(?:handle|on)\('[^']+', (?:async )?\(e/g)].length)
      } else if (f === 'whatsappwindow.ts') {
        // WhatsApp window: one bare "focus" message, accepted only from its own window's page.
        expect(raw.length, f).toBe(1)
        expect(s).toMatch(/ipcMain\.on\(WHATSAPP_FOCUS_CHANNEL, \(e\) => \{ if \(win && e\.sender === win\.webContents\) focus\(\) \}\)/)
      } else if (f === 'remoteSupport.ts') {
        // Remote support capture window (issues #19, #37): messages accepted only from that hidden window's own page.
        expect(s).toMatch(/const from = \(e: Electron\.IpcMainEvent\) => wc !== null && e\.sender === wc/)
        const on = [...s.matchAll(/ipcMain\.on\('rs:[a-z-]+', \(e[^)]*\) => \{ if \(from\(e\)\)/g)]
        expect(raw.length, f).toBe(on.length)
        expect(on.length, f).toBe(7)
      } else expect(raw.length, f).toBe(0)
    }
  })

  it('every window is sandboxed with context isolation and no node integration', () => {
    const main = read('main.ts')
    expect(main).toMatch(/const shellPrefs = \(\) => shellWebPreferences\(/)
    expect(read('webSecurity.ts')).toMatch(/sandbox: true, contextIsolation: true, nodeIntegration: false/)
    for (const [f, s] of all) {
      expect(s, f).not.toMatch(/nodeIntegration:\s*true|contextIsolation:\s*false|sandbox:\s*false|webSecurity:\s*false/)
    }
  })

  it('the shell runs as a systemd user unit, never as root', () => {
    const unit = readFileSync(path.join(repo, 'services/session/systemd/user/worksuite-shell.service'), 'utf8')
    expect(unit).not.toMatch(/^User=root/m)
    expect(unit).toMatch(/^ExecStart=/m)
  })
})

describe('WSOS-ARC-003: native apps stay independent compositor windows', () => {
  it('no foreign-window embedding API is used', () => {
    for (const [f, s] of all) {
      expect(s, f).not.toMatch(/\bBrowserView\b|\bWebContentsView\b|webviewTag:\s*true|setParentWindow|XReparentWindow|xdotool|xembed|--parent-window/i)
    }
  })

  it('native .desktop apps are handed to the compositor through gtk-launch in their own scope', () => {
    const launch = all.filter(([, s]) => /'gtk-launch'/.test(s)).map(([f]) => f)
    expect(launch.length).toBeGreaterThan(0)
    const main = read('main.ts')
    expect(main).toMatch(/handle\('ws:launchApp', \(id\) => \{ const c = appLaunchCommand\(id\); return c \? run\(\.\.\.c\) : undefined \}\)/)
  })

  it('the compositor (labwc) manages every toplevel itself', () => {
    const rc = readFileSync(path.join(repo, 'services/session/labwc/rc.xml'), 'utf8')
    expect(rc).toMatch(/<labwc_config/)
  })
})

describe('WSOS-ARC-004: the desktop needs no remote service to start', () => {
  it('shell windows load the bundled UI from disk, never from a URL', () => {
    const main = read('main.ts')
    const shellLoads = [...main.matchAll(/void (?:w|win)\.load(File|URL)\(([^)]*)/g)].filter((m) => /index\.html/.test(m[2]))
    expect(shellLoads.length).toBeGreaterThanOrEqual(2)
    for (const m of shellLoads) expect(m[1]).toBe('File')
  })

  it('the renderer may only load its own bundled resources', () => {
    const html = readFileSync(path.join(repo, 'shell/index.html'), 'utf8')
    const csp = /Content-Security-Policy" content="([^"]+)"/.exec(html)?.[1] ?? ''
    for (const d of ['default-src', 'script-src', 'connect-src']) expect(csp).toMatch(new RegExp(`${d} 'self'(;|$)`))
    expect(html).not.toMatch(/<(script|link)[^>]+(src|href)="https?:/)
  })

  it('the CI boot test runs the image with no network device', () => {
    expect(readFileSync(path.join(repo, 'tests/vm/boot-test.sh'), 'utf8')).toMatch(/-nic none/)
  })
})

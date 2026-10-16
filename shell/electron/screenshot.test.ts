// The screenshot shortcut's portal client against a fake org.freedesktop.portal.Screenshot on a private D-Bus
// session bus, plus the Labwc key bindings (WSOS-DSK-011).
import { spawn, spawnSync, type ChildProcess } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import dbus from 'dbus-next'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { requestPath, screenshotName, takeScreenshot } from './screenshot'

const { Message, Variant } = dbus

describe('screenshot helpers', () => {
  it('builds the portal request path from the unique name', () => {
    expect(requestPath(':1.42', 'ws1')).toBe('/org/freedesktop/portal/desktop/request/1_42/ws1')
    expect(screenshotName(new Date(2026, 9, 15, 9, 5, 7))).toBe('Screenshot 2026-10-15 09-05-07.png')
  })
})

const haveDbus = spawnSync('sh', ['-c', 'command -v dbus-daemon']).status === 0
describe.skipIf(!haveDbus)('portal round trip on a private bus', () => {
  let daemon: ChildProcess
  let address = ''
  let portal: InstanceType<typeof dbus.MessageBus>
  const dir = mkdtempSync(path.join(os.tmpdir(), 'shot-'))
  const src = path.join(dir, 'portal-output.png')
  writeFileSync(src, 'PNGDATA')
  let answer: { code: number; interactive?: boolean } = { code: 0 }

  beforeAll(async () => {
    daemon = spawn('dbus-daemon', ['--session', '--nofork', '--print-address=1'], { stdio: ['ignore', 'pipe', 'ignore'] })
    address = await new Promise<string>((resolve) => daemon.stdout!.once('data', (d) => resolve(String(d).trim())))
    portal = dbus.sessionBus({ busAddress: address })
    await portal.requestName('org.freedesktop.portal.Desktop', 0)
    portal.addMethodHandler((msg: InstanceType<typeof Message>) => {
      if (msg.interface !== 'org.freedesktop.portal.Screenshot' || msg.member !== 'Screenshot') return false
      const [, opts] = msg.body as [string, Record<string, InstanceType<typeof Variant>>]
      answer.interactive = opts.interactive?.value as boolean
      const req = requestPath(msg.sender!, opts.handle_token.value as string)
      portal.send(Message.newMethodReturn(msg, 'o', [req]))
      setTimeout(() => portal.send(Message.newSignal(req, 'org.freedesktop.portal.Request', 'Response', 'ua{sv}',
        [answer.code, answer.code === 0 ? { uri: new Variant('s', pathToFileURL(src).toString()) } : {}])), 20)
      return true
    })
  })
  afterAll(() => { portal?.disconnect(); daemon?.kill() })

  it('saves the portal screenshot into Pictures/Screenshots', async () => {
    const bus = dbus.sessionBus({ busAddress: address })
    answer = { code: 0 }
    const r = await takeScreenshot(bus, true, path.join(dir, 'Pictures'), new Date(2026, 0, 2, 3, 4, 5), 5000)
    bus.disconnect()
    expect(answer.interactive).toBe(true)
    expect(r).toEqual({ ok: true, file: path.join(dir, 'Pictures', 'Screenshots', 'Screenshot 2026-01-02 03-04-05.png') })
    expect(readFileSync((r as { file: string }).file, 'utf8')).toBe('PNGDATA')
  })

  it('reports a cancelled selection and saves nothing', async () => {
    const bus = dbus.sessionBus({ busAddress: address })
    answer = { code: 1 }
    const r = await takeScreenshot(bus, false, path.join(dir, 'P2'), new Date(), 5000)
    bus.disconnect()
    expect(r).toEqual({ ok: false, error: 'cancelled' })
    expect(existsSync(path.join(dir, 'P2', 'Screenshots'))).toBe(false)
  })
})

describe('Labwc key bindings (WSOS-DSK-011)', () => {
  const rc = readFileSync(path.join(__dirname, '../../services/session/labwc/rc.xml'), 'utf8')
  const bind = (key: string) => new RegExp(`<keybind key="${key}"[^>]*>([\\s\\S]*?)</keybind>`).exec(rc)?.[1] ?? ''
  it('covers launcher, window switch, lock, workspaces and screenshot', () => {
    expect(bind('Super_L')).toContain('ToggleLauncher')
    expect(bind('A-Tab')).toContain('NextWindow')
    expect(bind('W-l')).toContain('loginctl lock-session')
    for (const n of [1, 2, 3, 4]) {
      expect(bind(`W-${n}`)).toContain(`<action name="GoToDesktop" to="${n}"`)
      expect(bind(`W-S-${n}`)).toContain(`<action name="SendToDesktop" to="${n}"`)
    }
    expect(bind('C-A-Left')).toContain('GoToDesktop" to="left"')
    expect(bind('C-A-Right')).toContain('GoToDesktop" to="right"')
    expect(bind('Print')).toContain('command="worksuite-screenshot"')
    expect(bind('S-Print')).toContain('command="worksuite-screenshot --interactive"')
    expect(rc).toMatch(/<desktops number="4"/)
  })
})

describe('shell on every workspace', () => {
  it('Labwc rule for the shell app_id makes it omnipresent, and main sets that app_id', () => {
    const rc = readFileSync(path.join(__dirname, '../../services/session/labwc/rc.xml'), 'utf8')
    expect(rc).toMatch(/<windowRule identifier="worksuite-shell"[^>]*>\s*<action name="ToggleOmnipresent"\/>/)
    const main = readFileSync(path.join(__dirname, 'main.ts'), 'utf8')
    expect(main).toContain("SHELL_APP_ID = 'worksuite-shell'")
    expect(main).toContain('setDesktopName?.(`${SHELL_APP_ID}.desktop`)')
  })
})

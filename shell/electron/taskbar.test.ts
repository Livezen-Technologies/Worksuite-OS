import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { extractTaskbarBlock, fullscreenOutputs, mergeTaskbarBlock, taskbarBounds, taskbarHost, taskbarRulesBlock, taskbarTitle, type TaskbarWindow } from './taskbar'
import { carryDesktops } from './touch'

const RECTS = [{ name: 'eDP-1', x: 0, y: 0, width: 1280, height: 800 }, { name: 'HDMI-A-1', x: 1280, y: 0, width: 1920, height: 1080 }]
const tick = () => new Promise((r) => setTimeout(r, 0))

describe('taskbar windows (#53)', () => {
  it('places the taskbar of each output at its bottom edge, full width', () => {
    expect(taskbarBounds(RECTS[0], 52)).toEqual({ x: 0, y: 748, width: 1280, height: 52 })
    expect(taskbarBounds(RECTS[1], 64)).toEqual({ x: 1280, y: 1016, width: 1920, height: 64 })
    const block = taskbarRulesBlock(RECTS, 52)
    expect(block).toContain(`title="${taskbarTitle('eDP-1')}"`)
    expect(block).toContain('<action name="MoveTo" x="0" y="748"/>')
    expect(block).toContain('<action name="MoveTo" x="1280" y="1028"/>')
    // An odd output name never reaches rc.xml.
    expect(taskbarRulesBlock([{ ...RECTS[0], name: 'x"/><y' }], 52)).not.toContain('x"')
  })
  it('keeps one block in rc.xml, carried through the touch settings rewrite', () => {
    const rc = '<labwc_config>\n  <windowRules/>\n</labwc_config>\n'
    const a = mergeTaskbarBlock(rc, taskbarRulesBlock(RECTS, 52))
    const b = mergeTaskbarBlock(a, taskbarRulesBlock(RECTS, 64))
    expect(b.match(/worksuite-taskbar:begin/g)).toHaveLength(1)
    expect(extractTaskbarBlock(b)).toContain('y="736"')
    expect(b.indexOf('worksuite-taskbar:end')).toBeLessThan(b.indexOf('</labwc_config>'))
    expect(mergeTaskbarBlock(b, null)).toBe(rc)
    expect(carryDesktops(b, rc)).toBe(b)
  })
  it('the system rc.xml keeps the taskbar windows on top, undecorated and off the window lists', () => {
    const sys = readFileSync(new URL('../../services/session/labwc/rc.xml', import.meta.url), 'utf8')
    const rule = /<windowRule identifier="worksuite-shell" title="WorkSuite taskbar \*"([^>]*)>([\s\S]*?)<\/windowRule>/.exec(sys)
    expect(rule).not.toBeNull()
    for (const p of ['serverDecoration="no"', 'skipTaskbar="yes"', 'skipWindowSwitcher="yes"', 'fixedPosition="yes"']) expect(rule![1]).toContain(p)
    expect(rule![2]).toContain('ToggleAlwaysOnTop')
    // after the shell's always-on-bottom rule, which it undoes
    expect(sys.indexOf('title="WorkSuite taskbar *"')).toBeGreaterThan(sys.indexOf('<windowRule identifier="worksuite-shell" serverDecoration="yes">'))
    // lowering the shell acts on its decorated full-screen windows only, never on a taskbar window
    for (const k of ['C-A-W-F23', 'C-A-W-F22', 'C-A-W-F21']) {
      const line = sys.split('\n').find((l) => l.includes(`key="${k}"`))!
      for (const q of line.match(/<query [^>]*>/g)!) expect(q).toContain('decoration="full"')
    }
  })
  it('full-screen app windows only', () => {
    const w = [{ appId: 'firefox', output: 'eDP-1', flags: 1 | 8 }, { appId: 'worksuite-shell', output: 'HDMI-A-1', flags: 1 | 8 }, { appId: 'mpv', output: 'HDMI-A-1', flags: 8 }]
    expect([...fullscreenOutputs(w)]).toEqual(['eDP-1'])
  })
  it('writes the rules, then makes one window per output; follows height, full screen and the desktop', async () => {
    const log: string[] = []
    const wins = new Map<string, { visible: boolean }>()
    const make = (r: { name: string }, b: { y: number; height: number }) => {
      const st = { visible: true }
      wins.set(r.name, st); log.push(`make ${r.name} y=${b.y} h=${b.height}`)
      const w: TaskbarWindow = { show: () => { st.visible = true; log.push(`show ${r.name}`) }, hide: () => { st.visible = false; log.push(`hide ${r.name}`) }, close: () => { log.push(`close ${r.name}`) }, isVisible: () => st.visible }
      return w
    }
    const refocused: string[] = []
    const h = taskbarHost({ writeRules: async (b) => { log.push(`rules ${(b.match(/MoveTo/g) ?? []).length}`); return true }, make, refocus: (x) => refocused.push(x) })
    await h.setOutputs(RECTS)
    expect(log).toEqual([])                       // not before the desktop shows (sign-in, lock, installer)
    await h.setWanted(true)
    expect(log).toEqual(['rules 2', 'make eDP-1 y=748 h=52', 'make HDMI-A-1 y=1028 h=52'])
    log.length = 0
    await h.setHeight(64)                         // touch mode
    expect(log).toEqual(['rules 2', 'close eDP-1', 'close HDMI-A-1', 'make eDP-1 y=736 h=64', 'make HDMI-A-1 y=1016 h=64'])
    log.length = 0
    // A video goes full screen on eDP-1: that taskbar gives way, and comes back after; the app keeps the keyboard.
    await h.setWindows([{ handle: 'v', appId: 'mpv', output: 'eDP-1', flags: 1 | 8 }])
    expect(log).toEqual(['hide eDP-1'])
    await h.setWindows([{ handle: 'v', appId: 'mpv', output: 'eDP-1', flags: 1 }])
    expect(log).toEqual(['hide eDP-1', 'show eDP-1'])
    expect(refocused).toEqual(['v'])
    log.length = 0
    await h.setWanted(false)
    expect(log).toEqual(['close eDP-1', 'close HDMI-A-1'])
    expect(h.names()).toEqual([])
  })
  it('without rules (rc.xml not writable) no taskbar window is made: the taskbar of the shell window shows', async () => {
    const made: string[] = []
    const h = taskbarHost({ writeRules: async () => false, make: (r) => { made.push(r.name); return null }, refocus: () => undefined })
    await h.setOutputs(RECTS); await h.setWanted(true); await tick()
    expect(made).toEqual([])
  })
})

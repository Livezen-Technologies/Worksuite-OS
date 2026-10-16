import { mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync, symlinkSync, lstatSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  DEFAULT_GESTURES, DEFAULT_TOUCH, hasTabletModeBit, labwcTouchBlock, loadTouch, mergeRcXml, normalizeTouch, oskArgs, oskLayouts, oskWanted, parseLibinputDevices,
  parseOrientation, parsePenLine, parseSwitchLine, parseUdevProps, saveTouch, touchBridge, touchModeOn, type Spawn,
} from './touch'
import type { Exec } from './system'

const LIST = `Device:           Power Button
Kernel:           /dev/input/event2
Capabilities:     keyboard

Device:           Intel HID switches
Kernel:           /dev/input/event4
Group:            4
Capabilities:     switch
Tap-to-click:     n/a

Device:           ELAN9008:00 04F3:2C82
Kernel:           /dev/input/event9
Capabilities:     touch
Calibration:      identity matrix

Device:           ELAN9008:00 04F3:2C82 Stylus
Kernel:           /dev/input/event10
Capabilities:     tablet
`

const dirs: string[] = []
const tmp = () => { const d = mkdtempSync(path.join(tmpdir(), 'ws-touch-')); dirs.push(d); return d }
afterEach(() => { while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true }) })

describe('parsers', () => {
  it('reads libinput list-devices', () => {
    const d = parseLibinputDevices(LIST)
    expect(d.map((x) => [x.name, x.kinds])).toEqual([
      ['Intel HID switches', ['switch']], ['ELAN9008:00 04F3:2C82', ['touchscreen']], ['ELAN9008:00 04F3:2C82 Stylus', ['tablet']],
    ])
    expect(d[0].tabletModeSwitch).toBe(true)
    expect(d[1].node).toBe('/dev/input/event9')
  })
  it('reads udev properties and the SW_TABLET_MODE bit', () => {
    expect(parseUdevProps('/dev/input/event9', 'ID_INPUT=1\nID_INPUT_TOUCHSCREEN=1\nNAME="ELAN\\x20Touch"\n')).toEqual({ name: 'ELAN Touch', node: '/dev/input/event9', kinds: ['touchscreen'], tabletModeSwitch: false })
    expect(parseUdevProps('/dev/input/event1', 'ID_INPUT=1\nID_INPUT_KEYBOARD=1\n')).toBeNull()
    expect(hasTabletModeBit('2')).toBe(true)
    expect(hasTabletModeBit('1')).toBe(false)
  })
  it('reads switch, pen and orientation lines', () => {
    expect(parseSwitchLine(' event4   SWITCH_TOGGLE           +2.101s\tswitch tablet-mode state 1')).toEqual({ switch: 'tablet-mode', on: true })
    expect(parseSwitchLine(' event4   SWITCH_TOGGLE           +9.0s\tswitch tablet-mode state 0')).toEqual({ switch: 'tablet-mode', on: false })
    expect(parseSwitchLine(' event3   KEYBOARD_KEY  +1s  KEY_A (30) pressed')).toBeNull()
    expect(parsePenLine(' event10  TABLET_TOOL_AXIS  +3.2s\t\t12.30/40.10\tpressure: 0.53')).toEqual({ pressure: 0.53 })
    expect(parsePenLine(' event10  TABLET_TOOL_BUTTON  +3.3s\t331 (BTN_STYLUS), pressed, seat count: 1')).toEqual({ button: 'BTN_STYLUS', pressed: true })
    expect(parsePenLine(' event10  TABLET_TOOL_PROXIMITY  +1s pen (0x1) proximity-in')).toEqual({ proximity: true })
    expect(parseOrientation('=== Has accelerometer (orientation: normal)')).toBe('normal')
    expect(parseOrientation('    Accelerometer orientation changed: left-up')).toBe('left-up')
  })
})

describe('settings', () => {
  it('normalises bad input and persists', () => {
    expect(normalizeTouch({ osk: 'nope', tabletMode: 'on', mapToOutput: { 'ELAN Touch': 'eDP-1', 'bad"<name': 'x', ok: 'bad name;' } }))
      .toEqual({ ...DEFAULT_TOUCH, tabletMode: 'on', mapToOutput: { 'ELAN Touch': 'eDP-1' } })
    const f = path.join(tmp(), 'worksuite', 'touch.json')
    expect(loadTouch(f)).toEqual(DEFAULT_TOUCH)
    saveTouch(f, { ...DEFAULT_TOUCH, osk: 'always', oskSize: 'large' })
    expect(loadTouch(f)).toMatchObject({ osk: 'always', oskSize: 'large' })
  })
  it('decides touch mode and the keyboard', () => {
    expect(touchModeOn(DEFAULT_TOUCH, true)).toBe(true)
    expect(touchModeOn(DEFAULT_TOUCH, false)).toBe(false)
    expect(touchModeOn({ ...DEFAULT_TOUCH, tabletMode: 'off' }, true)).toBe(false)
    expect(oskWanted(DEFAULT_TOUCH, false)).toBe(false)
    expect(oskWanted({ ...DEFAULT_TOUCH, osk: 'always' }, false)).toBe(true)
    expect(oskWanted({ ...DEFAULT_TOUCH, osk: 'off' }, true)).toBe(false)
  })
  it('picks wvkbd layouts from fcitx5 methods (Sinhala/Tamil use the Latin layout)', () => {
    expect(oskLayouts(['keyboard-us', 'm17n_si_wijesekara', 'keyboard-ru'])).toEqual(['full', 'cyrillic', 'special'])
    expect(oskArgs({ ...DEFAULT_TOUCH, oskSize: 'large' }, [])).toEqual(expect.arrayContaining(['--hidden', '-H', '340', '-l', 'full,special', '--bg', '071330f7', '--press', '2a4a8f']))
  })
})

describe('Labwc config writer', () => {
  const RC = '<?xml version="1.0"?>\n<labwc_config>\n  <core />\n</labwc_config>\n'
  it('writes sendEventsMode and mapToOutput, and replaces an earlier block', () => {
    const b = labwcTouchBlock({ ...DEFAULT_TOUCH, touchEnabled: false, mapToOutput: { 'ELAN Touch': 'eDP-1' } }, ['ELAN Touch'])
    expect(b).toContain('<touch deviceName="ELAN Touch" mapToOutput="eDP-1" mouseEmulation="no" />')
    expect(b).toContain('<device category="ELAN Touch"><sendEventsMode>no</sendEventsMode></device>')
    const once = mergeRcXml(RC, b)
    expect(once.indexOf(b)).toBeLessThan(once.indexOf('</labwc_config>'))
    const twice = mergeRcXml(once, labwcTouchBlock(DEFAULT_TOUCH, ['ELAN Touch']))
    expect(twice.match(/worksuite-touch:begin/g)).toHaveLength(1)
    expect(twice).toContain('<sendEventsMode>yes</sendEventsMode>')
    expect(twice).not.toContain('mapToOutput')
  })
  it('writes a calibration matrix and drops unusable ones', () => {
    const m = [1.02, 0, -0.01, 0, 0.98, 0.015]
    expect(normalizeTouch({ calibration: { 'ELAN Touch': m, bad: [1, 2, 3], huge: [9, 0, 0, 0, 1, 0], 'x"<': m } }).calibration).toEqual({ 'ELAN Touch': m })
    expect(labwcTouchBlock({ ...DEFAULT_TOUCH, calibration: { 'ELAN Touch': m } }, ['ELAN Touch']))
      .toContain('<device category="ELAN Touch"><sendEventsMode>yes</sendEventsMode><calibrationMatrix>1.02 0 -0.01 0 0.98 0.015</calibrationMatrix></device>')
  })
  it('skips unsafe device names', () => {
    expect(labwcTouchBlock(DEFAULT_TOUCH, ['evil"/><x'])).not.toContain('evil')
  })
  it('bridge writes the user rc.xml over the session symlink and reloads Labwc', async () => {
    const home = tmp(), sys = tmp()
    writeFileSync(path.join(sys, 'rc.xml'), RC)
    const ldir = path.join(home, '.config', 'worksuite', 'labwc'); mkdirSync(ldir, { recursive: true })
    symlinkSync(path.join(sys, 'rc.xml'), path.join(ldir, 'rc.xml'))
    const calls: string[] = []
    const exec: Exec = async (cmd, args) => {
      calls.push([cmd, ...args].join(' '))
      if (cmd === 'libinput') return { code: 0, stdout: LIST, stderr: '' }
      if (cmd === 'wlr-randr') return { code: 0, stdout: '[{"name":"eDP-1"},{"name":"HDMI-A-1"}]', stderr: '' }
      return { code: 0, stdout: '', stderr: '' }
    }
    const lines: Record<string, (l: string) => void> = {}
    const spawned: string[] = []
    const sp: Spawn = (cmd, args) => { spawned.push([cmd, ...args].join(' ')); return { kill: (sig) => { spawned.push(`kill ${cmd} ${sig ?? ''}`) }, onLine: (cb) => { lines[cmd] = cb }, onExit: () => {} } }
    const b = touchBridge(home, exec, sp, sys)
    await b.start()
    expect(lstatSync(path.join(ldir, 'rc.xml')).isSymbolicLink()).toBe(false)
    expect(readFileSync(path.join(sys, 'rc.xml'), 'utf8')).toBe(RC)
    const r = await b.set(JSON.stringify({ touchEnabled: false }))
    expect(r.available).toBe(true)
    expect(readFileSync(path.join(ldir, 'rc.xml'), 'utf8')).toContain('<sendEventsMode>no</sendEventsMode>')
    expect(calls).toContain('labwc --reconfigure')
    expect(JSON.parse(readFileSync(path.join(home, '.config', 'worksuite', 'touch.json'), 'utf8')).touchEnabled).toBe(false)
    expect(spawned).toContain('libinput debug-events --device /dev/input/event4')
    // Folding the convertible turns touch mode on and rotation follows the sensor.
    lines['monitor-sensor']('    Accelerometer orientation changed: left-up')
    lines.libinput(' event4 SWITCH_TOGGLE +1s switch tablet-mode state 1')
    await new Promise((r) => setTimeout(r, 0))
    expect((await b.state()).available && (await b.state() as { value: { touchMode: boolean } }).value.touchMode).toBe(true)
    expect(calls).toContain('wlr-randr --output eDP-1 --transform 90')
    expect(b.osk(true)).toEqual({ available: true, value: true })
    expect(spawned).toContain('kill wvkbd-mobintl SIGUSR2')
    // Gestures: the daemon runs with a touchscreen, re-reads its file on a change and stops when turned off.
    const gfile = path.join(home, '.config', 'worksuite', 'gestures.json')
    expect(spawned).toContain('/usr/lib/worksuite/worksuite-gestures')
    expect(JSON.parse(readFileSync(gfile, 'utf8')).edgeBottom).toBe('launcher')
    await b.set(JSON.stringify({ touchEnabled: true, gestures: { ...DEFAULT_GESTURES, threeHorizontal: 'switch-apps' }, longPressMs: 800 }))
    expect(JSON.parse(readFileSync(gfile, 'utf8')).threeHorizontal).toBe('switch-apps')
    await b.set(JSON.stringify({ longPressMs: 900 }))
    expect(spawned).toContain('kill /usr/lib/worksuite/worksuite-gestures SIGHUP')
    await b.set(JSON.stringify({ gestures: { ...DEFAULT_GESTURES, enabled: false } }))
    expect(spawned).toContain('kill /usr/lib/worksuite/worksuite-gestures SIGTERM')
  })
  it('gesture settings: only known choices, long-press delay 300–1200 ms', () => {
    const n = normalizeTouch({ gestures: { edgeBottom: 'off', threeHorizontal: 'rm -rf', edgeSwipes: false }, longPressMs: 5000 })
    expect(n.gestures).toEqual({ ...DEFAULT_GESTURES, edgeBottom: 'off', edgeSwipes: false })
    expect(n.longPressMs).toBe(600)
    expect(normalizeTouch({ longPressMs: 900 }).longPressMs).toBe(900)
  })
})

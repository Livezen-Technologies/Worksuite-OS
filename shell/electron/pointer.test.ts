import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  DEFAULT_POINTER, extractPointerBlock, labwcAtLeast, labwcPointerBlock, loadPointer, mergePointer, mergePointerBlock, normalizePointer,
  joinPointerDevices, parsePointerDevices, parseProcInputDevices, parseUdevPointer, pointerBridge, support, type PointerFiles,
} from './pointer'
import { carryDesktops } from './touch'
import type { Exec } from './system'

const LIBINPUT = `Device:           AT Translated Set 2 keyboard
Kernel:           /dev/input/event3
Capabilities:     keyboard
Tap-to-click:     n/a

Device:           SYNA2B31:00 06CB:CD3E Touchpad
Kernel:           /dev/input/event7
Capabilities:     pointer gesture
Tap-to-click:     disabled
Tap-and-drag:     enabled
Tap drag lock:    disabled
Left-handed:      disabled
Nat.scrolling:    disabled
Middle emulation: disabled
Calibration:      n/a
Scroll methods:   *two-finger edge
Click methods:    *button-areas clickfinger
Disable-w-typing: enabled
Accel profiles:   flat *adaptive custom

Device:           Logitech USB Optical Mouse
Kernel:           /dev/input/event9
Capabilities:     pointer
Tap-to-click:     n/a
Left-handed:      disabled
Nat.scrolling:    disabled
Scroll methods:   button
Click methods:    none
Disable-w-typing: n/a
Accel profiles:   flat *adaptive custom

Device:           Consumer Control
Kernel:           /dev/input/event5
Capabilities:     keyboard pointer
Tap-to-click:     n/a
Nat.scrolling:    n/a
Accel profiles:   n/a
`

const noSys = { listInput: () => [], procDevices: () => '' }

// A real laptop session (#44): the user is not in the `input` group, so libinput opens only what logind's uaccess
// gives the seat (here a game controller) and exits 0; udev still knows the touchpad and the trackpoint.
const LIBINPUT_UNPRIVILEGED = `Device:           Microsoft X-Box 360 pad
Kernel:           /dev/input/event20
Capabilities:     gamepad
Tap-to-click:     n/a
`
const UDEV: Record<string, string> = {
  '/dev/input/event3': 'DEVPATH=/devices/platform/i8042/serio0/input/input3/event3\nDEVNAME=/dev/input/event3\nID_INPUT=1\nID_INPUT_KEY=1\nID_INPUT_KEYBOARD=1\n',
  '/dev/input/event8': 'DEVPATH=/devices/pci0000:00/0000:00:15.0/i2c_designware.0/i2c-0/i2c-ELAN0712:00/0018:04F3:30FD.0001/input/input8/event8\nDEVNAME=/dev/input/event8\nID_INPUT=1\nID_INPUT_TOUCHPAD=1\nID_INPUT_WIDTH_MM=102\n',
  '/dev/input/event9': 'DEVNAME=/dev/input/event9\nID_INPUT=1\nID_INPUT_MOUSE=1\nID_INPUT_POINTINGSTICK=1\n',
  '/dev/input/event20': 'DEVNAME=/dev/input/event20\nID_INPUT=1\nID_INPUT_JOYSTICK=1\n',
}
const PROC = `I: Bus=0011 Vendor=0001 Product=0001 Version=ab83
N: Name="AT Translated Set 2 keyboard"
H: Handlers=sysrq kbd leds event3
B: PROP=0
B: EV=120013

I: Bus=0018 Vendor=04f3 Product=30fd Version=0100
N: Name="ELAN0712:00 04F3:30FD Touchpad"
H: Handlers=mouse1 event8
B: PROP=5
B: EV=1b
B: ABS=2e0800000000003

I: Bus=0003 Vendor=046d Product=c077 Version=0111
N: Name="Logitech USB Optical Mouse"
H: Handlers=mouse2 event12
B: PROP=0
B: EV=17
B: REL=903

I: Bus=0018 Vendor=04f3 Product=2b7c Version=0100
N: Name="ELAN Touchscreen"
H: Handlers=mouse3 event14
B: PROP=2
B: EV=b
`

const RC = '<?xml version="1.0"?>\n<labwc_config>\n  <core />\n</labwc_config>\n'

describe('pointer devices', () => {
  it('reads mice and touchpads and what each supports from libinput', () => {
    const d = parsePointerDevices(LIBINPUT)
    expect(d.map((x) => [x.name, x.kind])).toEqual([['SYNA2B31:00 06CB:CD3E Touchpad', 'touchpad'], ['Logitech USB Optical Mouse', 'mouse']])
    expect(d[0].caps).toMatchObject({ tap: true, edgeScroll: true, twoFingerScroll: true, clickfinger: true, buttonAreas: true, disableWhileTyping: true, dragLock: true, flat: true })
    expect(d[1].caps).toMatchObject({ tap: false, edgeScroll: false, clickfinger: false, accel: true, naturalScroll: true })
  })
  it('falls back to udev kinds', () => {
    expect(parseUdevPointer('NAME="Elan\\x20Touchpad"\nID_INPUT=1\nID_INPUT_TOUCHPAD=1\n')).toMatchObject({ name: 'Elan Touchpad', kind: 'touchpad' })
    expect(parseUdevPointer('NAME="Mouse"\nID_INPUT_MOUSE=1\n')?.caps.tap).toBe(false)
    expect(parseUdevPointer('ID_INPUT_KEY=1\n')).toBeNull()
  })
  it('reads /proc/bus/input/devices when udevadm is missing', () => {
    expect(parseProcInputDevices(PROC).map((d) => [d.name, d.kind, d.node])).toEqual([
      ['ELAN0712:00 04F3:30FD Touchpad', 'touchpad', '/dev/input/event8'], ['Logitech USB Optical Mouse', 'mouse', '/dev/input/event12'],
    ])
  })
  it('joins libinput with udev without doubling a node', () => {
    const li = parsePointerDevices(LIBINPUT)
    const j = joinPointerDevices(li, [parseUdevPointer(UDEV['/dev/input/event8'].replace(/event8/g, 'event7'))!, parseUdevPointer(UDEV['/dev/input/event9'])!])
    expect(j.map((d) => [d.node, d.kind])).toEqual([['/dev/input/event7', 'touchpad'], ['/dev/input/event9', 'mouse']])
    expect(j[0].caps.buttonAreas).toBe(true)   // libinput's own capabilities win
  })
  it('knows which Labwc has scrollFactor', () => {
    expect(labwcAtLeast('labwc 0.8.4', 0, 8)).toBe(true)
    expect(labwcAtLeast('labwc 0.7.1', 0, 8)).toBe(false)
    expect(labwcAtLeast(null, 0, 8)).toBe(true)
    expect(support([], 'labwc 0.8.1')).toEqual({ mouse: null, touchpad: null, scrollFactor: true, swipeGestures: false })
  })
})

describe('pointer settings', () => {
  it('normalizes and clamps', () => {
    const s = normalizePointer({ mouse: { speed: 5, accel: 'weird', scrollFactor: 0.01, naturalScroll: true }, touchpad: { enabled: 'no', clickMethod: 'x' } })
    expect(s.mouse).toEqual({ ...DEFAULT_POINTER.mouse, speed: 1, scrollFactor: 0.25, naturalScroll: true })
    expect(s.touchpad.enabled).toBe('no')
    expect(s.touchpad.clickMethod).toBe('clickfinger')
    expect(mergePointer(s, { touchpad: { tap: false } }).touchpad).toMatchObject({ tap: false, enabled: 'no' })
  })

  it('writes only supported options into the Labwc block', () => {
    const sup = support(parsePointerDevices(LIBINPUT), 'labwc 0.8.3')
    const s = mergePointer(DEFAULT_POINTER, { mouse: { speed: -0.5, accel: 'flat' }, touchpad: { tap: true, scrollMethod: 'edge', scrollFactor: 1.5 } })
    const b = labwcPointerBlock(s, sup)
    expect(b).toContain('<device category="non-touch"><pointerSpeed>-0.50</pointerSpeed><accelProfile>flat</accelProfile><naturalScroll>no</naturalScroll><leftHanded>no</leftHanded><scrollFactor>1.00</scrollFactor></device>')
    expect(b).toContain('<tap>yes</tap>')
    expect(b).toContain('<scrollMethod>edge</scrollMethod>')
    expect(b).toContain('<scrollFactor>1.50</scrollFactor>')
    expect(b).toContain('<sendEventsMode>yes</sendEventsMode>')
    // No touchpad: no touchpad section. Old Labwc: no scrollFactor.
    const mouseOnly = labwcPointerBlock(s, { ...sup, touchpad: null, scrollFactor: false })
    expect(mouseOnly).not.toContain('category="touchpad"')
    expect(mouseOnly).not.toContain('scrollFactor')
  })

  it('merges, replaces and carries the block through the touchscreen rewrite', () => {
    const b1 = labwcPointerBlock(DEFAULT_POINTER, support(parsePointerDevices(LIBINPUT), null))
    const rc1 = mergePointerBlock(RC, b1)
    expect(rc1.indexOf(b1)).toBeLessThan(rc1.indexOf('</labwc_config>'))
    const b2 = labwcPointerBlock(mergePointer(DEFAULT_POINTER, { mouse: { speed: 1 } }), support(parsePointerDevices(LIBINPUT), null))
    const rc2 = mergePointerBlock(rc1, b2)
    expect(extractPointerBlock(rc2)).toBe(b2)
    expect(rc2.match(/worksuite-pointer:begin/g)).toHaveLength(1)
    expect(mergePointerBlock(rc2, null)).toBe(RC)
    expect(extractPointerBlock(carryDesktops(rc2, RC))).toBe(b2)
  })
})

describe('pointer bridge', () => {
  let dir: string
  let files: PointerFiles
  let calls: string[][]
  let reload = 0
  const exec: Exec = async (cmd, args) => {
    calls.push([cmd, ...args])
    if (cmd === 'libinput') return { code: 0, stdout: LIBINPUT, stderr: '' }
    if (cmd === 'labwc' && args[0] === '--version') return { code: 0, stdout: 'labwc 0.8.4\n', stderr: '' }
    if (cmd === 'labwc') return { code: reload, stdout: '', stderr: '' }
    return { code: 1, stdout: '', stderr: '', missing: true }
  }
  beforeEach(() => {
    dir = mkdtempSync(path.join(os.tmpdir(), 'ws-ptr-'))
    files = { settings: path.join(dir, 'cfg', 'pointer.json'), userRc: path.join(dir, 'cfg', 'labwc', 'rc.xml'), systemRc: path.join(dir, 'sys-rc.xml') }
    writeFileSync(files.systemRc, RC)
    mkdirSync(path.dirname(files.userRc), { recursive: true })
    symlinkSync(files.systemRc, files.userRc)   // as worksuite-session sets it up
    calls = []
    reload = 0
  })
  afterEach(() => rmSync(dir, { recursive: true, force: true }))

  it('applies live with labwc --reconfigure and persists across sessions', async () => {
    const b = pointerBridge(files, exec, noSys)
    const st = await b.state()
    expect(st.available && st.value.support.touchpad?.tap).toBe(true)
    const r = await b.set(JSON.stringify({ touchpad: { tap: true, naturalScroll: false }, mouse: { speed: 0.4 } }))
    expect(r.available).toBe(true)
    expect(calls).toContainEqual(['labwc', '--reconfigure'])
    const rc = readFileSync(files.userRc, 'utf8')
    expect(rc).toContain('<pointerSpeed>0.40</pointerSpeed>')
    expect(readFileSync(files.systemRc, 'utf8')).toBe(RC)   // the symlink was replaced, not written through
    // Next login: the saved settings come back.
    expect(loadPointer(files.settings).mouse.speed).toBe(0.4)
    calls = []
    const again = pointerBridge(files, exec, noSys)
    expect((await again.start()).available).toBe(true)
    expect(calls).not.toContainEqual(['labwc', '--reconfigure'])   // already in place
  })

  it('finds the touchpad and trackpoint on a laptop where libinput can open nothing useful (#44)', async () => {
    const lap: Exec = async (cmd, args) => {
      if (cmd === 'libinput') return { code: 0, stdout: LIBINPUT_UNPRIVILEGED, stderr: 'Failed to open /dev/input/event8 (Permission denied)\n' }
      if (cmd === 'udevadm') { const o = UDEV[args[args.length - 1]]; return o ? { code: 0, stdout: o, stderr: '' } : { code: 1, stdout: '', stderr: 'no device' } }
      return exec(cmd, args)
    }
    const b = pointerBridge(files, lap, { listInput: () => ['event3', 'event8', 'event9', 'event20', 'input8', 'mouse1'], procDevices: () => '' })
    const st = await b.state()
    if (!st.available) throw new Error('unavailable')
    expect(st.value.devices.map((d) => d.kind)).toEqual(['touchpad', 'mouse'])
    expect(st.value.support.touchpad).toMatchObject({ tap: true, twoFingerScroll: true, disableWhileTyping: true, accel: true })
    expect(st.value.support.mouse).toMatchObject({ accel: true, leftHanded: true, naturalScroll: true })
    // …and the controls are applied for them.
    expect((await b.set(JSON.stringify({ touchpad: { tap: false } }))).available).toBe(true)
    expect(readFileSync(files.userRc, 'utf8')).toMatch(/<device category="touchpad">.*<tap>no<\/tap>/)
  })

  it('falls back to /proc/bus/input/devices without libinput or udevadm', async () => {
    const bare: Exec = async (cmd, args) => (cmd === 'libinput' || cmd === 'udevadm' ? { code: 1, stdout: '', stderr: '', missing: true } : exec(cmd, args))
    const b = pointerBridge(files, bare, { listInput: () => ['event8', 'event12'], procDevices: () => PROC })
    const st = await b.state()
    expect(st.available && st.value.devices.map((d) => d.kind)).toEqual(['touchpad', 'mouse'])
  })

  it('keeps the old settings when Labwc cannot reload', async () => {
    reload = 1
    const b = pointerBridge(files, exec, noSys)
    expect(await b.set(JSON.stringify({ mouse: { speed: 0.9 } }))).toEqual({ available: false, reason: 'labwc_reload' })
    const st = await b.state()
    expect(st.available && st.value.settings.mouse.speed).toBe(0)
    expect(await b.set('{bad')).toEqual({ available: false, reason: 'bad_settings' })
  })
})

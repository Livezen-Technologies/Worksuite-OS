import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  DEFAULT_POINTER, extractPointerBlock, labwcAtLeast, labwcPointerBlock, loadPointer, mergePointer, mergePointerBlock, normalizePointer,
  parsePointerDevices, parseUdevPointer, pointerBridge, support, type PointerFiles,
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
    const b = pointerBridge(files, exec)
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
    const again = pointerBridge(files, exec)
    expect((await again.start()).available).toBe(true)
    expect(calls).not.toContainEqual(['labwc', '--reconfigure'])   // already in place
  })

  it('keeps the old settings when Labwc cannot reload', async () => {
    reload = 1
    const b = pointerBridge(files, exec)
    expect(await b.set(JSON.stringify({ mouse: { speed: 0.9 } }))).toEqual({ available: false, reason: 'labwc_reload' })
    const st = await b.state()
    expect(st.available && st.value.settings.mouse.speed).toBe(0)
    expect(await b.set('{bad')).toEqual({ available: false, reason: 'bad_settings' })
  })
})

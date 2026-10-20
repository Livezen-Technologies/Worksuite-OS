import { execFile, spawn, spawnSync, type ChildProcess } from 'node:child_process'
import { chmodSync, mkdirSync, mkdtempSync, readdirSync, rmSync, symlinkSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  arrange, currentLayout, displayManager, mirrorCommands, monitorSetKey, outputRects, parseOutputs, parseOutputsText, randrArgs,
  readStore, RevertTimer, validateLayout, withOfferedModes, drmDrivers, layoutMatches, type Clock, type Layout, type OutputInfo,
} from './displays'
import type { Exec } from './system'

const JSON_OUT = JSON.stringify([
  { name: 'eDP-1', description: 'BOE 0x095F', make: 'BOE', model: '0x095F', serial: '', enabled: true,
    modes: [{ width: 2256, height: 1504, refresh: 59.999, preferred: true, current: true }, { width: 1920, height: 1280, refresh: 59.999, preferred: false, current: false }],
    position: { x: 0, y: 0 }, transform: 'normal', scale: 1.5, adaptive_sync: false },
  { name: 'HDMI-A-1', description: 'Dell Inc. DELL U2720Q ABC123', make: 'Dell Inc.', model: 'DELL U2720Q', serial: 'ABC123', enabled: true,
    modes: [{ width: 3840, height: 2160, refresh: 60, preferred: true, current: true }, { width: 1920, height: 1080, refresh: 60, preferred: false, current: false }, { width: 1920, height: 1080, refresh: 50, preferred: false, current: false }],
    position: { x: 1504, y: 0 }, transform: 'normal', scale: 2 },
])

const TEXT_OUT = `HEADLESS-1 "Headless output 1"
  Make: (null)
  Model: (null)
  Serial: (null)
  Enabled: yes
  Modes:
    1280x720 px (current)
  Position: 1280,0
  Transform: normal
  Scale: 1.000000
  Adaptive Sync: disabled
DP-2 "LG Electronics 27GL850 0x0001"
  Make: LG Electronics
  Model: 27GL850
  Serial: 0x0001
  Enabled: no
  Modes:
    2560x1440 px, 143.998001 Hz (preferred)
    2560x1440 px, 59.951000 Hz (current)
  Position: 0,0
  Transform: normal
  Scale: 1.250000
`

const outs = (): OutputInfo[] => parseOutputs(JSON_OUT)

describe('parsers', () => {
  it('reads wlr-randr --json with modes, position, identity and fractional scale', () => {
    const [a, b] = outs()
    expect(a).toMatchObject({ name: 'eDP-1', make: 'BOE', x: 0, y: 0, scale: 1.5, enabled: true })
    expect(a.modes[0]).toEqual({ width: 2256, height: 1504, refresh: 59.999, preferred: true, current: true })
    expect(b).toMatchObject({ name: 'HDMI-A-1', serial: 'ABC123', x: 1504, scale: 2 })
    expect(parseOutputs('nonsense')).toEqual([])
    expect(parseOutputs('{"a":1}')).toEqual([])
  })
  it('reads plain wlr-randr (no --json before 0.4)', () => {
    const [h, d] = parseOutputsText(TEXT_OUT)
    expect(h).toMatchObject({ name: 'HEADLESS-1', make: '', serial: '', x: 1280, y: 0, scale: 1, enabled: true })
    expect(h.modes).toEqual([{ width: 1280, height: 720, refresh: 0, preferred: false, current: true }])
    expect(d).toMatchObject({ name: 'DP-2', make: 'LG Electronics', enabled: false, scale: 1.25 })
    expect(d.modes.map((m) => [m.refresh, m.preferred, m.current])).toEqual([[143.998, true, false], [59.951, false, true]])
  })
})

describe('layout', () => {
  it('keys a monitor set by EDID identity, independent of connector order', () => {
    const k = monitorSetKey(outs())
    expect(k).toBe(monitorSetKey([...outs()].reverse()))
    expect(k).toContain('Dell Inc.|DELL U2720Q|ABC123')
    expect(monitorSetKey(parseOutputsText(TEXT_OUT))).toContain('HEADLESS-1')
  })
  it('derives the current layout and primary', () => {
    const l = currentLayout(outs())
    expect(l.arrangement).toBe('extend')
    expect(l.primary).toBe('eDP-1')
    expect(currentLayout(outs(), 'HDMI-A-1').primary).toBe('HDMI-A-1')
    expect(currentLayout(outs(), 'gone').primary).toBe('eDP-1')
  })
  it('extends side by side in logical pixels (scale 100–200 %)', () => {
    const l = arrange({ ...currentLayout(outs()), primary: 'HDMI-A-1' }, { 'eDP-1': 'left' })
    const by = Object.fromEntries(l.outputs.map((o) => [o.name, [o.x, o.y]]))
    // eDP-1 is 2256/1.5 = 1504 logical px wide and sits left of the primary, which moves to x = 1504.
    expect(by).toEqual({ 'eDP-1': [0, 0], 'HDMI-A-1': [1504, 0] })
    const below = arrange(currentLayout(outs()), { 'HDMI-A-1': 'below' })
    expect(below.outputs.find((o) => o.name === 'HDMI-A-1')).toMatchObject({ x: 0, y: 1003 })
  })
  it('mirrors with wl-mirror on each secondary (Labwc keeps outputs from overlapping)', () => {
    const l = arrange({ ...currentLayout(outs()), arrangement: 'mirror' })
    expect(l.outputs.map((o) => [o.x, o.y])).toEqual([[0, 0], [1504, 0]])
    expect(mirrorCommands(l)).toEqual([['wl-mirror', ['--fullscreen-output', 'HDMI-A-1', 'eDP-1']]])
    expect(mirrorCommands(arrange(currentLayout(outs())))).toEqual([])
    expect(outputRects(l).map((r) => r.name)).toEqual(['eDP-1'])
    expect(currentLayout(outs().slice(0, 1), undefined, 'mirror').arrangement).toBe('extend')
  })
  it('validates modes, scale, primary and positions', () => {
    const l = currentLayout(outs())
    expect(validateLayout(l, outs())).toBeNull()
    const set = (name: string, patch: object): Layout => ({ ...l, outputs: l.outputs.map((o) => (o.name === name ? { ...o, ...patch } : o)) })
    expect(validateLayout(set('HDMI-A-1', { scale: 2.5 }), outs())).toBe('bad_scale')
    expect(validateLayout(set('HDMI-A-1', { scale: 0.75 }), outs())).toBe('bad_scale')
    expect(validateLayout(set('HDMI-A-1', { width: 1280, height: 720 }), outs())).toBe('bad_mode')
    expect(validateLayout(set('HDMI-A-1', { width: 1920, height: 1080, refresh: 50 }), outs())).toBeNull()
    expect(validateLayout(set('eDP-1', { enabled: false }), outs())).toBe('bad_primary')
    expect(validateLayout(set('HDMI-A-1', { x: -5 }), outs())).toBe('bad_position')
    expect(validateLayout({ ...l, outputs: l.outputs.map((o) => ({ ...o, enabled: false })) }, outs())).toBe('no_enabled_output')
    expect(validateLayout(set('HDMI-A-1', { name: 'DP-9' }), outs())).toBe('unknown_output')
  })
  it('builds one wlr-randr call for all outputs, enabled ones first', () => {
    const l = currentLayout(outs())
    l.outputs[0].enabled = false
    l.primary = 'HDMI-A-1'
    expect(randrArgs(l)).toEqual(['--output', 'HDMI-A-1', '--on', '--mode', '3840x2160@60Hz', '--pos', '1504,0', '--scale', '2', '--output', 'eDP-1', '--off'])
    expect(randrArgs({ arrangement: 'extend', primary: 'H', outputs: [{ name: 'H', enabled: true, width: 1280, height: 720, refresh: 0, scale: 1, x: 0, y: 0 }] }))
      .toEqual(['--output', 'H', '--on', '--mode', '1280x720', '--pos', '0,0', '--scale', '1'])
  })
  it('gives each monitor a logical rectangle for its desktop/panel window', () => {
    expect(outputRects(currentLayout(outs()))).toEqual([
      { name: 'eDP-1', primary: true, x: 0, y: 0, width: 1504, height: 1003 },
      { name: 'HDMI-A-1', primary: false, x: 1504, y: 0, width: 1920, height: 1080 },
    ])
  })
})

function fakeClock() {
  let t = 1000
  const timers: { at: number; fn: () => void; id: number }[] = []
  let id = 0
  const clock: Clock = {
    now: () => t,
    setTimeout: (fn, ms) => { timers.push({ at: t + ms, fn, id: ++id }); return id },
    clearTimeout: (x) => { const i = timers.findIndex((tm) => tm.id === x); if (i >= 0) timers.splice(i, 1) },
  }
  const advance = (ms: number) => {
    t += ms
    for (const tm of [...timers].sort((a, b) => a.at - b.at)) if (tm.at <= t) { timers.splice(timers.indexOf(tm), 1); tm.fn() }
  }
  return { clock, advance, timers }
}

describe('revert timer', () => {
  it('reverts after 15 seconds unless cancelled', () => {
    const { clock, advance } = fakeClock()
    const t = new RevertTimer(clock)
    const revert = vi.fn()
    expect(t.start(revert)).toBe(16000)
    advance(14999)
    expect(revert).not.toHaveBeenCalled()
    expect(t.pending).toBe(true)
    advance(1)
    expect(revert).toHaveBeenCalledOnce()
    expect(t.pending).toBe(false)
    expect(t.deadline).toBeNull()
  })
  it('keep cancels; restarting replaces the countdown', () => {
    const { clock, advance } = fakeClock()
    const t = new RevertTimer(clock)
    const a = vi.fn(), b = vi.fn()
    t.start(a)
    advance(10000)
    t.start(b)
    advance(10000)
    expect(a).not.toHaveBeenCalled()
    expect(b).not.toHaveBeenCalled()
    expect(t.cancel()).toBe(true)
    advance(60000)
    expect(b).not.toHaveBeenCalled()
    expect(t.cancel()).toBe(false)
  })
  it('works with real timers too', () => {
    vi.useFakeTimers()
    try {
      const t = new RevertTimer(undefined, 15)
      const r = vi.fn()
      t.start(r)
      vi.advanceTimersByTime(15000)
      expect(r).toHaveBeenCalledOnce()
    } finally { vi.useRealTimers() }
  })
})

describe('display manager', () => {
  let dir: string
  beforeEach(() => { dir = mkdtempSync(path.join(os.tmpdir(), 'ws-disp-')) })
  afterEach(() => rmSync(dir, { recursive: true, force: true }))

  function fakeRandr() {
    let state = outs()
    const calls: string[][] = []
    const exec: Exec = async (_cmd, args) => {
      calls.push(args)
      if (args[0] === '--json') return { code: 0, stdout: JSON.stringify(state.map((o) => ({ ...o, position: { x: o.x, y: o.y } }))), stderr: '' }
      // apply: --output N (--off | --on --mode WxH@R --pos X,Y --scale S)
      for (let i = 0; i < args.length; i++) {
        if (args[i] !== '--output') continue
        const o = state.find((x) => x.name === args[i + 1])!
        if (args[i + 2] === '--off') { o.enabled = false; continue }
        o.enabled = true
        const [wh, r] = args[i + 4].split('@')
        const [w, h] = wh.split('x').map(Number)
        o.modes = o.modes.map((m) => ({ ...m, current: m.width === w && m.height === h && (!r || Math.abs(m.refresh - parseFloat(r)) < 0.01) }))
        const [x, y] = args[i + 6].split(',').map(Number)
        o.x = x; o.y = y; o.scale = Number(args[i + 8])
      }
      return { code: 0, stdout: '', stderr: '' }
    }
    return { exec, calls, get: () => state, set: (s: OutputInfo[]) => { state = s } }
  }

  it('applies, reverts after the countdown, and keeps nothing', async () => {
    const r = fakeRandr()
    const { clock, advance } = fakeClock()
    const dm = displayManager({ exec: r.exec, storeFile: path.join(dir, 'displays.json'), clock })
    const l = currentLayout(r.get())
    const next = arrange({ ...l, outputs: l.outputs.map((o) => (o.name === 'HDMI-A-1' ? { ...o, width: 1920, height: 1080, refresh: 60, scale: 1 } : o)) })
    const res = await dm.apply(next)
    expect(res).toEqual({ ok: true, value: { deadline: 16000 } })
    expect(r.get()[1]).toMatchObject({ scale: 1 })
    advance(15000)
    await vi.waitFor(() => expect(r.get()[1]).toMatchObject({ scale: 2 }))
    expect(r.get()[1].modes.find((m) => m.current)).toMatchObject({ width: 3840 })
    expect(readStore(path.join(dir, 'displays.json')).profiles).toEqual({})
  })

  it('goes straight back when the compositor substitutes another mode (#32)', async () => {
    const r = fakeRandr()
    const { clock } = fakeClock()
    const exec: Exec = async (cmd, args) => {
      // This monitor "accepts" 1920×1080 but keeps running its native mode.
      if (args.includes('1920x1080@60Hz')) return { code: 0, stdout: '', stderr: '' }
      return r.exec(cmd, args)
    }
    const dm = displayManager({ exec, storeFile: path.join(dir, 'displays.json'), clock, drivers: () => ({}) })
    const l = currentLayout(r.get())
    const res = await dm.apply(arrange({ ...l, outputs: l.outputs.map((o) => (o.name === 'HDMI-A-1' ? { ...o, width: 1920, height: 1080, refresh: 60, scale: 2 } : o)) }))
    expect(res).toEqual({ ok: false, error: 'mode_not_applied' })
    expect(dm.timer.pending).toBe(false)
    expect(r.get()[1].modes.find((m) => m.current)).toMatchObject({ width: 3840 })
  })

  it('keeps and saves per monitor set; re-applies at login; rejects bad layouts', async () => {
    const r = fakeRandr()
    const { clock, advance } = fakeClock()
    const file = path.join(dir, 'displays.json')
    const dm = displayManager({ exec: r.exec, storeFile: file, clock })
    const l = currentLayout(r.get())
    expect(await dm.apply({ ...l, outputs: l.outputs.map((o) => ({ ...o, scale: 3 })) })).toEqual({ ok: false, error: 'bad_scale' })
    await dm.apply(arrange({ ...l, primary: 'HDMI-A-1' }, { 'eDP-1': 'left' }))
    await dm.setWallpaper('HDMI-A-1', 'dusk')
    expect(await dm.confirm()).toEqual({ ok: true, value: true })
    advance(60000)
    const saved = readStore(file).profiles[monitorSetKey(r.get())]
    expect(saved.layout.primary).toBe('HDMI-A-1')
    expect(saved.wallpapers).toEqual({ 'HDMI-A-1': 'dusk' })
    // Next login: the compositor starts with its defaults; the saved layout comes back without a countdown.
    r.set(outs())
    const login = displayManager({ exec: r.exec, storeFile: file, clock })
    expect(await login.applySaved()).toEqual({ ok: true, value: true })
    expect(login.timer.pending).toBe(false)
    expect(r.get().map((o) => [o.name, o.x])).toEqual([['eDP-1', 0], ['HDMI-A-1', 1504]])
    const s = await login.state()
    expect(s.ok && s.value.layout.primary).toBe('HDMI-A-1')
    expect(s.ok && s.value.wallpapers).toEqual({ 'HDMI-A-1': 'dusk' })
    // A different monitor set (laptop alone) has no profile and is left alone.
    r.set(outs().slice(0, 1))
    const calls = r.calls.length
    expect(await login.applySaved()).toEqual({ ok: true, value: false })
    expect(r.calls.slice(calls).some((a) => a.includes('--output'))).toBe(false)
  })
})

describe('offered modes (#32)', () => {
  const vm = (driver?: string, name = 'Virtual-1'): OutputInfo => ({ name, description: '', make: '', model: '', serial: '', enabled: true, x: 0, y: 0, scale: 1, transform: 'normal', driver,
    modes: [{ width: 1280, height: 800, refresh: 59.81, preferred: true, current: true }, { width: 1280, height: 800, refresh: 59.81, preferred: false, current: false }, { width: 0, height: 0, refresh: 0, preferred: false, current: false }] })

  it('offers standard sizes as custom modes on a virtual GPU whose list has one mode', () => {
    const o = withOfferedModes(vm('virtio_gpu'))
    const sizes = o.modes.map((m) => `${m.width}x${m.height}`)
    expect(sizes[0]).toBe('1280x800')
    expect(sizes).toContain('1920x1080')
    expect(sizes).toContain('1024x768')
    expect(sizes).not.toContain('2560x1440')            // larger than the output allows (max 1920×1080 here)
    expect(sizes.filter((x) => x === '1280x800')).toHaveLength(1)   // duplicates and the 0×0 entry dropped
    expect(o.modes.find((m) => m.width === 1920)).toMatchObject({ custom: true, refresh: 0 })
    expect(withOfferedModes(vm(undefined, 'HEADLESS-1')).modes.length).toBeGreaterThan(5)
  })

  it('offers nothing extra on real monitors or the firmware framebuffer', () => {
    const real = withOfferedModes({ ...outs()[1], driver: 'i915' })
    expect(real.modes).toHaveLength(3)
    const fw = withOfferedModes(vm('simpledrm'))
    expect(fw.fixedMode).toBe(true)
    expect(fw.modes).toHaveLength(1)
  })

  it('applies custom sizes with --custom-mode', () => {
    const o = withOfferedModes(vm('virtio_gpu'))
    const l: Layout = { arrangement: 'extend', primary: 'Virtual-1', outputs: [{ name: 'Virtual-1', enabled: true, width: 1920, height: 1080, refresh: 0, scale: 1, x: 0, y: 0 }] }
    expect(validateLayout(l, [o])).toBeNull()
    expect(randrArgs(l, [o])).toEqual(['--output', 'Virtual-1', '--on', '--custom-mode', '1920x1080', '--pos', '0,0', '--scale', '1'])
    expect(randrArgs({ ...l, outputs: [{ ...l.outputs[0], width: 1280, height: 800, refresh: 59.81 }] }, [o])).toContain('--mode')
    expect(validateLayout({ ...l, outputs: [{ ...l.outputs[0], width: 1600, height: 1200 }] }, [o])).toBe('bad_mode')
  })

  it('reads connector drivers from sysfs', () => {
    const root = mkdtempSync(path.join(os.tmpdir(), 'ws-drm-'))
    try {
      mkdirSync(path.join(root, 'drv', 'virtio_gpu'), { recursive: true })
      mkdirSync(path.join(root, 'card0-Virtual-1', 'device'), { recursive: true })
      symlinkSync(path.join(root, 'drv', 'virtio_gpu'), path.join(root, 'card0-Virtual-1', 'device', 'driver'))
      mkdirSync(path.join(root, 'card0'))
      expect(drmDrivers(root)).toEqual({ 'Virtual-1': 'virtio_gpu' })
      expect(drmDrivers(path.join(root, 'missing'))).toEqual({})
    } finally { rmSync(root, { recursive: true, force: true }) }
  })

  it('checks that the compositor runs what was asked', () => {
    const o = outs()
    const l = currentLayout(o)
    expect(layoutMatches(l, o)).toBe(true)
    expect(layoutMatches({ ...l, outputs: l.outputs.map((c) => ({ ...c, width: 1920, height: 1080 })) }, o)).toBe(false)
  })
})

// Real wlr-randr against a headless Labwc with two virtual outputs.
function haveTools() {
  return ['labwc', 'wlr-randr'].every((t) => spawnSync('sh', ['-c', `command -v ${t}`]).status === 0)
}
const realExecIn = (env: NodeJS.ProcessEnv): Exec => (cmd, args) => new Promise((resolve) => {
  execFile(cmd, args, { env }, (err, stdout, stderr) => resolve({ code: err ? 1 : 0, stdout: String(stdout), stderr: String(stderr), missing: (err as NodeJS.ErrnoException | null)?.code === 'ENOENT' }))
})

describe.skipIf(!haveTools())('headless Labwc, two outputs', () => {
  let rt: string
  let labwc: ChildProcess
  let env: NodeJS.ProcessEnv
  beforeEach(async () => {
    rt = mkdtempSync(path.join(os.tmpdir(), 'ws-labwc-'))
    chmodSync(rt, 0o700)
    const base: NodeJS.ProcessEnv = { ...process.env, XDG_RUNTIME_DIR: rt, WLR_BACKENDS: 'headless', WLR_RENDERER: 'pixman', WLR_LIBINPUT_NO_DEVICES: '1', WLR_HEADLESS_OUTPUTS: '2', WAYLAND_DISPLAY: '' }
    delete base.DISPLAY
    labwc = spawn('labwc', ['-C', rt], { env: base, stdio: 'ignore' })
    for (let i = 0; i < 100; i++) {
      const s = readdirSync(rt).find((f) => f.startsWith('wayland-') && !f.endsWith('.lock'))
      if (s) { env = { ...base, WAYLAND_DISPLAY: s }; break }
      await new Promise((r) => setTimeout(r, 50))
    }
  })
  afterEach(() => { labwc.kill(); rmSync(rt, { recursive: true, force: true }) })

  it('applies scale, position, primary and mirror; reverts; saves per monitor set', async () => {
    const exec = realExecIn(env)
    const file = path.join(rt, 'displays.json')
    const { clock, advance } = fakeClock()
    const spawned: string[][] = []
    const killed: string[][] = []
    const dm = displayManager({ exec, storeFile: file, clock, spawn: (c, a) => { spawned.push([c, ...a]); return { kill: () => killed.push([c, ...a]) } } })
    const s0 = await dm.state()
    if (!s0.ok) throw new Error(s0.error)
    expect(s0.value.outputs.map((o) => o.name).sort()).toEqual(['HEADLESS-1', 'HEADLESS-2'])
    const before = s0.value.layout
    const scaled = arrange({ ...before, primary: 'HEADLESS-2', outputs: before.outputs.map((o) => (o.name === 'HEADLESS-1' ? { ...o, scale: 1.5 } : o)) }, { 'HEADLESS-1': 'right' })
    expect(await dm.apply(scaled)).toMatchObject({ ok: true })
    let s = await dm.state()
    const pos = (st: typeof s) => (st.ok ? Object.fromEntries(st.value.outputs.map((o) => [o.name, [o.x, o.y, o.scale]])) : {})
    expect(pos(s)).toEqual({ 'HEADLESS-2': [0, 0, 2 / 2], 'HEADLESS-1': [1280, 0, 1.5] })
    // No answer within 15 s: back to how it was.
    advance(15000)
    await vi.waitFor(async () => expect(pos(await dm.state())).toEqual(Object.fromEntries(before.outputs.map((o) => [o.name, [o.x, o.y, o.scale]]))))
    // Mirror, then keep.
    expect(await dm.apply(arrange({ ...before, arrangement: 'mirror' }))).toMatchObject({ ok: true })
    expect(await dm.confirm()).toEqual({ ok: true, value: true })
    s = await dm.state()
    expect(s.ok && s.value.layout.arrangement).toBe('mirror')
    const sec = before.outputs.find((o) => o.name !== before.primary)!.name
    expect(spawned).toEqual([['wl-mirror', '--fullscreen-output', sec, before.primary]])
    // Back to extend: the mirror goes away.
    expect(await dm.apply(arrange({ ...before, arrangement: 'extend' }))).toMatchObject({ ok: true })
    expect(killed).toEqual(spawned)
    await dm.confirm()
    expect(Object.keys(readStore(file).profiles)).toEqual([monitorSetKey(s.ok ? s.value.outputs : [])])
  })
})

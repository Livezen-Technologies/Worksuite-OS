// Display configuration (WSOS-DSK-005/006/007): per-monitor resolution, refresh, scale, position, primary,
// mirror/extend and wallpaper, applied with wlr-randr (fixed argument arrays) and saved per monitor set in
// ~/.config/worksuite/displays.json. A change only sticks once the user confirms it within REVERT_SECONDS;
// otherwise the previous layout is re-applied. The saved layout for the connected monitor set is re-applied at
// login and whenever a monitor is plugged or unplugged (the bridge's OutputsChanged).
import { mkdirSync, readFileSync, readdirSync, readlinkSync, renameSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import type { Exec } from './system'

export const REVERT_SECONDS = 15
export const MIN_SCALE = 1
export const MAX_SCALE = 2

/** `custom`: not in the monitor's mode list but offered because the output takes any size (virtual GPUs); applied
 *  with wlr-randr --custom-mode. */
export interface Mode { width: number; height: number; refresh: number; preferred: boolean; current: boolean; custom?: boolean }
/** `fixedMode`: the output runs on the firmware framebuffer (simpledrm/efifb), which has exactly one mode. */
export interface OutputInfo {
  name: string; description: string; make: string; model: string; serial: string; enabled: boolean
  modes: Mode[]; x: number; y: number; scale: number; transform: string; driver?: string; fixedMode?: boolean
}
export interface OutputConfig { name: string; enabled: boolean; width: number; height: number; refresh: number; scale: number; x: number; y: number }
export type Arrangement = 'extend' | 'mirror'
export interface Layout { arrangement: Arrangement; primary: string; outputs: OutputConfig[] }
export interface Profile { layout: Layout; wallpapers: Record<string, string> }
export interface DisplayState { outputs: OutputInfo[]; layout: Layout; wallpapers: Record<string, string>; pending: { deadline: number } | null }

const num = (v: unknown, d = 0) => (typeof v === 'number' && Number.isFinite(v) ? v : d)

/** `wlr-randr --json` with modes, position and identity (the monitor-set key needs make/model/serial). */
export function parseOutputs(text: string): OutputInfo[] {
  let data: unknown
  try { data = JSON.parse(text) } catch { return [] }
  if (!Array.isArray(data)) return []
  return data.filter((o) => o && typeof o === 'object' && typeof (o as Record<string, unknown>).name === 'string').map((o: Record<string, unknown>) => {
    const pos = (o.position ?? {}) as Record<string, unknown>
    const modes = (Array.isArray(o.modes) ? o.modes : []).map((m: Record<string, unknown>) => ({
      width: num(m.width), height: num(m.height), refresh: Math.round(num(m.refresh) * 1000) / 1000, preferred: m.preferred === true, current: m.current === true,
    }))
    return {
      name: String(o.name), description: String(o.description ?? ''), make: String(o.make ?? ''), model: String(o.model ?? ''), serial: String(o.serial ?? ''),
      enabled: o.enabled !== false, modes, x: num(pos.x), y: num(pos.y), scale: num(o.scale, 1), transform: String(o.transform ?? 'normal'),
    }
  })
}

/** Plain `wlr-randr` output (wlr-randr before 0.4 has no --json). */
export function parseOutputsText(text: string): OutputInfo[] {
  const out: OutputInfo[] = []
  let cur: OutputInfo | null = null
  let inModes = false
  const clean = (v: string) => (v.trim() === '(null)' ? '' : v.trim())
  for (const line of text.split('\n')) {
    const head = /^(\S+)(?: "(.*)")?\s*$/.exec(line)
    if (head) {
      cur = { name: head[1], description: head[2] ?? '', make: '', model: '', serial: '', enabled: true, modes: [], x: 0, y: 0, scale: 1, transform: 'normal' }
      out.push(cur)
      inModes = false
      continue
    }
    if (!cur) continue
    const mode = /^\s+(\d+)x(\d+) px(?:, ([\d.]+) Hz)?(?: \(([^)]*)\))?/.exec(line)
    if (inModes && mode) {
      const flags = mode[4] ?? ''
      cur.modes.push({ width: Number(mode[1]), height: Number(mode[2]), refresh: Math.round(Number(mode[3] ?? 0) * 1000) / 1000, preferred: flags.includes('preferred'), current: flags.includes('current') })
      continue
    }
    const kv = /^\s+([A-Za-z ]+):\s*(.*)$/.exec(line)
    if (!kv) continue
    inModes = kv[1] === 'Modes'
    const v = kv[2]
    if (kv[1] === 'Make') cur.make = clean(v)
    else if (kv[1] === 'Model') cur.model = clean(v)
    else if (kv[1] === 'Serial') cur.serial = clean(v)
    else if (kv[1] === 'Enabled') cur.enabled = v.trim() === 'yes'
    else if (kv[1] === 'Transform') cur.transform = v.trim()
    else if (kv[1] === 'Scale') cur.scale = Number(v) || 1
    else if (kv[1] === 'Position') { const [x, y] = v.split(',').map(Number); cur.x = x || 0; cur.y = y || 0 }
  }
  return out
}

// ---------- modes ----------
/** Kernel drivers whose outputs are virtual and accept any size (QEMU virtio/QXL/bochs, VMware/VirtualBox, Hyper-V),
 *  and wlroots' own nested/headless backends. Their mode list is often just the host window's size, which is why
 *  Settings used to offer a single resolution in a VM. */
export const VIRTUAL_DRIVERS = ['virtio_gpu', 'virtio-gpu', 'qxl', 'bochs', 'bochs-drm', 'vmwgfx', 'vboxvideo', 'hyperv_drm', 'cirrus', 'cirrus-qemu']
/** Firmware framebuffers: one mode, set by the firmware, that the compositor cannot change. */
export const FIXED_DRIVERS = ['simpledrm', 'simple-framebuffer', 'efifb', 'vesafb', 'ofdrm']
/** Usual desktop sizes offered on virtual outputs, up to the largest the output reports (at least 1920 × 1080). */
export const STANDARD_SIZES: [number, number][] = [
  [3840, 2160], [2560, 1600], [2560, 1440], [1920, 1200], [1920, 1080], [1680, 1050], [1600, 900], [1440, 900],
  [1366, 768], [1280, 1024], [1280, 800], [1280, 720], [1024, 768], [800, 600],
]
const MIN_W = 640, MIN_H = 480
const VIRTUAL_NAME = /^(Virtual|HEADLESS|WL|X11)-\d+$/

export const isVirtualOutput = (o: Pick<OutputInfo, 'name' | 'driver'>) => (o.driver ? VIRTUAL_DRIVERS.includes(o.driver) : VIRTUAL_NAME.test(o.name))

/** Real modes cleaned up (no zero/tiny sizes, no duplicates), plus standard sizes as custom modes on virtual outputs. */
export function withOfferedModes(o: OutputInfo): OutputInfo {
  const seen = new Set<string>()
  const modes: Mode[] = []
  for (const m of o.modes) {
    if (m.width < MIN_W || m.height < MIN_H) { if (!m.current) continue }
    const k = `${m.width}x${m.height}@${m.refresh}`
    if (seen.has(k)) continue
    seen.add(k)
    modes.push(m)
  }
  const fixedMode = !!o.driver && FIXED_DRIVERS.includes(o.driver)
  if (!fixedMode && isVirtualOutput(o)) {
    const maxW = Math.max(1920, ...modes.map((m) => m.width)), maxH = Math.max(1080, ...modes.map((m) => m.height))
    const sizes = new Set(modes.map((m) => `${m.width}x${m.height}`))
    for (const [w, h] of STANDARD_SIZES) {
      if (w > maxW || h > maxH || sizes.has(`${w}x${h}`)) continue
      modes.push({ width: w, height: h, refresh: 0, preferred: false, current: false, custom: true })
    }
  }
  return { ...o, modes, fixedMode }
}

/** Connector → kernel driver from sysfs: /sys/class/drm/card0-Virtual-1/device/driver → …/virtio_gpu. */
export function drmDrivers(root = '/sys/class/drm'): Record<string, string> {
  const out: Record<string, string> = {}
  let names: string[] = []
  try { names = readdirSync(root) } catch { return out }
  for (const n of names) {
    const m = /^card\d+-(.+)$/.exec(n)
    if (!m) continue
    try { out[m[1]] = path.basename(readlinkSync(path.join(root, n, 'device', 'driver'))) } catch { /* no driver link */ }
  }
  return out
}

/** Stable key for "this set of monitors": identity where the EDID provides it, else the connector name. */
export function monitorSetKey(outputs: Pick<OutputInfo, 'name' | 'make' | 'model' | 'serial'>[]): string {
  return outputs.map((o) => (o.make || o.model || o.serial ? `${o.make}|${o.model}|${o.serial}` : o.name)).sort().join('+')
}

/** Size an output takes in the layout (logical pixels). */
export function logicalSize(c: Pick<OutputConfig, 'width' | 'height' | 'scale'>): { width: number; height: number } {
  return { width: Math.round(c.width / c.scale), height: Math.round(c.height / c.scale) }
}

/** The layout the compositor runs now. Primary: the saved choice if still connected, else the output at 0,0. */
export function currentLayout(outputs: OutputInfo[], primary?: string, arrangement: Arrangement = 'extend'): Layout {
  const cfg = outputs.map((o) => {
    const m = o.modes.find((x) => x.current) ?? o.modes.find((x) => x.preferred) ?? o.modes[0]
    return { name: o.name, enabled: o.enabled, width: m?.width ?? 0, height: m?.height ?? 0, refresh: m?.refresh ?? 0, scale: o.scale, x: o.x, y: o.y }
  })
  const on = cfg.filter((c) => c.enabled)
  const p = on.find((c) => c.name === primary)?.name ?? [...on].sort((a, b) => a.x + a.y - (b.x + b.y))[0]?.name ?? ''
  return { arrangement: on.length > 1 ? arrangement : 'extend', primary: p, outputs: cfg }
}

export type Side = 'left' | 'right' | 'above' | 'below'

/** Puts the primary at 0,0 and every other enabled output beside it on the side given (default right), in order,
 *  without overlap. Labwc keeps outputs from overlapping, so mirror uses the same placement and fills the other
 *  outputs with a copy of the primary (`mirrorCommands`). */
export function arrange(layout: Layout, sides: Record<string, Side> = {}): Layout {
  const outs = layout.outputs.map((o) => ({ ...o }))
  const p = outs.find((o) => o.name === layout.primary && o.enabled) ?? outs.find((o) => o.enabled)
  if (!p) return { ...layout, outputs: outs }
  p.x = 0; p.y = 0
  const ps = logicalSize(p)
  const edge = { left: 0, right: ps.width, above: 0, below: ps.height }
  for (const o of outs) {
    if (o === p || !o.enabled) continue
    const s = logicalSize(o)
    const side = sides[o.name] ?? 'right'
    if (side === 'right') { o.x = edge.right; o.y = 0; edge.right += s.width }
    else if (side === 'left') { edge.left -= s.width; o.x = edge.left; o.y = 0 }
    else if (side === 'below') { o.x = 0; o.y = edge.below; edge.below += s.height }
    else { edge.above -= s.height; o.x = 0; o.y = edge.above }
  }
  // Labwc wants non-negative coordinates: shift everything so the top-left output sits at 0,0.
  const on = outs.filter((o) => o.enabled)
  const dx = Math.min(...on.map((o) => o.x)), dy = Math.min(...on.map((o) => o.y))
  for (const o of on) { o.x -= dx; o.y -= dy }
  return { ...layout, primary: p.name, outputs: outs }
}

/** Why a layout can't be applied to these outputs, or null. */
export function validateLayout(layout: Layout, outputs: OutputInfo[]): string | null {
  const byName = new Map(outputs.map((o) => [o.name, o]))
  if (!['extend', 'mirror'].includes(layout.arrangement)) return 'bad_arrangement'
  const on = layout.outputs.filter((o) => o.enabled)
  if (!on.length) return 'no_enabled_output'
  if (!on.some((o) => o.name === layout.primary)) return 'bad_primary'
  for (const c of layout.outputs) {
    const o = byName.get(c.name)
    if (!o) return 'unknown_output'
    if (!c.enabled) continue
    if (!(c.scale >= MIN_SCALE && c.scale <= MAX_SCALE)) return 'bad_scale'
    if (!o.modes.some((m) => m.width === c.width && m.height === c.height && Math.abs(m.refresh - c.refresh) < 0.01)) return 'bad_mode'
    if (o.fixedMode && !o.modes.some((m) => m.current && m.width === c.width && m.height === c.height)) return 'fixed_mode'
    if (!Number.isInteger(c.x) || !Number.isInteger(c.y) || c.x < 0 || c.y < 0) return 'bad_position'
  }
  return null
}

/** wlr-randr arguments for a layout: one invocation sets every output at once (atomic in wlroots). */
export function randrArgs(layout: Layout, outputs: OutputInfo[] = []): string[] {
  const args: string[] = []
  const ordered = [...layout.outputs].sort((a, b) => Number(b.enabled) - Number(a.enabled))
  for (const c of ordered) {
    args.push('--output', c.name)
    if (!c.enabled) { args.push('--off'); continue }
    // Virtual outputs report no refresh rate; wlr-randr then only matches the bare size. Sizes the output does not
    // list (offered on virtual GPUs) go as a custom mode.
    const m = outputs.find((o) => o.name === c.name)?.modes.find((x) => x.width === c.width && x.height === c.height && Math.abs(x.refresh - c.refresh) < 0.01)
    const mode = c.refresh > 0 ? `${c.width}x${c.height}@${c.refresh}Hz` : `${c.width}x${c.height}`
    args.push('--on', m?.custom ? '--custom-mode' : '--mode', mode, '--pos', `${c.x},${c.y}`, '--scale', String(c.scale))
  }
  return args
}

/** Logical rectangle of each enabled output: where the shell puts its desktop/panel window for that monitor. */
export function outputRects(layout: Layout): { name: string; primary: boolean; x: number; y: number; width: number; height: number }[] {
  return layout.outputs.filter((o) => o.enabled && (layout.arrangement === 'extend' || o.name === layout.primary))
    .map((o) => ({ name: o.name, primary: o.name === layout.primary, x: o.x, y: o.y, ...logicalSize(o) }))
}

/** Mirror: one wl-mirror per secondary output, fullscreen on it, showing the primary. */
export function mirrorCommands(layout: Layout): [string, string[]][] {
  if (layout.arrangement !== 'mirror') return []
  return layout.outputs.filter((o) => o.enabled && o.name !== layout.primary)
    .map((o) => ['wl-mirror', ['--fullscreen-output', o.name, layout.primary]])
}

// ---------- persistence ----------
export interface StoreFile { version: 1; profiles: Record<string, Profile> }

export function readStore(file: string): StoreFile {
  try {
    const d = JSON.parse(readFileSync(file, 'utf8')) as StoreFile
    if (d && d.version === 1 && d.profiles && typeof d.profiles === 'object') return d
  } catch { /* missing or corrupt: start empty */ }
  return { version: 1, profiles: {} }
}

export function writeStore(file: string, data: StoreFile): void {
  mkdirSync(path.dirname(file), { recursive: true })
  const tmp = `${file}.tmp`
  writeFileSync(tmp, JSON.stringify(data, null, 2), { mode: 0o600 })
  renameSync(tmp, file)
}

// ---------- revert timer ----------
export interface Clock { now(): number; setTimeout(fn: () => void, ms: number): unknown; clearTimeout(t: unknown): void }
export const realClock: Clock = { now: () => Date.now(), setTimeout: (fn, ms) => setTimeout(fn, ms), clearTimeout: (t) => clearTimeout(t as ReturnType<typeof setTimeout>) }

/** "Keep these settings?": reverts unless confirmed before the deadline. Starting again replaces the pending one
 *  without reverting (the new change's revert target is the layout before the first change). */
export class RevertTimer {
  private timer: unknown = null
  deadline: number | null = null
  constructor(private clock: Clock = realClock, private seconds = REVERT_SECONDS) {}

  start(onRevert: () => void): number {
    this.cancel()
    this.deadline = this.clock.now() + this.seconds * 1000
    this.timer = this.clock.setTimeout(() => { this.timer = null; this.deadline = null; onRevert() }, this.seconds * 1000)
    return this.deadline
  }

  get pending(): boolean { return this.timer !== null }

  /** Stops the countdown; true if one was running. */
  cancel(): boolean {
    if (this.timer === null) return false
    this.clock.clearTimeout(this.timer)
    this.timer = null
    this.deadline = null
    return true
  }
}

// ---------- manager ----------
export type Result<T> = { ok: true; value: T } | { ok: false; error: string }

export type Spawn = (cmd: string, args: string[]) => { kill(): void }

/** Whether the compositor now runs what was asked: wlroots may accept a mode and fall back to another. */
export function layoutMatches(layout: Layout, outputs: OutputInfo[]): boolean {
  return layout.outputs.every((c) => {
    const o = outputs.find((x) => x.name === c.name)
    if (!o) return false
    if (!c.enabled) return !o.enabled
    const m = o.modes.find((x) => x.current)
    // wlroots may refuse a scale and keep the old one: compare it too (it reports fractions like 1.250000).
    if (o.enabled && Math.abs(o.scale - c.scale) > 0.02) return false
    if (!m) return o.enabled   // no current mode reported (some custom modes): nothing to compare
    return o.enabled && m.width === c.width && m.height === c.height && (c.refresh <= 0 || m.refresh <= 0 || Math.abs(m.refresh - c.refresh) < 0.5)
  })
}

export function displayManager(opts: { exec: Exec; storeFile: string; clock?: Clock; spawn?: Spawn; onChange?: (s: DisplayState) => void; settle?: (layout: Layout) => Promise<void>; drivers?: () => Record<string, string> }) {
  const { exec, storeFile } = opts
  const drivers = opts.drivers ?? (() => drmDrivers())
  let arrangement: Arrangement = 'extend'
  let mirrors: { kill(): void }[] = []
  const mirror = (layout: Layout) => {
    for (const m of mirrors) m.kill()
    mirrors = opts.spawn ? mirrorCommands(layout).map(([c, a]) => opts.spawn!(c, a)) : []
  }
  const timer = new RevertTimer(opts.clock)
  let previous: { layout: Layout; wallpapers: Record<string, string> } | null = null
  let primary: string | undefined
  let wallpapers: Record<string, string> = {}
  // The layout the countdown is running for: "Keep" saves exactly this, not a re-read taken while the compositor
  // may still be settling after a scale change (#60).
  let applied: Layout | null = null
  // Our own wlr-randr makes the compositor report OutputsChanged, which also calls applySaved(): while a change is
  // being applied that must not put the old saved layout back (#60).
  let applying = 0

  async function read(): Promise<Result<OutputInfo[]>> {
    const r = await exec('wlr-randr', ['--json'])
    let raw: OutputInfo[]
    if (r.code === 0) raw = parseOutputs(r.stdout)
    else if (r.missing) return { ok: false, error: 'missing_wlr_randr' }
    else {
      const t = await exec('wlr-randr', [])
      if (t.code !== 0) return { ok: false, error: 'wlr_randr_failed' }
      raw = parseOutputsText(t.stdout)
    }
    const d = drivers()
    return { ok: true, value: raw.map((o) => withOfferedModes({ ...o, driver: d[o.name] })) }
  }
  async function run(layout: Layout, outputs: OutputInfo[] = []): Promise<Result<true>> {
    const r = await exec('wlr-randr', randrArgs(layout, outputs))
    if (r.code !== 0) return { ok: false, error: r.missing ? 'missing_wlr_randr' : 'apply_failed' }
    arrangement = layout.arrangement
    primary = layout.primary
    mirror(layout)
    return { ok: true, value: true }
  }
  async function state(): Promise<Result<DisplayState>> {
    const o = await read()
    if (!o.ok) return o
    const connected = o.value.filter((x) => x.modes.length > 0 || x.enabled)
    return { ok: true, value: { outputs: connected, layout: currentLayout(connected, primary, arrangement), wallpapers, pending: timer.deadline ? { deadline: timer.deadline } : null } }
  }
  async function emit() { const s = await state(); if (s.ok) opts.onChange?.(s.value) }
  // Waits until the shell's windows are redrawn at the layout's geometry (main.ts): the countdown and its Keep button
  // must not appear while what is drawn and where clicks land still disagree (#60). Never fails the change.
  async function settle(layout: Layout) {
    await emit()
    try { await opts.settle?.(layout) } catch { /* the countdown still starts */ }
  }

  return {
    timer,
    state,
    /** Applies a layout (and wallpapers) and starts the revert countdown. */
    async apply(layout: Layout, walls: Record<string, string> = wallpapers): Promise<Result<{ deadline: number }>> {
      applying++
      try { return await this.applyNow(layout, walls) } finally { applying-- }
    },
    async applyNow(layout: Layout, walls: Record<string, string>): Promise<Result<{ deadline: number }>> {
      const o = await read()
      if (!o.ok) return o
      const err = validateLayout(layout, o.value)
      if (err) return { ok: false, error: err }
      const before = currentLayout(o.value, primary, arrangement)
      if (!timer.pending) previous = { layout: before, wallpapers }
      const r = await run(layout, o.value)
      // A refused or silently substituted mode goes straight back to what ran before, without a countdown.
      const after = r.ok ? await read() : null
      if (!r.ok || (after?.ok && !layoutMatches(layout, after.value))) {
        await run(timer.pending && previous ? previous.layout : before, o.value)
        void emit()
        return { ok: false, error: r.ok ? 'mode_not_applied' : r.error }
      }
      primary = layout.primary
      wallpapers = walls
      applied = layout
      await settle(layout)
      const deadline = timer.start(() => { void this.revert() })
      void emit()
      return { ok: true, value: { deadline } }
    },
    /** "Keep changes": stops the countdown and saves the layout for this monitor set. The layout stays applied even
     *  when saving fails; the error says it will not come back at the next sign-in (#60). */
    async confirm(): Promise<Result<true>> {
      timer.cancel()
      previous = null
      const keep = applied
      applied = null
      const o = await read()
      if (!o.ok) return o
      try {
        const store = readStore(storeFile)
        const key = monitorSetKey(o.value)
        // Only outputs still connected; the applied layout wins over a re-read taken mid-reconfigure.
        const layout = keep && keep.outputs.every((c) => o.value.some((x) => x.name === c.name)) ? keep : currentLayout(o.value, primary, arrangement)
        store.profiles[key] = { layout, wallpapers }
        writeStore(storeFile, store)
      } catch {
        void emit()
        return { ok: false, error: 'save_failed' }
      }
      void emit()
      return { ok: true, value: true }
    },
    async revert(): Promise<Result<true>> {
      timer.cancel()
      const p = previous
      previous = null
      applied = null
      if (!p) return { ok: true, value: true }
      primary = p.layout.primary
      wallpapers = p.wallpapers
      const o = await read()
      const r = await run(p.layout, o.ok ? o.value : [])
      // Back to the old layout and the old shell geometry together, before anything else is applied.
      applying++
      try { await settle(p.layout) } finally { applying-- }
      void emit()
      return r
    },
    /** Wallpaper only: no revert needed, saved straight away. */
    async setWallpaper(output: string, id: string): Promise<Result<true>> {
      wallpapers = { ...wallpapers, [output]: id }
      if (!timer.pending) {
        const o = await read()
        if (o.ok) {
          const store = readStore(storeFile)
          const key = monitorSetKey(o.value)
          store.profiles[key] = { layout: store.profiles[key]?.layout ?? currentLayout(o.value, primary, arrangement), wallpapers }
          try { writeStore(storeFile, store) } catch { void emit(); return { ok: false, error: 'save_failed' } }
        }
      }
      void emit()
      return { ok: true, value: true }
    },
    /** At login and on hotplug: re-applies what was saved for the connected monitor set (no countdown). */
    async applySaved(): Promise<Result<boolean>> {
      if (timer.pending || applying) return { ok: true, value: false }
      const o = await read()
      if (!o.ok) return o
      const saved = readStore(storeFile).profiles[monitorSetKey(o.value)]
      if (!saved) {
        primary = undefined
        arrangement = 'extend'
        mirror(currentLayout(o.value))
        void emit()
        return { ok: true, value: false }
      }
      wallpapers = saved.wallpapers ?? {}
      primary = saved.layout.primary
      if (validateLayout(saved.layout, o.value)) { void emit(); return { ok: true, value: false } }
      const r = await run(saved.layout, o.value)
      void emit()
      return r.ok ? { ok: true, value: true } : r
    },
  }
}
export type DisplayManager = ReturnType<typeof displayManager>

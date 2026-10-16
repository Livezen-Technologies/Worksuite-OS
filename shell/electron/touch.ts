// Touchscreen, pen and touch (tablet) mode, plus the on-screen keyboard (Settings › Touchscreen & pen, Settings ›
// Keyboard, Quick settings). Same rules as system.ts: stock CLIs with fixed argument arrays, never a shell.
//   detection   udevadm (ID_INPUT_TOUCHSCREEN / ID_INPUT_TABLET / ID_INPUT_SWITCH, no privileges needed), with
//               `libinput list-devices` used instead when it can read the devices;
//   on/off, map Labwc rc.xml: <libinput><device category="NAME"><sendEventsMode> and <touch deviceName mapToOutput>,
//               written into the user's Labwc config dir (~/.config/worksuite/labwc, set up by worksuite-session)
//               and loaded with `labwc --reconfigure`;
//   tablet mode SW_TABLET_MODE from `libinput debug-events --device` on the switch (udev gives the seat user access
//               to switches and pens: services/session/udev/70-worksuite-touch.rules);
//   rotation    `monitor-sensor --accel` (iio-sensor-proxy) → `wlr-randr --output <internal> --transform`;
//   keyboard    wvkbd (wvkbd-mobintl, virtual-keyboard-v1 + layer-shell, both supported by Labwc), started hidden and
//               shown/hidden with SIGUSR2/SIGUSR1. Its keys go through fcitx5 like a hardware keyboard, so the
//               Sinhala and Tamil m17n methods turn the Latin layout into Sinhala or Tamil.
// Settings are per user in ~/.config/worksuite/touch.json and applied when the shell starts at login.
import { spawn } from 'node:child_process'
import { lstatSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { realExec, type Avail, type Exec } from './system'

// ---------- devices ----------
export type DevKind = 'touchscreen' | 'tablet' | 'tablet-pad' | 'switch'
export interface InputDev { name: string; node: string; kinds: DevKind[]; tabletModeSwitch: boolean }

/** `libinput list-devices`: blocks of "Key: value" lines separated by blank lines. */
export function parseLibinputDevices(text: string): InputDev[] {
  const out: InputDev[] = []
  for (const block of text.split(/\n\s*\n/)) {
    const kv: Record<string, string> = {}
    for (const line of block.split('\n')) { const m = /^([A-Za-z][A-Za-z ]*?):\s+(.*)$/.exec(line.trim()); if (m) kv[m[1]] = m[2].trim() }
    if (!kv.Device || !kv.Kernel) continue
    const caps = (kv.Capabilities ?? '').split(/\s+/)
    const kinds: DevKind[] = []
    if (caps.includes('touch')) kinds.push('touchscreen')
    if (caps.includes('tablet')) kinds.push('tablet')
    if (caps.includes('tablet-pad')) kinds.push('tablet-pad')
    if (caps.includes('switch')) kinds.push('switch')
    if (!kinds.length) continue
    out.push({ name: kv.Device, node: kv.Kernel, kinds, tabletModeSwitch: kinds.includes('switch') && /tablet|intel.?hid|convertible|asus|thinkpad|switch/i.test(kv.Device) })
  }
  return out
}

/** `udevadm info -q property -n /dev/input/eventN` → a device, or null when it is none of ours. */
export function parseUdevProps(node: string, text: string): InputDev | null {
  const p: Record<string, string> = {}
  for (const line of text.split('\n')) { const i = line.indexOf('='); if (i > 0) p[line.slice(0, i)] = line.slice(i + 1).trim() }
  const kinds: DevKind[] = []
  if (p.ID_INPUT_TOUCHSCREEN === '1') kinds.push('touchscreen')
  if (p.ID_INPUT_TABLET === '1') kinds.push(p.ID_INPUT_TABLET_PAD === '1' ? 'tablet-pad' : 'tablet')
  if (p.ID_INPUT_SWITCH === '1') kinds.push('switch')
  if (!kinds.length) return null
  const name = (p.NAME ?? p.ID_MODEL ?? path.basename(node)).replace(/^"|"$/g, '').replace(/\\x20/g, ' ')
  // A first guess from the name; detect() checks the SW_TABLET_MODE bit in sysfs when it can.
  return { name, node, kinds, tabletModeSwitch: kinds.includes('switch') && /tablet|intel.?hid|convertible/i.test(name) }
}

/** `SW=` capability bitmask from /sys/class/input/eventN/device/capabilities/sw: SW_TABLET_MODE is bit 1. */
export const hasTabletModeBit = (sw: string) => { const last = sw.trim().split(/\s+/).pop() ?? '0'; return (parseInt(last, 16) & 0x2) !== 0 }

// ---------- events ----------
export type SwitchEvent = { switch: 'tablet-mode' | 'lid'; on: boolean }
/** `libinput debug-events` line, e.g. " event7   SWITCH_TOGGLE   +2.10s	switch tablet-mode state 1". */
export function parseSwitchLine(line: string): SwitchEvent | null {
  const m = /SWITCH_TOGGLE.*switch (tablet-mode|lid) state (\d)/.exec(line)
  return m ? { switch: m[1] as SwitchEvent['switch'], on: m[2] === '1' } : null
}

export type PenEvent = { pressure?: number; button?: string; pressed?: boolean; proximity?: boolean }
/** Tablet tool lines from `libinput debug-events`: pressure axis, stylus buttons and proximity. */
export function parsePenLine(line: string): PenEvent | null {
  if (/TABLET_TOOL_PROXIMITY/.test(line)) return { proximity: /proximity-in/.test(line) }
  const b = /TABLET_TOOL_BUTTON.*\((BTN_[A-Z0-9_]+)\),?\s*(pressed|released)/.exec(line)
  if (b) return { button: b[1], pressed: b[2] === 'pressed' }
  const p = /TABLET_TOOL_(?:AXIS|TIP).*pressure:\s*([0-9.]+)/.exec(line)
  return p ? { pressure: Math.max(0, Math.min(1, Number(p[1]))) } : null
}

export type Orientation = 'normal' | 'left-up' | 'right-up' | 'bottom-up'
/** `monitor-sensor --accel`: "=== Has accelerometer (orientation: normal)" and "Accelerometer orientation changed: left-up". */
export function parseOrientation(line: string): Orientation | null {
  const m = /orientation(?: changed)?:\s*(normal|left-up|right-up|bottom-up)/.exec(line)
  return m ? (m[1] as Orientation) : null
}
/** wlr-randr transform for an accelerometer orientation (the panel rotates against the device). */
export const TRANSFORM: Record<Orientation, string> = { normal: 'normal', 'left-up': '90', 'right-up': '270', 'bottom-up': '180' }

// ---------- settings ----------
export type OskMode = 'off' | 'touch' | 'always'
export type TabletMode = 'auto' | 'on' | 'off'
export interface TouchSettings {
  touchEnabled: boolean
  /** device name → output name ('' = all outputs). */
  mapToOutput: Record<string, string>
  tabletMode: TabletMode
  rotationLock: boolean
  osk: OskMode
  oskSize: 'small' | 'medium' | 'large'
  /** device name → libinput calibration matrix (6 numbers, row-major a b c d e f), set by Touch calibration. */
  calibration: Record<string, number[]>
}
export const DEFAULT_TOUCH: TouchSettings = { touchEnabled: true, mapToOutput: {}, tabletMode: 'auto', rotationLock: false, osk: 'touch', oskSize: 'medium', calibration: {} }

/** A usable calibration matrix: six finite numbers, scale terms within ±4 and offsets within ±2 (a sane touchscreen). */
export function validMatrix(m: unknown): m is number[] {
  return Array.isArray(m) && m.length === 6 && m.every((x) => typeof x === 'number' && Number.isFinite(x))
    && [0, 1, 3, 4].every((i) => Math.abs(m[i]) <= 4) && [2, 5].every((i) => Math.abs(m[i]) <= 2)
}
const SAFE_NAME = /^[\w .,:()/+-]{1,80}$/

export function normalizeTouch(v: unknown): TouchSettings {
  const o = (v && typeof v === 'object' ? v : {}) as Record<string, unknown>
  const map: Record<string, string> = {}
  if (o.mapToOutput && typeof o.mapToOutput === 'object') {
    for (const [k, out] of Object.entries(o.mapToOutput as Record<string, unknown>)) if (SAFE_NAME.test(k) && typeof out === 'string' && /^[\w.-]{0,32}$/.test(out)) map[k] = out
  }
  const cal: Record<string, number[]> = {}
  if (o.calibration && typeof o.calibration === 'object') {
    for (const [k, m] of Object.entries(o.calibration as Record<string, unknown>)) if (SAFE_NAME.test(k) && validMatrix(m)) cal[k] = m.map((x) => Math.round(x * 1e6) / 1e6)
  }
  return {
    touchEnabled: o.touchEnabled !== false,
    mapToOutput: map,
    calibration: cal,
    tabletMode: o.tabletMode === 'on' || o.tabletMode === 'off' ? o.tabletMode : 'auto',
    rotationLock: o.rotationLock === true,
    osk: o.osk === 'off' || o.osk === 'always' ? o.osk : 'touch',
    oskSize: o.oskSize === 'small' || o.oskSize === 'large' ? o.oskSize : 'medium',
  }
}
export function loadTouch(file: string): TouchSettings {
  try { return normalizeTouch(JSON.parse(readFileSync(file, 'utf8'))) } catch { return { ...DEFAULT_TOUCH } }
}
export function saveTouch(file: string, s: TouchSettings) {
  mkdirSync(path.dirname(file), { recursive: true })
  writeFileSync(`${file}.tmp`, JSON.stringify(normalizeTouch(s), null, 2))
  renameSync(`${file}.tmp`, file)
}

/** Touch mode is on when forced on, or in auto mode while the convertible reports tablet mode. */
export const touchModeOn = (s: TouchSettings, tabletSwitch: boolean) => s.tabletMode === 'on' || (s.tabletMode === 'auto' && tabletSwitch)
export const oskWanted = (s: TouchSettings, touchMode: boolean) => s.osk === 'always' || (s.osk === 'touch' && touchMode)

// ---------- Labwc config ----------
const BEGIN = '<!-- worksuite-touch:begin (Settings › Touchscreen & pen; rewritten by the shell) -->'
const END = '<!-- worksuite-touch:end -->'
const xmlAttr = (s: string) => s.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;')

/** The managed rc.xml block for the touchscreens present. */
export function labwcTouchBlock(s: TouchSettings, screens: string[]): string {
  const lines: string[] = []
  for (const name of screens) {
    if (!SAFE_NAME.test(name)) continue
    const out = s.mapToOutput[name]
    if (out) lines.push(`  <touch deviceName="${xmlAttr(name)}" mapToOutput="${xmlAttr(out)}" mouseEmulation="no" />`)
  }
  const devs = screens.filter((n) => SAFE_NAME.test(n))
  if (devs.length) {
    lines.push('  <libinput>')
    for (const name of devs) {
      const m = s.calibration[name]
      const cal = m && validMatrix(m) ? `<calibrationMatrix>${m.join(' ')}</calibrationMatrix>` : ''
      lines.push(`    <device category="${xmlAttr(name)}"><sendEventsMode>${s.touchEnabled ? 'yes' : 'no'}</sendEventsMode>${cal}</device>`)
    }
    lines.push('  </libinput>')
  }
  return [BEGIN, ...lines, END].join('\n')
}

/** Puts the block into rc.xml (replacing an earlier one) just before </labwc_config>. */
export function mergeRcXml(rc: string, block: string): string {
  const start = rc.indexOf(BEGIN), end = rc.indexOf(END)
  const base = start >= 0 && end > start ? rc.slice(0, start) + rc.slice(end + END.length).replace(/^\n/, '') : rc
  const close = base.lastIndexOf('</labwc_config>')
  if (close < 0) return `${base.trimEnd()}\n${block}\n`
  return `${base.slice(0, close)}${block}\n${base.slice(close)}`
}

// ---------- on-screen keyboard ----------
/** wvkbd-mobintl layouts for fcitx5/xkb keyboard ids. Sinhala and Tamil have no wvkbd layout: they use the Latin
 *  layout and fcitx5's m17n methods (Wijesekara, Singlish, Tamil99, phonetic) do the conversion. */
const WVKBD_LAYOUT: Record<string, string> = { us: 'full', gb: 'full', ru: 'cyrillic', ua: 'cyrillic', ar: 'arabic', ir: 'persian', gr: 'greek', il: 'hebrew', ge: 'georgian', kr: 'korean' }
export function oskLayouts(methods: string[]): string[] {
  const out = ['full']
  for (const m of methods) {
    const k = /^keyboard-([a-z]{2})/.exec(m)?.[1]
    const l = k ? WVKBD_LAYOUT[k] : undefined
    if (l && !out.includes(l)) out.push(l)
  }
  return [...out, 'special']
}
export const OSK_HEIGHT = { small: 200, medium: 260, large: 340 } as const
/** wvkbd colours from the OSKeyboard board (keys over rgba(7,19,48,.97), pressed #2A4A8F, text #E8EEFA). */
export const OSK_COLORS = ['--bg', '071330f7', '--fg', '1a2c51', '--fg-sp', '0f1e3e', '--press', '2a4a8f', '--press-sp', '1f6bff', '--text', 'e8eefa', '--text-sp', 'c9d6ee']
export function oskArgs(s: TouchSettings, methods: string[]): string[] {
  const h = OSK_HEIGHT[s.oskSize]
  return ['--hidden', '-H', String(h), '-L', String(Math.round(h * 0.8)), '-l', oskLayouts(methods).join(','), '--fn', 'IBM Plex Sans 16', ...OSK_COLORS]
}

// ---------- host ----------
export interface TouchState {
  devices: InputDev[]
  settings: TouchSettings
  tabletSwitch: boolean
  touchMode: boolean
  orientation: Orientation | null
  hasAccelerometer: boolean
  osk: { available: boolean; visible: boolean }
  outputs: string[]
}
type Handle = (channel: string, fn: (...args: string[]) => unknown) => void
interface Proc { kill(sig?: NodeJS.Signals): void; onLine(cb: (l: string) => void): void; onExit(cb: () => void): void }
export type Spawn = (cmd: string, args: string[]) => Proc | null

const realSpawn: Spawn = (cmd, args) => {
  try {
    const p = spawn(cmd, args, { stdio: ['ignore', 'pipe', 'ignore'], env: { ...process.env, LC_ALL: 'C' } })
    p.on('error', () => undefined)
    let buf = ''
    const subs: ((l: string) => void)[] = []
    p.stdout?.setEncoding('utf8')
    p.stdout?.on('data', (c: string) => { buf += c; let i; while ((i = buf.indexOf('\n')) >= 0) { const l = buf.slice(0, i); buf = buf.slice(i + 1); subs.forEach((f) => f(l)) } })
    return { kill: (sig) => { p.kill(sig) }, onLine: (cb) => { subs.push(cb) }, onExit: (cb) => { p.on('exit', cb) } }
  } catch { return null }
}

export function touchBridge(home: string, exec: Exec = realExec, spawnFn: Spawn = realSpawn, sysLabwc = '/etc/xdg/worksuite/labwc') {
  const file = path.join(home, '.config', 'worksuite', 'touch.json')
  const labwcDir = path.join(home, '.config', 'worksuite', 'labwc')
  const st: TouchState = { devices: [], settings: loadTouch(file), tabletSwitch: false, touchMode: false, orientation: null, hasAccelerometer: false, osk: { available: false, visible: false }, outputs: [] }
  let listener: (s: TouchState) => void = () => {}
  let osk: Proc | null = null
  let switchWatch: Proc | null = null
  let sensor: Proc | null = null
  let pen: Proc | null = null

  const emit = () => listener(structuredClone(st))

  async function detect(): Promise<InputDev[]> {
    const li = await exec('libinput', ['list-devices'])
    if (li.code === 0 && li.stdout.includes('Device:')) return parseLibinputDevices(li.stdout)
    const ls = await exec('ls', ['/sys/class/input'])
    const out: InputDev[] = []
    for (const ev of ls.stdout.split(/\s+/).filter((n) => /^event\d+$/.test(n))) {
      const r = await exec('udevadm', ['info', '-q', 'property', '-n', `/dev/input/${ev}`])
      const d = r.code === 0 ? parseUdevProps(`/dev/input/${ev}`, r.stdout) : null
      if (!d) continue
      if (d.kinds.includes('switch')) { try { d.tabletModeSwitch = hasTabletModeBit(readFileSync(`/sys/class/input/${ev}/device/capabilities/sw`, 'utf8')) } catch { /* keep the name guess */ } }
      out.push(d)
    }
    return out
  }

  async function outputs(): Promise<string[]> {
    const r = await exec('wlr-randr', ['--json'])
    try { return (JSON.parse(r.stdout) as { name: string }[]).map((o) => o.name) } catch { return [] }
  }

  async function writeLabwc(): Promise<Avail<true>> {
    const screens = st.devices.filter((d) => d.kinds.includes('touchscreen')).map((d) => d.name)
    try {
      const sysRc = path.join(sysLabwc, 'rc.xml')
      const userRc = path.join(labwcDir, 'rc.xml')
      const base = readFileSync(sysRc, 'utf8')
      mkdirSync(labwcDir, { recursive: true })
      // worksuite-session starts Labwc with this dir; rc.xml starts as a symlink to the system file.
      try { if (lstatSync(userRc).isSymbolicLink()) unlinkSync(userRc) } catch { /* absent */ }
      writeFileSync(`${userRc}.tmp`, mergeRcXml(base, labwcTouchBlock(st.settings, screens)))
      renameSync(`${userRc}.tmp`, userRc)
    } catch { return { available: false, reason: 'labwc_config' } }
    const r = await exec('labwc', ['--reconfigure'])
    return r.code === 0 ? { available: true, value: true } : { available: false, reason: r.missing ? 'labwc_missing' : 'labwc_reload' }
  }

  function setOskVisible(v: boolean) {
    if (!osk) return
    osk.kill(v ? 'SIGUSR2' : 'SIGUSR1')
    st.osk.visible = v
  }
  function startOsk() {
    if (osk) return
    let methods: string[] = []
    try { methods = readFileSync(path.join(home, '.config', 'fcitx5', 'profile'), 'utf8').split('\n').map((l) => /^Name=(.+)$/.exec(l.trim())?.[1] ?? '').filter(Boolean) } catch { /* default layout */ }
    osk = spawnFn('wvkbd-mobintl', oskArgs(st.settings, methods))
    st.osk = { available: !!osk, visible: false }
    osk?.onExit(() => { osk = null; st.osk = { available: false, visible: false }; emit() })
  }
  function stopOsk() { osk?.kill('SIGTERM'); osk = null; st.osk.visible = false }

  async function rotate(o: Orientation) {
    st.orientation = o
    if (st.settings.rotationLock || !st.touchMode) return
    const internal = st.outputs.find((n) => /^(eDP|LVDS|DSI)/.test(n))
    if (internal) await exec('wlr-randr', ['--output', internal, '--transform', TRANSFORM[o]])
  }

  async function refreshMode() {
    const was = st.touchMode
    st.touchMode = touchModeOn(st.settings, st.tabletSwitch)
    // Off → on re-reads the sensor; on → off puts the panel back upright.
    if (was && !st.touchMode) { const internal = st.outputs.find((n) => /^(eDP|LVDS|DSI)/.test(n)); if (internal) await exec('wlr-randr', ['--output', internal, '--transform', 'normal']) }
    if (!was && st.touchMode && st.orientation) await rotate(st.orientation)
    if (st.settings.osk === 'off') stopOsk(); else startOsk()
    if (!oskWanted(st.settings, st.touchMode)) setOskVisible(false)
    emit()
  }

  function watch() {
    const sw = st.devices.find((d) => d.tabletModeSwitch)
    if (sw && !switchWatch) {
      switchWatch = spawnFn('libinput', ['debug-events', '--device', sw.node])
      switchWatch?.onLine((l) => { const e = parseSwitchLine(l); if (e?.switch === 'tablet-mode') { st.tabletSwitch = e.on; void refreshMode() } })
      switchWatch?.onExit(() => { switchWatch = null })
    }
    if (!sensor) {
      sensor = spawnFn('monitor-sensor', ['--accel'])
      sensor?.onLine((l) => {
        if (/Has accelerometer/.test(l)) st.hasAccelerometer = true
        const o = parseOrientation(l)
        if (o) { st.hasAccelerometer = true; void rotate(o).then(emit) }
      })
      sensor?.onExit(() => { sensor = null })
    }
  }

  return {
    onChange(cb: (s: TouchState) => void) { listener = cb },
    async start() {
      st.devices = await detect(); st.outputs = await outputs()
      if (st.devices.some((d) => d.kinds.includes('touchscreen'))) await writeLabwc()
      watch()
      await refreshMode()
    },
    async state(): Promise<Avail<TouchState>> {
      st.devices = await detect(); st.outputs = await outputs()
      return { available: true, value: structuredClone(st) }
    },
    async set(json: string): Promise<Avail<TouchState>> {
      let next: TouchSettings
      try { next = normalizeTouch({ ...st.settings, ...JSON.parse(json) }) } catch { return { available: false, reason: 'bad_settings' } }
      const labwc = next.touchEnabled !== st.settings.touchEnabled || JSON.stringify(next.mapToOutput) !== JSON.stringify(st.settings.mapToOutput)
        || JSON.stringify(next.calibration) !== JSON.stringify(st.settings.calibration)
      const restartOsk = next.oskSize !== st.settings.oskSize
      st.settings = next
      try { saveTouch(file, next) } catch { return { available: false, reason: 'save_failed' } }
      if (labwc) { const r = await writeLabwc(); if (!r.available) return r }
      if (restartOsk) stopOsk()
      await refreshMode()
      return { available: true, value: structuredClone(st) }
    },
    /** Taskbar button / text-field focus: show or hide the keyboard. */
    osk(show: boolean): Avail<boolean> {
      if (st.settings.osk === 'off' && show) return { available: false, reason: 'osk_off' }
      startOsk()
      if (!osk) return { available: false, reason: 'osk_missing' }
      setOskVisible(show); emit()
      return { available: true, value: show }
    },
    /** Pen test: streams tablet tool events until stopped. */
    penTest(on: boolean, cb: (e: PenEvent) => void): Avail<true> {
      pen?.kill(); pen = null
      if (!on) return { available: true, value: true }
      const dev = st.devices.find((d) => d.kinds.includes('tablet'))
      if (!dev) return { available: false, reason: 'no_pen' }
      pen = spawnFn('libinput', ['debug-events', '--device', dev.node])
      if (!pen) return { available: false, reason: 'libinput_missing' }
      pen.onLine((l) => { const e = parsePenLine(l); if (e) cb(e) })
      return { available: true, value: true }
    },
    stop() { [osk, switchWatch, sensor, pen].forEach((p) => p?.kill()) },
  }
}

export function startTouchHost(handle: Handle, broadcast: (ch: string, p: unknown) => void, home: string, b = touchBridge(home)) {
  b.onChange((s) => broadcast('ws:touchChanged', s))
  handle('ws:touchState', () => b.state())
  handle('ws:touchSet', (json) => b.set(json))
  handle('ws:oskShow', (on) => b.osk(on === '1'))
  handle('ws:penTest', (on) => b.penTest(on === '1', (e) => broadcast('ws:penEvent', e)))
  void b.start()
  return b
}


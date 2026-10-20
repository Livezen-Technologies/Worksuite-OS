// Settings › Mouse & touchpad (#35): pointer speed and acceleration, scroll speed and direction, primary button,
// and touchpad tap-to-click, tap-and-drag, drag lock, scroll method, click method, disable-while-typing and on/off.
//   detection  `libinput list-devices` (pointer devices and what each supports: tap, natural scrolling, scroll and
//              click methods, acceleration profiles), joined with udev's ID_INPUT_MOUSE / ID_INPUT_TOUCHPAD for every
//              node libinput could not open, and /proc/bus/input/devices when udevadm is missing too (#44). People
//              are not in the `input` group, so on real hardware libinput usually opens nothing (or only the nodes
//              logind gives the seat user) and exits 0: its output alone is never taken as "no mouse, no touchpad".
//              Devices only udev or /proc know get the usual features of their kind;
//   applying   a managed <libinput> block (categories "non-touch" and "touchpad") in the user's Labwc rc.xml
//              (~/.config/worksuite/labwc/rc.xml), loaded with `labwc --reconfigure`: no restart or re-login;
//   saving     per user in ~/.config/worksuite/pointer.json, and the rc.xml block itself survives logout and reboot.
// Same rules as system.ts: stock CLIs with fixed argument arrays, never a shell.
import { lstatSync, mkdirSync, readFileSync, readdirSync, renameSync, unlinkSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { realExec, type Avail, type Exec } from './system'
import { xdgDirs } from './xdgDirs'

export type AccelProfile = 'adaptive' | 'flat'
export interface MouseSettings { speed: number; accel: AccelProfile; naturalScroll: boolean; scrollFactor: number; leftHanded: boolean }
export interface TouchpadSettings extends MouseSettings {
  enabled: 'yes' | 'no' | 'disabledOnExternalMouse'
  tap: boolean; tapAndDrag: boolean; dragLock: boolean
  scrollMethod: 'twoFinger' | 'edge'; clickMethod: 'clickfinger' | 'buttonAreas'; disableWhileTyping: boolean
}
export interface PointerSettings { mouse: MouseSettings; touchpad: TouchpadSettings }

export const DEFAULT_POINTER: PointerSettings = {
  mouse: { speed: 0, accel: 'adaptive', naturalScroll: false, scrollFactor: 1, leftHanded: false },
  touchpad: {
    speed: 0, accel: 'adaptive', naturalScroll: true, scrollFactor: 1, leftHanded: false, enabled: 'yes',
    tap: true, tapAndDrag: true, dragLock: false, scrollMethod: 'twoFinger', clickMethod: 'clickfinger', disableWhileTyping: true,
  },
}
export const SCROLL_MIN = 0.25
export const SCROLL_MAX = 4

const clamp = (v: unknown, lo: number, hi: number, d: number) => (typeof v === 'number' && Number.isFinite(v) ? Math.min(hi, Math.max(lo, Math.round(v * 100) / 100)) : d)
const bool = (v: unknown, d: boolean) => (typeof v === 'boolean' ? v : d)
const pick = <T extends string>(v: unknown, allowed: readonly T[], d: T): T => (allowed.includes(v as T) ? (v as T) : d)

function normMouse(v: unknown, d: MouseSettings): MouseSettings {
  const o = (v && typeof v === 'object' ? v : {}) as Record<string, unknown>
  return {
    speed: clamp(o.speed, -1, 1, d.speed), accel: pick(o.accel, ['adaptive', 'flat'] as const, d.accel),
    naturalScroll: bool(o.naturalScroll, d.naturalScroll), scrollFactor: clamp(o.scrollFactor, SCROLL_MIN, SCROLL_MAX, d.scrollFactor),
    leftHanded: bool(o.leftHanded, d.leftHanded),
  }
}
export function normalizePointer(v: unknown): PointerSettings {
  const o = (v && typeof v === 'object' ? v : {}) as Record<string, unknown>
  const tp = (o.touchpad && typeof o.touchpad === 'object' ? o.touchpad : {}) as Record<string, unknown>
  const d = DEFAULT_POINTER.touchpad
  return {
    mouse: normMouse(o.mouse, DEFAULT_POINTER.mouse),
    touchpad: {
      ...normMouse(tp, d),
      enabled: pick(tp.enabled, ['yes', 'no', 'disabledOnExternalMouse'] as const, d.enabled),
      tap: bool(tp.tap, d.tap), tapAndDrag: bool(tp.tapAndDrag, d.tapAndDrag), dragLock: bool(tp.dragLock, d.dragLock),
      scrollMethod: pick(tp.scrollMethod, ['twoFinger', 'edge'] as const, d.scrollMethod),
      clickMethod: pick(tp.clickMethod, ['clickfinger', 'buttonAreas'] as const, d.clickMethod),
      disableWhileTyping: bool(tp.disableWhileTyping, d.disableWhileTyping),
    },
  }
}
/** A partial change on top of the current settings (Settings sends one control at a time). */
export function mergePointer(cur: PointerSettings, patch: unknown): PointerSettings {
  const p = (patch && typeof patch === 'object' ? patch : {}) as Record<string, unknown>
  return normalizePointer({ mouse: { ...cur.mouse, ...(p.mouse as object) }, touchpad: { ...cur.touchpad, ...(p.touchpad as object) } })
}

export function loadPointer(file: string): PointerSettings {
  try { return normalizePointer(JSON.parse(readFileSync(file, 'utf8'))) } catch { return structuredClone(DEFAULT_POINTER) }
}
export function savePointer(file: string, s: PointerSettings) {
  mkdirSync(path.dirname(file), { recursive: true })
  writeFileSync(`${file}.tmp`, JSON.stringify(normalizePointer(s), null, 2))
  renameSync(`${file}.tmp`, file)
}

// ---------- devices ----------
export interface PointerCaps {
  tap: boolean; naturalScroll: boolean; leftHanded: boolean; accel: boolean; flat: boolean
  edgeScroll: boolean; twoFingerScroll: boolean; clickfinger: boolean; buttonAreas: boolean; disableWhileTyping: boolean; dragLock: boolean
}
/** node: the /dev/input/eventN behind it, when known (to join libinput's view with udev's). */
export interface PointerDev { name: string; kind: 'mouse' | 'touchpad'; caps: PointerCaps; node?: string }
const ALL_CAPS: PointerCaps = { tap: true, naturalScroll: true, leftHanded: true, accel: true, flat: true, edgeScroll: true, twoFingerScroll: true, clickfinger: true, buttonAreas: true, disableWhileTyping: true, dragLock: true }
const MOUSE_CAPS: PointerCaps = { ...ALL_CAPS, tap: false, edgeScroll: false, twoFingerScroll: false, clickfinger: false, buttonAreas: false, disableWhileTyping: false, dragLock: false }

/** `libinput list-devices` → mice and touchpads with what each supports ("n/a" = not supported). */
export function parsePointerDevices(text: string): PointerDev[] {
  const out: PointerDev[] = []
  for (const block of text.split(/\n\s*\n/)) {
    const kv: Record<string, string> = {}
    for (const line of block.split('\n')) { const m = /^([A-Za-z][A-Za-z .-]*?):\s+(.*)$/.exec(line.trim()); if (m) kv[m[1]] = m[2].trim() }
    if (!kv.Device || !(kv.Capabilities ?? '').split(/\s+/).includes('pointer')) continue
    const has = (k: string) => kv[k] !== undefined && kv[k] !== 'n/a'
    const list = (k: string) => (kv[k] ?? '').split(/\s+/).map((x) => x.replace(/^\*/, ''))  // * marks the default
    const touchpad = has('Tap-to-click') || /touchpad|trackpad|clickpad/i.test(kv.Device)
    // Keyboards with a pointer node (media keys, some receivers) report no acceleration; skip them.
    if (!touchpad && !has('Accel profiles') && !has('Nat.scrolling')) continue
    const accel = list('Accel profiles')
    out.push({
      name: kv.Device, kind: touchpad ? 'touchpad' : 'mouse', ...(kv.Kernel ? { node: kv.Kernel } : {}),
      caps: {
        tap: has('Tap-to-click'), naturalScroll: has('Nat.scrolling'), leftHanded: has('Left-handed'),
        accel: has('Accel profiles') && !accel.includes('none'), flat: accel.some((a) => a.startsWith('flat')),
        edgeScroll: list('Scroll methods').includes('edge'), twoFingerScroll: list('Scroll methods').some((m) => m.startsWith('two-finger')),
        clickfinger: list('Click methods').includes('clickfinger'), buttonAreas: list('Click methods').includes('button-areas'),
        disableWhileTyping: has('Disable-w-typing'), dragLock: has('Tap drag lock'),
      },
    })
  }
  return out
}

/** `udevadm info -q property` fallback: kind only, usual features assumed. */
export function parseUdevPointer(text: string): PointerDev | null {
  const p: Record<string, string> = {}
  for (const line of text.split('\n')) { const i = line.indexOf('='); if (i > 0) p[line.slice(0, i)] = line.slice(i + 1).trim() }
  const name = (p.NAME ?? p.ID_MODEL ?? '').replace(/^"|"$/g, '').replace(/\\x20/g, ' ') || 'Pointer'
  const node = p.DEVNAME ? { node: p.DEVNAME } : {}
  if (p.ID_INPUT_TOUCHPAD === '1') return { name, kind: 'touchpad', caps: { ...ALL_CAPS }, ...node }
  // Trackpoints (ID_INPUT_POINTINGSTICK) are mice to libinput and Labwc ("non-touch").
  if ((p.ID_INPUT_MOUSE === '1' || p.ID_INPUT_POINTINGSTICK === '1') && p.ID_INPUT_TOUCHSCREEN !== '1' && p.ID_INPUT_TABLET !== '1') return { name, kind: 'mouse', caps: { ...MOUSE_CAPS }, ...node }
  return null
}

/** /proc/bus/input/devices (readable by everyone) when udevadm is missing: a node with a mouseN handler is a pointer;
 *  absolute axes plus INPUT_PROP_POINTER (or a touchpad-like name) make it a touchpad, INPUT_PROP_DIRECT a touchscreen. */
export function parseProcInputDevices(text: string): PointerDev[] {
  const out: PointerDev[] = []
  for (const block of text.split(/\n\s*\n/)) {
    const name = /^N: Name="(.*)"$/m.exec(block)?.[1] ?? ''
    const handlers = /^H: Handlers=(.*)$/m.exec(block)?.[1]?.trim().split(/\s+/) ?? []
    const bits = (k: string) => { const v = new RegExp(`^B: ${k}=([0-9a-f ]+)$`, 'm').exec(block)?.[1]?.trim().split(/\s+/).pop(); return v ? parseInt(v, 16) : 0 }
    const ev = bits('EV'), prop = bits('PROP')
    const event = handlers.find((h) => /^event\d+$/.test(h))
    if (!event || !handlers.some((h) => /^mouse\d+$/.test(h)) || prop & 0x2) continue
    const node = { node: `/dev/input/${event}` }
    if (ev & 0x8 && (prop & 0x1 || /touchpad|trackpad|clickpad|glidepoint/i.test(name))) out.push({ name: name || 'Touchpad', kind: 'touchpad', caps: { ...ALL_CAPS }, ...node })
    else if (ev & 0x4) out.push({ name: name || 'Mouse', kind: 'mouse', caps: { ...MOUSE_CAPS }, ...node })
  }
  return out
}

/** libinput's devices first (they carry real capabilities), then any other node udev or /proc found. */
export function joinPointerDevices(primary: PointerDev[], extra: PointerDev[]): PointerDev[] {
  const seen = new Set(primary.map((d) => d.node).filter(Boolean))
  return [...primary, ...extra.filter((d) => !d.node || !seen.has(d.node))]
}

/** What Settings can offer: a control shows when any device of that kind supports it. */
export interface PointerSupport { mouse: PointerCaps | null; touchpad: PointerCaps | null; scrollFactor: boolean; swipeGestures: boolean }
export function support(devs: PointerDev[], labwcVersion: string | null): PointerSupport {
  const join = (kind: PointerDev['kind']) => {
    const ds = devs.filter((d) => d.kind === kind)
    if (!ds.length) return null
    const out = { ...ds[0].caps }
    for (const d of ds.slice(1)) for (const k of Object.keys(out) as (keyof PointerCaps)[]) out[k] = out[k] || d.caps[k]
    return out
  }
  return { mouse: join('mouse'), touchpad: join('touchpad'), scrollFactor: labwcAtLeast(labwcVersion, 0, 8), swipeGestures: false }
}
/** `labwc --version` → "labwc 0.8.4 (…)". Unknown versions are assumed recent. */
export function labwcAtLeast(version: string | null, major: number, minor: number): boolean {
  const m = /(\d+)\.(\d+)/.exec(version ?? '')
  if (!m) return true
  const [a, b] = [Number(m[1]), Number(m[2])]
  return a > major || (a === major && b >= minor)
}

// ---------- Labwc config ----------
export const POINTER_BEGIN = '<!-- worksuite-pointer:begin (Settings › Mouse & touchpad; rewritten by the shell) -->'
export const POINTER_END = '<!-- worksuite-pointer:end -->'
const yn = (b: boolean) => (b ? 'yes' : 'no')
/** Two decimals for rc.xml (machine text, not shown to people). */
const num = (n: number) => { const r = Math.round(n * 100); const a = Math.abs(r); return `${r < 0 ? '-' : ''}${Math.floor(a / 100)}.${String(a % 100).padStart(2, '0')}` }

/** The managed rc.xml block. Only what the hardware supports is written; scrollFactor needs Labwc 0.8. */
export function labwcPointerBlock(s: PointerSettings, sup: PointerSupport): string {
  const lines = [POINTER_BEGIN, '  <libinput>']
  const common = (m: MouseSettings, caps: PointerCaps) => {
    const x: string[] = []
    if (caps.accel) x.push(`<pointerSpeed>${num(m.speed)}</pointerSpeed>`, `<accelProfile>${caps.flat ? m.accel : 'adaptive'}</accelProfile>`)
    if (caps.naturalScroll) x.push(`<naturalScroll>${yn(m.naturalScroll)}</naturalScroll>`)
    if (caps.leftHanded) x.push(`<leftHanded>${yn(m.leftHanded)}</leftHanded>`)
    if (sup.scrollFactor) x.push(`<scrollFactor>${num(m.scrollFactor)}</scrollFactor>`)
    return x
  }
  if (sup.mouse) lines.push(`    <device category="non-touch">${common(s.mouse, sup.mouse).join('')}</device>`)
  if (sup.touchpad) {
    const c = sup.touchpad, t = s.touchpad
    const x = common(t, c)
    if (c.tap) x.push(`<tap>${yn(t.tap)}</tap>`, `<tapButtonMap>lrm</tapButtonMap>`, `<tapAndDrag>${yn(t.tapAndDrag)}</tapAndDrag>`)
    if (c.tap && c.dragLock) x.push(`<dragLock>${yn(t.dragLock)}</dragLock>`)
    const scroll = t.scrollMethod === 'edge' ? (c.edgeScroll ? 'edge' : null) : (c.twoFingerScroll ? 'twoFinger' : null)
    if (scroll) x.push(`<scrollMethod>${scroll}</scrollMethod>`)
    const click = t.clickMethod === 'clickfinger' ? (c.clickfinger ? 'clickfinger' : null) : (c.buttonAreas ? 'buttonAreas' : null)
    if (click) x.push(`<clickMethod>${click}</clickMethod>`)
    if (c.disableWhileTyping) x.push(`<disableWhileTyping>${yn(t.disableWhileTyping)}</disableWhileTyping>`)
    x.push(`<sendEventsMode>${t.enabled}</sendEventsMode>`)
    lines.push(`    <device category="touchpad">${x.join('')}</device>`)
  }
  lines.push('  </libinput>', POINTER_END)
  return lines.join('\n')
}

export function extractPointerBlock(rc: string): string | null {
  const a = rc.indexOf(POINTER_BEGIN), b = rc.indexOf(POINTER_END)
  return a >= 0 && b > a ? rc.slice(a, b + POINTER_END.length) : null
}
/** Puts the block into rc.xml (replacing an earlier one) just before </labwc_config>; null removes it. */
export function mergePointerBlock(rc: string, block: string | null): string {
  const old = extractPointerBlock(rc)
  const base = old ? rc.replace(old + (rc.includes(`${old}\n`) ? '\n' : ''), '') : rc
  if (!block) return base
  const close = base.lastIndexOf('</labwc_config>')
  if (close < 0) return `${base.trimEnd()}\n${block}\n`
  return `${base.slice(0, close)}${block}\n${base.slice(close)}`
}

// ---------- host ----------
export interface PointerState { devices: PointerDev[]; settings: PointerSettings; support: PointerSupport }
type Handle = (channel: string, fn: (...args: string[]) => unknown) => void
export interface PointerFiles { settings: string; userRc: string; systemRc: string }
export const pointerFiles = (home: string): PointerFiles => ({
  settings: path.join(xdgDirs(home).config, 'worksuite', 'pointer.json'),
  userRc: path.join(xdgDirs(home).config, 'worksuite', 'labwc', 'rc.xml'),
  systemRc: '/etc/xdg/worksuite/labwc/rc.xml',
})

export interface PointerSys { listInput(): string[]; procDevices(): string }
const realSys: PointerSys = {
  listInput: () => { try { return readdirSync('/sys/class/input') } catch { return [] } },
  procDevices: () => { try { return readFileSync('/proc/bus/input/devices', 'utf8') } catch { return '' } },
}

export function pointerBridge(files: PointerFiles, exec: Exec = realExec, sys: PointerSys = realSys) {
  let settings = loadPointer(files.settings)
  let version: string | null | undefined

  async function detect(): Promise<PointerDev[]> {
    const li = await exec('libinput', ['list-devices'])
    const fromLibinput = li.code === 0 ? parsePointerDevices(li.stdout) : []
    const events = sys.listInput().filter((n) => /^event\d+$/.test(n))
    const udev = await Promise.all(events.map((ev) => exec('udevadm', ['info', '-q', 'property', '-n', `/dev/input/${ev}`])))
    // No udevadm (or no sysfs): the kernel's own list.
    const extra = !events.length || udev.every((r) => r.missing)
      ? parseProcInputDevices(sys.procDevices())
      : udev.flatMap((r, i) => { const d = r.code === 0 ? parseUdevPointer(r.stdout) : null; return d ? [{ ...d, node: d.node ?? `/dev/input/${events[i]}` }] : [] })
    return joinPointerDevices(fromLibinput, extra)
  }
  async function labwcVersion(): Promise<string | null> {
    if (version !== undefined) return version
    const r = await exec('labwc', ['--version'])
    version = r.code === 0 ? r.stdout.trim() : null
    return version
  }
  async function state(): Promise<PointerState> {
    const devices = await detect()
    return { devices, settings: structuredClone(settings), support: support(devices, await labwcVersion()) }
  }

  /** Writes the block into the user's rc.xml (kept otherwise: desktops, shortcuts, touchscreens) and reloads Labwc. */
  async function writeLabwc(sup: PointerSupport): Promise<Avail<true>> {
    let linked = false
    try { linked = lstatSync(files.userRc).isSymbolicLink() } catch { /* absent */ }
    let current = ''
    try { current = readFileSync(linked ? files.systemRc : files.userRc, 'utf8') } catch {
      try { current = readFileSync(files.systemRc, 'utf8') } catch { return { available: false, reason: 'labwc_config' } }
    }
    const block = sup.mouse || sup.touchpad ? labwcPointerBlock(settings, sup) : null
    if (extractPointerBlock(current) === block) return { available: true, value: true }
    try {
      mkdirSync(path.dirname(files.userRc), { recursive: true })
      if (linked) unlinkSync(files.userRc)
      writeFileSync(`${files.userRc}.tmp`, mergePointerBlock(current, block))
      renameSync(`${files.userRc}.tmp`, files.userRc)
    } catch { return { available: false, reason: 'labwc_config' } }
    const r = await exec('labwc', ['--reconfigure'])
    return r.code === 0 ? { available: true, value: true } : { available: false, reason: r.missing ? 'labwc_missing' : 'labwc_reload' }
  }

  return {
    state: async (): Promise<Avail<PointerState>> => ({ available: true, value: await state() }),
    /** At login: makes sure the saved settings are what Labwc runs. */
    async start(): Promise<Avail<true>> { const s = await state(); return writeLabwc(s.support) },
    async set(json: string): Promise<Avail<PointerState>> {
      let patch: unknown
      try { patch = JSON.parse(json) } catch { return { available: false, reason: 'bad_settings' } }
      const prev = settings
      settings = mergePointer(settings, patch)
      const s = await state()
      const r = await writeLabwc(s.support)
      if (!r.available) { settings = prev; return r }
      try { savePointer(files.settings, settings) } catch { return { available: false, reason: 'save_failed' } }
      return { available: true, value: { ...s, settings: structuredClone(settings) } }
    },
  }
}

export function startPointerHost(handle: Handle, home: string, b = pointerBridge(pointerFiles(home))) {
  handle('ws:pointerState', () => b.state())
  handle('ws:pointerSet', (json) => b.set(json))
  void b.start()
  return b
}

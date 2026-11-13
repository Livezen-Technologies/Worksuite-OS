// Settings › Personalization: the WorkSuite desktop's look and taskbar, on the keys GNOME Shell and its packaged
// extensions read (services/session/gnome/96_worksuite-desktop.gschema.override has the defaults). Per user (dconf),
// so a choice survives sign-out and restart; every read comes back from gsettings, so the panel shows what the desktop
// has, not what was asked for. No polling: the panel reads on open and after each change.
//   Glass effects  on: blur-my-shell enabled (static blur behind taskbar, overview, folders, lock screen) and a
//                  translucent taskbar/Start menu; off: the extension is disabled outright (no blur work at all) and
//                  every surface is opaque.
//   Transparency   the taskbar and Start menu tint without blur (cheap), independent of Glass.
//   Animations     off: GNOME animations off; reduced: GNOME's on, the taskbar's own launch and app-switch effects off;
//                  standard: everything on. GNOME's "reduce animation" (enable-animations=false) is the same key, so
//                  the accessibility switch in GNOME Settings and this one agree.
//   Taskbar        centre or left, Small/Medium/Large (40/48/56 px), bottom or top, auto-hide (intellihide).
import type { Avail, Exec } from './system'

export const BLUR = 'blur-my-shell@aunetx'
const DTP = 'org.gnome.shell.extensions.dash-to-panel'
const ARC = 'org.gnome.shell.extensions.arcmenu'
const IFACE = 'org.gnome.desktop.interface'
export const TASKBAR_SIZES = [40, 48, 56] as const
export type Animations = 'off' | 'reduced' | 'standard'
export interface DesktopLook {
  glass: boolean; transparency: boolean; animations: Animations
  taskbar: { align: 'center' | 'left'; size: number; position: 'BOTTOM' | 'TOP'; autohide: boolean }
}
export type LookChange = Partial<Omit<DesktopLook, 'taskbar'>> & { taskbar?: Partial<DesktopLook['taskbar']>; lightest?: boolean }

const MENU_BG = { glass: 'rgba(10,22,52,0.86)', tint: 'rgba(10,22,52,0.94)', opaque: 'rgb(10,22,52)' }
const OPACITY = { glass: 0.62, tint: 0.85, opaque: 1 }

/** GVariant text from `gsettings get` → JS (strings, booleans, numbers, string arrays; enough for these keys). */
export function parseGv(text: string): unknown {
  const s = text.trim().replace(/^@as /, '').replace(/^uint32 /, '').replace(/^int32 /, '')
  if (s === 'true' || s === 'false') return s === 'true'
  if (/^-?\d+(\.\d+)?$/.test(s)) return Number(s)
  if (s.startsWith("'") && s.endsWith("'")) return s.slice(1, -1).replace(/\\'/g, "'").replace(/\\\\/g, '\\')
  if (s.startsWith('[')) return [...s.matchAll(/'((?:[^'\\]|\\.)*)'/g)].map((m) => m[1].replace(/\\'/g, "'"))
  return s
}
const gvString = (v: string) => `'${v.replace(/\\/g, '\\\\').replace(/'/g, "\\'")}'`
const gvList = (a: string[]) => `[${a.map(gvString).join(', ')}]`

/** dash-to-panel's per-monitor element list with the Start button area and the app icons centred (or left). */
export function withAlignment(json: string, align: 'center' | 'left'): string {
  let m: Record<string, { element: string; visible: boolean; position: string }[]> = {}
  try { m = JSON.parse(json || '{}') } catch { m = {} }
  if (!Object.keys(m).length) m = { 0: [], 1: [], 2: [], 3: [] }
  const pos = align === 'center' ? 'centerMonitor' : 'stackedTL'
  for (const k of Object.keys(m)) {
    const list = Array.isArray(m[k]) && m[k].length ? m[k] : DEFAULT_ELEMENTS.map((e) => ({ ...e }))
    m[k] = list.map((e) => (e.element === 'taskbar' || e.element === 'centerBox') ? { ...e, position: pos } : e)
  }
  return JSON.stringify(m)
}
const DEFAULT_ELEMENTS = [
  { element: 'showAppsButton', visible: false, position: 'stackedTL' }, { element: 'activitiesButton', visible: false, position: 'stackedTL' },
  { element: 'leftBox', visible: true, position: 'stackedTL' }, { element: 'centerBox', visible: true, position: 'centerMonitor' },
  { element: 'taskbar', visible: true, position: 'centerMonitor' }, { element: 'rightBox', visible: true, position: 'stackedBR' },
  { element: 'systemMenu', visible: true, position: 'stackedBR' }, { element: 'dateMenu', visible: true, position: 'stackedBR' },
  { element: 'desktopButton', visible: true, position: 'stackedBR' },
]
const sizes = (n: number) => JSON.stringify({ 0: n, 1: n, 2: n, 3: n })

export function makeDesktopLook(exec: Exec) {
  const get = async (schema: string, key: string) => {
    const r = await exec('gsettings', ['get', schema, key])
    if (r.missing) throw Object.assign(new Error('gsettings'), { reason: 'unavailable' })
    if (r.code !== 0) throw Object.assign(new Error(r.stderr), { reason: /No such schema/.test(r.stderr) ? 'not_installed' : 'failed' })
    return parseGv(r.stdout)
  }
  const set = async (schema: string, key: string, value: string) => {
    const r = await exec('gsettings', ['set', schema, key, value])
    if (r.code !== 0) throw Object.assign(new Error(r.stderr), { reason: r.missing ? 'unavailable' : 'failed' })
  }
  const fail = (e: unknown): { available: false; reason: string } => ({ available: false, reason: (e as { reason?: string }).reason ?? 'failed' })

  async function read(): Promise<Avail<DesktopLook>> {
    try {
      const ext = (await get('org.gnome.shell', 'enabled-extensions')) as string[]
      const opacityOn = (await get(DTP, 'trans-use-custom-opacity')) === true
      const opacity = Number(await get(DTP, 'trans-panel-opacity'))
      const anim = (await get(IFACE, 'enable-animations')) === true
      const launch = (await get(DTP, 'animate-window-launch')) === true
      const positions = String(await get(DTP, 'panel-element-positions'))
      let align: 'center' | 'left' = 'center'
      try { const first = Object.values(JSON.parse(positions || '{}'))[0] as { element: string; position: string }[] | undefined
        if (first?.find((e) => e.element === 'taskbar')?.position === 'stackedTL') align = 'left' } catch { /* default */ }
      let size = 48
      try { const v = Object.values(JSON.parse(String(await get(DTP, 'panel-sizes')) || '{}'))[0]; if (typeof v === 'number') size = v } catch { /* default */ }
      return { available: true, value: {
        glass: ext.includes(BLUR),
        transparency: opacityOn && opacity < 1,
        animations: !anim ? 'off' : launch ? 'standard' : 'reduced',
        taskbar: { align, size, position: (await get(DTP, 'panel-position')) === 'TOP' ? 'TOP' : 'BOTTOM', autohide: (await get(DTP, 'intellihide')) === true },
      } }
    } catch (e) { return fail(e) }
  }

  async function apply(c: LookChange): Promise<Avail<DesktopLook>> {
    const cur = await read()
    if (!cur.available) return cur
    const next: DesktopLook = c.lightest
      ? { ...cur.value, glass: false, transparency: false, animations: 'off' }
      : { ...cur.value, ...c, taskbar: { ...cur.value.taskbar, ...(c.taskbar ?? {}) } }
    try {
      if (next.glass !== cur.value.glass) {
        const ext = ((await get('org.gnome.shell', 'enabled-extensions')) as string[]).filter((x) => x !== BLUR)
        await set('org.gnome.shell', 'enabled-extensions', gvList(next.glass ? [...ext, BLUR] : ext))
      }
      // Glass implies a translucent taskbar; without glass, Transparency alone tints it.
      const tone = next.glass ? 'glass' : next.transparency ? 'tint' : 'opaque'
      await set(DTP, 'trans-use-custom-opacity', 'true')
      await set(DTP, 'trans-panel-opacity', String(OPACITY[tone]))
      await set(ARC, 'menu-background-color', gvString(MENU_BG[tone]))
      if (next.animations !== cur.value.animations) {
        await set(IFACE, 'enable-animations', next.animations === 'off' ? 'false' : 'true')
        await set(DTP, 'animate-app-switch', next.animations === 'standard' ? 'true' : 'false')
        await set(DTP, 'animate-window-launch', next.animations === 'standard' ? 'true' : 'false')
      }
      const tb = next.taskbar, was = cur.value.taskbar
      if (tb.align !== was.align) await set(DTP, 'panel-element-positions', gvString(withAlignment(String(await get(DTP, 'panel-element-positions')), tb.align)))
      if (tb.size !== was.size && (TASKBAR_SIZES as readonly number[]).includes(tb.size)) await set(DTP, 'panel-sizes', gvString(sizes(tb.size)))
      if (tb.position !== was.position) await set(DTP, 'panel-position', gvString(tb.position))
      if (tb.autohide !== was.autohide) await set(DTP, 'intellihide', tb.autohide ? 'true' : 'false')
    } catch (e) { return fail(e) }
    return read()
  }
  return { read, apply }
}

/** IPC input → a change with only known keys and values (anything else: null, nothing is written). */
export function cleanLookChange(raw: unknown): LookChange | null {
  if (!raw || typeof raw !== 'object') return null
  const r = raw as Record<string, unknown>, out: LookChange = {}
  for (const k of Object.keys(r)) if (!['glass', 'transparency', 'animations', 'taskbar', 'lightest'].includes(k)) return null
  if ('glass' in r) { if (typeof r.glass !== 'boolean') return null; out.glass = r.glass }
  if ('transparency' in r) { if (typeof r.transparency !== 'boolean') return null; out.transparency = r.transparency }
  if ('lightest' in r) { if (r.lightest !== true) return null; out.lightest = true }
  if ('animations' in r) { if (!['off', 'reduced', 'standard'].includes(r.animations as string)) return null; out.animations = r.animations as Animations }
  if ('taskbar' in r) {
    const t = r.taskbar as Record<string, unknown> | null
    if (!t || typeof t !== 'object') return null
    const tb: Partial<DesktopLook['taskbar']> = {}
    for (const k of Object.keys(t)) {
      const v = t[k]
      if (k === 'align' && (v === 'center' || v === 'left')) tb.align = v
      else if (k === 'size' && (TASKBAR_SIZES as readonly unknown[]).includes(v)) tb.size = v as number
      else if (k === 'position' && (v === 'BOTTOM' || v === 'TOP')) tb.position = v
      else if (k === 'autohide' && typeof v === 'boolean') tb.autohide = v
      else return null
    }
    out.taskbar = tb
  }
  return out
}

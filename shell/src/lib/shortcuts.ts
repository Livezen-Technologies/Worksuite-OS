// Keyboard shortcuts (Settings › Keyboard › Shortcuts, the Super+/ cheat sheet). The system shortcuts are Labwc key
// bindings in services/session/labwc/rc.xml (the catalog below must match it; shortcuts.test.ts checks), plus the
// editing keys every app handles itself (Ctrl+C…), which are listed but cannot be changed here.
//
// The user's changes (a system shortcut moved to other keys or turned off, shortcuts of their own that open an app or
// run a command) live in the synced preferences ('preferences/shell' → `shortcuts`) and are written into the user's
// Labwc rc.xml as one marked block inside <keyboard>. Labwc lets a later binding of the same keys replace an earlier
// one, and `<action name="None"/>` alone removes a binding, so the block only adds to the system file. The block is
// carried over whenever rc.xml is rebuilt: by the Wayland bridge (desktops, workspace.py refresh_rc) and by the
// touchscreen writer (electron/touch.ts carryDesktops).
import type { MessageKey } from '../i18n'

export type ShortcutCategory = 'system' | 'windows' | 'screenshots' | 'clipboard' | 'accessibility' | 'apps'
export const CATEGORIES: ShortcutCategory[] = ['system', 'windows', 'screenshots', 'clipboard', 'accessibility', 'apps']

/** One system shortcut. keys: Labwc key strings (W = Super, C = Ctrl, A = Alt, S = Shift), the first one is shown;
 *  action: the Labwc action XML, or null for keys apps handle themselves (listed, not editable here);
 *  display: what to show instead of the keys (a range such as Super+1…9). */
export interface SystemShortcut { id: string; category: ShortcutCategory; keys: string[]; action: string | null; editable: boolean; display?: string; onRelease?: boolean }

const SHELL = 'busctl --user call lk.worksuite.Shell1 /lk/worksuite/Shell1 lk.worksuite.Shell1'
export const shellCall = (method: string, arg?: string) => `<action name="Execute" command="${SHELL} ${method}${arg !== undefined ? ` s ${arg}` : ''}"/>`
const exec = (cmd: string) => `<action name="Execute" command="${cmd}"/>`
const WS_EVENT = '/usr/lib/worksuite/worksuite-workspace-event'

export const SYSTEM_SHORTCUTS: SystemShortcut[] = [
  // System
  { id: 'start', category: 'system', keys: ['Super_L'], action: shellCall('ToggleLauncher'), editable: false, onRelease: true },
  { id: 'ai', category: 'system', keys: ['W-a'], action: shellCall('ToggleAssistant'), editable: true },
  { id: 'lock', category: 'system', keys: ['W-l'], action: exec('loginctl lock-session'), editable: true },
  { id: 'files', category: 'system', keys: ['W-e'], action: shellCall('Open', 'files'), editable: true },
  { id: 'settings', category: 'system', keys: ['W-i'], action: shellCall('Open', 'settings'), editable: true },
  { id: 'notifications', category: 'system', keys: ['W-n'], action: shellCall('ToggleNotifications'), editable: true },
  { id: 'monitor', category: 'system', keys: ['C-S-Escape'], action: shellCall('Open', 'monitor'), editable: true },
  { id: 'security', category: 'system', keys: ['C-A-Delete'], action: shellCall('Open', 'monitor'), editable: true },
  { id: 'help', category: 'system', keys: ['W-slash'], action: shellCall('Open', 'shortcuts'), editable: true },
  // Windows and desktops
  { id: 'switch', category: 'windows', keys: ['A-Tab'], action: '<action name="NextWindow"/>', editable: true },
  { id: 'close', category: 'windows', keys: ['A-F4'], action: '<action name="Close"/>', editable: true },
  { id: 'maximize', category: 'windows', keys: ['W-Up'], action: '<action name="Maximize"/>', editable: true },
  { id: 'minimize', category: 'windows', keys: ['W-Down'], action: '<action name="If"><query maximized="both"/><then><action name="UnMaximize"/></then><else><action name="Iconify"/></else></action>', editable: true },
  { id: 'snapLeft', category: 'windows', keys: ['W-Left'], action: '<action name="SnapToEdge" direction="left"/>', editable: true },
  { id: 'snapRight', category: 'windows', keys: ['W-Right'], action: '<action name="SnapToEdge" direction="right"/>', editable: true },
  { id: 'taskview', category: 'windows', keys: ['W-Tab'], action: shellCall('ToggleTaskView'), editable: true },
  { id: 'desktop', category: 'windows', keys: ['W-d'], action: shellCall('ShowDesktop'), editable: true },
  { id: 'newDesktop', category: 'windows', keys: ['C-W-d'], action: exec(`${WS_EVENT} new`), editable: true },
  { id: 'closeDesktop', category: 'windows', keys: ['C-W-F4'], action: exec(`${WS_EVENT} close`), editable: true },
  { id: 'deskLeft', category: 'windows', keys: ['C-W-Left', 'C-A-Left'], action: `<action name="GoToDesktop" to="left" wrap="no"/>${exec(`${WS_EVENT} left`)}`, editable: false },
  { id: 'deskRight', category: 'windows', keys: ['C-W-Right', 'C-A-Right'], action: `<action name="GoToDesktop" to="right" wrap="no"/>${exec(`${WS_EVENT} right`)}`, editable: false },
  { id: 'goto', category: 'windows', keys: ['W-1'], action: null, editable: false, display: 'W-1…9' },
  { id: 'moveTo', category: 'windows', keys: ['W-S-1'], action: null, editable: false, display: 'W-S-1…9' },
  // Screenshots
  { id: 'print', category: 'screenshots', keys: ['Print'], action: exec('worksuite-screenshot'), editable: true },
  { id: 'printSave', category: 'screenshots', keys: ['W-Print'], action: exec('worksuite-screenshot --save'), editable: true },
  { id: 'printWindow', category: 'screenshots', keys: ['A-Print'], action: exec('worksuite-screenshot --window'), editable: true },
  { id: 'snip', category: 'screenshots', keys: ['W-S-s', 'S-Print'], action: exec('worksuite-screenshot --snip'), editable: true },
  // Clipboard
  { id: 'history', category: 'clipboard', keys: ['W-v'], action: shellCall('Open', 'clipboard'), editable: true },
  { id: 'emoji', category: 'clipboard', keys: ['W-period'], action: shellCall('Open', 'emoji'), editable: true },
  { id: 'copy', category: 'clipboard', keys: ['C-c'], action: null, editable: false },
  { id: 'cut', category: 'clipboard', keys: ['C-x'], action: null, editable: false },
  { id: 'paste', category: 'clipboard', keys: ['C-v'], action: null, editable: false },
  { id: 'selectAll', category: 'clipboard', keys: ['C-a'], action: null, editable: false },
  { id: 'undo', category: 'clipboard', keys: ['C-z'], action: null, editable: false },
  { id: 'redo', category: 'clipboard', keys: ['C-y'], action: null, editable: false },
  { id: 'termCopy', category: 'clipboard', keys: ['C-S-c', 'C-Insert'], action: null, editable: false },
  { id: 'termPaste', category: 'clipboard', keys: ['C-S-v', 'S-Insert'], action: null, editable: false },
  { id: 'deleteForever', category: 'clipboard', keys: ['S-Delete'], action: null, editable: false },
  // Accessibility
  { id: 'a11y', category: 'accessibility', keys: ['W-u'], action: shellCall('Open', 'a11y'), editable: true },
  { id: 'stopSharing', category: 'accessibility', keys: ['W-S-Escape'], action: exec('/usr/lib/worksuite/worksuite-screencast-stop'), editable: false },
  // Apps
  { id: 'terminal', category: 'apps', keys: ['C-A-t'], action: shellCall('Open', 'app:foot'), editable: true },
]

export const shortcutLabel = (id: string) => `sc.${id}` as MessageKey
export const categoryLabel = (c: ShortcutCategory) => `sc.cat.${c}` as MessageKey

// ---- keys ---------------------------------------------------------------------------------------------------------
const MOD_ORDER = ['C', 'A', 'S', 'W'] as const
export interface ParsedKey { mods: Set<string>; key: string }
export function parseKey(k: string): ParsedKey {
  const parts = k.split('-')
  // "C-A-minus" style names never contain '-', so the last part is the key.
  const key = parts.pop() ?? ''
  return { mods: new Set(parts.map((p) => p.toUpperCase()).filter((p) => (MOD_ORDER as readonly string[]).includes(p))), key }
}
/** One spelling per key combination: modifiers in a fixed order, letters lower case, Super_L/R as W alone. */
export function normalizeKey(k: string): string {
  const { mods, key } = parseKey(k.trim())
  const name = /^[A-Za-z]$/.test(key) ? key.toLowerCase() : key
  return [...MOD_ORDER.filter((m) => mods.has(m)), name].join('-')
}
const KEY_NAMES: Record<string, string> = { slash: '/', period: '.', comma: ',', minus: '-', equal: '=', space: 'Space', Print: 'Print Screen', Escape: 'Esc', Delete: 'Del', Return: 'Enter',
  BackSpace: 'Backspace', Prior: 'Page Up', Next: 'Page Down', Left: '←', Right: '→', Up: '↑', Down: '↓', Super_L: 'Super', Super_R: 'Super', semicolon: ';', apostrophe: "'", grave: '`', backslash: '\\', bracketleft: '[', bracketright: ']' }
const MOD_NAMES: Record<string, string> = { C: 'Ctrl', A: 'Alt', S: 'Shift', W: 'Super' }
/** "W-S-s" → ["Super", "Shift", "S"] (key caps, in the order people say them: Super first). */
export function keyCaps(k: string): string[] {
  const { mods, key } = parseKey(k)
  const order = ['W', 'C', 'A', 'S'].filter((m) => mods.has(m)).map((m) => MOD_NAMES[m])
  const name = KEY_NAMES[key] ?? (key.length === 1 ? key.toUpperCase() : key)
  return [...order, name]
}
export const keyText = (k: string) => keyCaps(k).join('+')

const CODE_KEYS: Record<string, string> = { Slash: 'slash', Period: 'period', Comma: 'comma', Minus: 'minus', Equal: 'equal', Space: 'space', Semicolon: 'semicolon', Quote: 'apostrophe',
  Backquote: 'grave', Backslash: 'backslash', BracketLeft: 'bracketleft', BracketRight: 'bracketright', Escape: 'Escape', Delete: 'Delete', Insert: 'Insert', Tab: 'Tab', Enter: 'Return',
  Backspace: 'BackSpace', Home: 'Home', End: 'End', PageUp: 'Prior', PageDown: 'Next', ArrowLeft: 'Left', ArrowRight: 'Right', ArrowUp: 'Up', ArrowDown: 'Down', PrintScreen: 'Print' }
/** A key press in the "Press the new shortcut" box → Labwc key string; null for a modifier alone or a key it cannot bind. */
export function keyFromEvent(e: { code: string; key: string; ctrlKey: boolean; altKey: boolean; shiftKey: boolean; metaKey: boolean }): string | null {
  let key: string | null = null
  if (/^Key[A-Z]$/.test(e.code)) key = e.code.slice(3).toLowerCase()
  else if (/^Digit\d$/.test(e.code)) key = e.code.slice(5)
  else if (/^F([1-9]|1\d|2[0-4])$/.test(e.code)) key = e.code
  else if (CODE_KEYS[e.code]) key = CODE_KEYS[e.code]
  else if (e.key === 'PrintScreen' || e.key === 'Print') key = 'Print'
  if (!key) return null
  const mods = [e.ctrlKey && 'C', e.altKey && 'A', e.shiftKey && 'S', e.metaKey && 'W'].filter(Boolean)
  return normalizeKey([...mods, key].join('-'))
}
/** A shortcut needs a modifier, except Print Screen, the function keys and a few keys apps leave alone. */
export function bindable(k: string): boolean {
  const { mods, key } = parseKey(k)
  if (mods.size) return !(mods.size === 1 && mods.has('S'))   // Shift+letter is typing
  return key === 'Print' || /^F\d+$/.test(key) || key === 'Super_L'
}
/** Keys the shell itself sends to Labwc (desktops, lifting its window): never offered. */
export function reserved(k: string): boolean {
  const { mods, key } = parseKey(normalizeKey(k))
  return mods.has('C') && mods.has('A') && mods.has('W') && /^F\d+$/.test(key)
}

// ---- the user's changes -----------------------------------------------------------------------------------------
export interface CustomShortcut { id: string; name: string; key: string; app?: string; command?: string }
/** keys: system shortcut id → its new key ('' = turned off); custom: the user's own. */
export interface ShortcutPrefs { keys?: Record<string, string>; custom?: CustomShortcut[] }

const ID = /^[A-Za-z0-9][A-Za-z0-9._+-]{0,127}$/
const KEY = /^([CASW]-){0,4}[A-Za-z0-9_]{1,24}$/
export const MAX_CUSTOM = 50

/** Validated shortcut preferences from untrusted data (sync store, IPC). */
export function shortcutPrefsFrom(v: unknown): ShortcutPrefs | undefined {
  if (!v || typeof v !== 'object') return undefined
  const o = v as Record<string, unknown>
  const out: ShortcutPrefs = {}
  if (o.keys && typeof o.keys === 'object') {
    const keys: Record<string, string> = {}
    for (const [id, k] of Object.entries(o.keys as Record<string, unknown>)) {
      const s = SYSTEM_SHORTCUTS.find((x) => x.id === id)
      if (s?.editable && typeof k === 'string' && (k === '' || (KEY.test(k) && !reserved(k)))) keys[id] = k === '' ? '' : normalizeKey(k)
    }
    if (Object.keys(keys).length) out.keys = keys
  }
  if (Array.isArray(o.custom)) {
    const custom: CustomShortcut[] = []
    for (const c of o.custom.slice(0, MAX_CUSTOM)) {
      if (!c || typeof c !== 'object') continue
      const x = c as Record<string, unknown>
      if (typeof x.id !== 'string' || !ID.test(x.id) || typeof x.key !== 'string' || !KEY.test(x.key) || reserved(x.key)) continue
      const name = typeof x.name === 'string' ? x.name.replace(/[\u0000-\u001f]/g, '').slice(0, 80) : ''
      const app = typeof x.app === 'string' && ID.test(x.app) ? x.app : undefined
      const command = !app && typeof x.command === 'string' && x.command.trim() && !/[\u0000-\u001f]/.test(x.command) ? x.command.slice(0, 500) : undefined
      if (!app && !command) continue
      custom.push({ id: x.id, name, key: normalizeKey(x.key), ...(app ? { app } : { command }) })
    }
    if (custom.length) out.custom = custom
  }
  return out.keys || out.custom ? out : undefined
}

/** The keys a system shortcut has now (none when turned off). */
export function effectiveKeys(s: SystemShortcut, p: ShortcutPrefs | undefined): string[] {
  const o = p?.keys?.[s.id]
  if (o === undefined || !s.editable) return s.keys
  return o ? [o] : []
}

export interface Binding { key: string; owner: { kind: 'system' | 'custom'; id: string } }
export function bindings(p: ShortcutPrefs | undefined): Binding[] {
  const out: Binding[] = []
  for (const s of SYSTEM_SHORTCUTS) {
    if (s.display) continue
    for (const k of effectiveKeys(s, p)) out.push({ key: normalizeKey(k), owner: { kind: 'system', id: s.id } })
  }
  for (const n of [1, 2, 3, 4, 5, 6, 7, 8, 9]) {
    out.push({ key: normalizeKey(`W-${n}`), owner: { kind: 'system', id: 'goto' } }, { key: normalizeKey(`W-S-${n}`), owner: { kind: 'system', id: 'moveTo' } })
  }
  for (const c of p?.custom ?? []) out.push({ key: normalizeKey(c.key), owner: { kind: 'custom', id: c.id } })
  return out
}

/** Key combinations used by more than one shortcut, with who uses them. */
export function conflicts(p: ShortcutPrefs | undefined): Map<string, Binding['owner'][]> {
  const by = new Map<string, Binding['owner'][]>()
  for (const b of bindings(p)) by.set(b.key, [...(by.get(b.key) ?? []), b.owner])
  for (const [k, v] of by) if (v.length < 2) by.delete(k)
  return by
}
/** Who already uses this key, other than `self` (for the "Change shortcut" dialog). */
export function usedBy(p: ShortcutPrefs | undefined, key: string, self?: Binding['owner']): Binding['owner'][] {
  const k = normalizeKey(key)
  return bindings(p).filter((b) => b.key === k && !(self && b.owner.kind === self.kind && b.owner.id === self.id)).map((b) => b.owner)
}

// ---- rc.xml -----------------------------------------------------------------------------------------------------
export const SHORTCUTS_BEGIN = '<!-- worksuite-shortcuts:begin (Settings › Keyboard › Shortcuts; rewritten by the shell) -->'
export const SHORTCUTS_END = '<!-- worksuite-shortcuts:end -->'
const BLOCK = /[ \t]*<!-- worksuite-shortcuts:begin[\s\S]*?<!-- worksuite-shortcuts:end -->\n?/
const attr = (s: string) => s.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;')

/** The managed block: system shortcuts turned off or moved, then the user's own. Empty prefs → an empty block. */
export function shortcutsBlock(p: ShortcutPrefs | undefined): string {
  const lines: string[] = []
  for (const s of SYSTEM_SHORTCUTS) {
    const o = p?.keys?.[s.id]
    if (o === undefined || !s.editable || !s.action) continue
    const ks = s.keys.map(normalizeKey)
    if (ks.includes(normalizeKey(o))) continue
    for (const k of s.keys) lines.push(`    <keybind key="${attr(k)}"><action name="None"/></keybind>`)
    if (o) lines.push(`    <keybind key="${attr(normalizeKey(o))}">${s.action}</keybind>`)
  }
  for (const c of p?.custom ?? []) {
    const action = c.app ? shellCall('Open', `app:${c.app}`) : `<action name="Execute" command="${attr(c.command ?? '')}"/>`
    lines.push(`    <keybind key="${attr(c.key)}">${action}</keybind>`)
  }
  return ['    ' + SHORTCUTS_BEGIN, ...lines, '    ' + SHORTCUTS_END].join('\n')
}

export function extractShortcutsBlock(rc: string): string | null {
  return BLOCK.exec(rc)?.[0].replace(/\n$/, '') ?? null
}
/** rc.xml with the block in place of an earlier one, at the end of <keyboard> (later bindings win in Labwc). */
export function mergeShortcutsBlock(rc: string, block: string | null): string {
  const base = rc.replace(BLOCK, '')
  if (!block) return base
  const close = base.lastIndexOf('</keyboard>')
  if (close < 0) {
    const end = base.lastIndexOf('</labwc_config>')
    const kb = `  <keyboard>\n${block}\n  </keyboard>\n`
    return end < 0 ? `${base.trimEnd()}\n${kb}` : `${base.slice(0, end)}${kb}${base.slice(end)}`
  }
  const lineStart = base.lastIndexOf('\n', close) + 1
  return `${base.slice(0, lineStart)}${block}\n${base.slice(lineStart)}`
}

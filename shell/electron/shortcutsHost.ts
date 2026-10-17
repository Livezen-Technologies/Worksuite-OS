// Settings › Keyboard › Shortcuts (src/lib/shortcuts.ts): writes the user's shortcut block into their Labwc rc.xml
// (~/.config/worksuite/labwc/rc.xml, which worksuite-session starts Labwc with) and reloads Labwc. Everything else in
// the file is kept: the bridge's desktops, the touchscreen block. The file starts as a symlink to the system copy.
import { lstatSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { extractShortcutsBlock, mergeShortcutsBlock, shortcutPrefsFrom, shortcutsBlock, type ShortcutPrefs } from '../src/lib/shortcuts'
import type { Avail, Exec } from './system'

export interface ShortcutFiles { userRc: string; systemRc: string }

/** The user's rc.xml with this block; null when it is already there (nothing to write or reload). */
export function nextRc(current: string, prefs: ShortcutPrefs | undefined): string | null {
  const empty = !prefs?.keys && !prefs?.custom
  const block = empty ? null : shortcutsBlock(prefs)
  if ((extractShortcutsBlock(current) ?? null) === block) return null
  return mergeShortcutsBlock(current, block)
}

export async function applyShortcuts(raw: unknown, f: ShortcutFiles, exec: Exec): Promise<Avail<true>> {
  const prefs = shortcutPrefsFrom(raw)
  let linked = false
  try { linked = lstatSync(f.userRc).isSymbolicLink() } catch { /* absent */ }
  let current = ''
  try { current = readFileSync(linked ? f.systemRc : f.userRc, 'utf8') } catch {
    try { current = readFileSync(f.systemRc, 'utf8') } catch { return { available: false, reason: 'labwc_config' } }
  }
  const text = nextRc(current, prefs)
  if (text === null) return { available: true, value: true }
  try {
    mkdirSync(path.dirname(f.userRc), { recursive: true })
    if (linked) unlinkSync(f.userRc)
    writeFileSync(`${f.userRc}.tmp`, text)
    renameSync(`${f.userRc}.tmp`, f.userRc)
  } catch { return { available: false, reason: 'labwc_config' } }
  const r = await exec('labwc', ['--reconfigure'])
  return r.code === 0 ? { available: true, value: true } : { available: false, reason: r.missing ? 'labwc_missing' : 'labwc_reload' }
}

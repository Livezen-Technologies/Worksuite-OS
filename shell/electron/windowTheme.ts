// Every app's title bar is drawn by Labwc with the WorkSuite theme (services/session/themes, rc.xml <theme><name>), in
// step with the shell's own windows (src/components/ShellWindow.tsx). Settings › Appearance › Light / Dark / Auto picks
// WorkSuite-Light or WorkSuite here: the name is written into the user's rc.xml (~/.config/worksuite/labwc/rc.xml,
// which starts as a symlink to the system copy; everything else in it is kept) and Labwc reloads.
import { lstatSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import type { Avail, Exec } from './system'
import type { ShortcutFiles } from './shortcutsHost'

export const WINDOW_THEMES = { dark: 'WorkSuite', light: 'WorkSuite-Light' } as const

/** rc.xml with <theme><name> set; null when it already is (nothing to write or reload). */
export function rcWithTheme(rc: string, name: string): string | null {
  const theme = /<theme>([\s\S]*?)<\/theme>/.exec(rc)
  if (!theme) return rc.replace(/<\/labwc_config>/, `  <theme><name>${name}</name></theme>\n</labwc_config>`)
  const cur = /<name>([^<]*)<\/name>/.exec(theme[1])
  if (cur?.[1].trim() === name) return null
  const body = cur ? theme[1].replace(cur[0], `<name>${name}</name>`) : `\n    <name>${name}</name>${theme[1]}`
  return rc.slice(0, theme.index) + `<theme>${body}</theme>` + rc.slice(theme.index + theme[0].length)
}

export async function applyWindowTheme(dark: boolean, f: ShortcutFiles, exec: Exec): Promise<Avail<true>> {
  let linked = false
  try { linked = lstatSync(f.userRc).isSymbolicLink() } catch { /* absent */ }
  let current = ''
  try { current = readFileSync(linked ? f.systemRc : f.userRc, 'utf8') } catch {
    try { current = readFileSync(f.systemRc, 'utf8') } catch { return { available: false, reason: 'labwc_config' } }
  }
  const text = rcWithTheme(current, dark ? WINDOW_THEMES.dark : WINDOW_THEMES.light)
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

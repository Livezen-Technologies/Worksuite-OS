// Title bars (issues #15, #33): Settings › Appearance picks the Labwc theme for every app's title bar, the user's rc.xml
// keeps it through the touchscreen writer, and the shell's Electron app windows always get a frame and a minimum size.
import { mkdirSync, mkdtempSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { applyWindowTheme, rcWithTheme, WINDOW_THEMES } from './windowTheme'
import { carryDesktops } from './touch'
import { APP_WINDOW } from './windowDefaults'
import { isDarkTheme } from '../src/lib/setup'

const RC = readFileSync(path.join(__dirname, '../../services/session/labwc/rc.xml'), 'utf8')
const nameOf = (rc: string) => /<theme>[\s\S]*?<name>([^<]*)<\/name>/.exec(rc)?.[1]

describe('window theme', () => {
  it('sets only the theme name, and reports nothing to do when it is set', () => {
    expect(nameOf(RC)).toBe(WINDOW_THEMES.dark)
    const light = rcWithTheme(RC, WINDOW_THEMES.light)!
    expect(nameOf(light)).toBe('WorkSuite-Light')
    expect(light.replace('<name>WorkSuite-Light</name>', '<name>WorkSuite</name>')).toBe(RC)
    expect(rcWithTheme(light, WINDOW_THEMES.light)).toBeNull()
    expect(rcWithTheme('<labwc_config>\n</labwc_config>', 'WorkSuite')).toContain('<theme><name>WorkSuite</name></theme>')
    expect(nameOf(rcWithTheme('<labwc_config><theme><cornerRadius>8</cornerRadius></theme></labwc_config>', 'X')!)).toBe('X')
  })

  it('writes the user copy (replacing the symlink to the system file) and reloads Labwc once', async () => {
    const d = mkdtempSync(path.join(os.tmpdir(), 'wt-'))
    const files = { userRc: path.join(d, 'user', 'rc.xml'), systemRc: path.join(d, 'rc.xml') }
    writeFileSync(files.systemRc, RC)
    mkdirSync(path.dirname(files.userRc))
    symlinkSync(files.systemRc, files.userRc)
    const calls: string[][] = []
    const exec = async (cmd: string, args: string[]) => { calls.push([cmd, ...args]); return { code: 0, stdout: '', stderr: '' } }
    expect(await applyWindowTheme(false, files, exec as never)).toEqual({ available: true, value: true })
    expect(nameOf(readFileSync(files.userRc, 'utf8'))).toBe('WorkSuite-Light')
    expect(nameOf(readFileSync(files.systemRc, 'utf8'))).toBe('WorkSuite')
    expect(await applyWindowTheme(false, files, exec as never)).toEqual({ available: true, value: true })
    expect(calls).toEqual([['labwc', '--reconfigure']])
  })

  it('survives the touchscreen writer rebuilding rc.xml from the system file', () => {
    expect(nameOf(carryDesktops(rcWithTheme(RC, 'WorkSuite-Light')!, RC))).toBe('WorkSuite-Light')
    expect(carryDesktops(RC, RC)).toBe(RC)
  })

  it('Auto follows the system colour scheme', () => {
    expect(isDarkTheme({ theme: 'Dark', accent: 'Blue' })).toBe(true)
    expect(isDarkTheme({ theme: 'Light', accent: 'Blue' })).toBe(false)
    expect(isDarkTheme({ theme: 'Auto', accent: 'Blue' }, () => ({ matches: false }))).toBe(false)
    expect(isDarkTheme({ theme: 'Auto', accent: 'Blue' }, () => ({ matches: true }))).toBe(true)
  })
})

describe('app windows', () => {
  it('have the compositor frame with all three buttons and a minimum size', () => {
    expect(APP_WINDOW).toMatchObject({ frame: true, resizable: true, minimizable: true, maximizable: true })
    expect(APP_WINDOW.minWidth).toBeGreaterThan(0)
    expect(APP_WINDOW.minHeight).toBeGreaterThan(0)
    // Every ordinary app window the shell opens uses them (not frameless, not fixed-size).
    for (const f of ['appwindow.ts', 'whatsappwindow.ts']) expect(readFileSync(path.join(__dirname, f), 'utf8')).toContain('...APP_WINDOW')
    expect(readFileSync(path.join(__dirname, 'main.ts'), 'utf8').match(/\.\.\.APP_WINDOW/g)).toHaveLength(2)
  })

  it('leave title bars to Labwc (no client-side decorations forced on Wayland)', () => {
    for (const f of ['main.ts', 'appwindow.ts', 'whatsappwindow.ts']) expect(readFileSync(path.join(__dirname, f), 'utf8')).not.toContain('WaylandWindowDecorations')
  })
})

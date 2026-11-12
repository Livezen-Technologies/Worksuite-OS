import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { BLUR, cleanLookChange, makeDesktopLook, parseGv, withAlignment } from './desktopLook'
import type { Exec } from './system'

/** gsettings over an in-memory dconf, seeded from the shipped overrides (the values a new account starts with). */
function fakeGsettings() {
  const db = new Map<string, string>()
  // The shipped defaults: GNOME's in the gschema overrides, the extensions' in the dconf keyfile ([org/gnome/...] paths).
  const override = readFileSync(new URL('../../services/session/gnome/96_worksuite-desktop.gschema.override', import.meta.url), 'utf8')
    + readFileSync(new URL('../../services/session/gnome/95_worksuite-gnome.gschema.override', import.meta.url), 'utf8')
    + readFileSync(new URL('../../services/session/gnome/dconf/00-worksuite-desktop', import.meta.url), 'utf8').replace(/^\[([^\]]+)\]$/gm, (_m, p: string) => `[${p.replace(/\//g, '.')}]`)
  let schema = ''
  for (const line of override.split('\n')) {
    const h = /^\[(.+)\]$/.exec(line); if (h) { schema = h[1]; continue }
    const kv = /^([a-z0-9-]+)=(.*)$/.exec(line); if (kv) db.set(`${schema} ${kv[1]}`, kv[2])
  }
  const defaults: Record<string, string> = { 'org.gnome.desktop.interface enable-animations': 'true', 'org.gnome.shell.extensions.dash-to-panel animate-window-launch': 'true', 'org.gnome.shell.extensions.dash-to-panel animate-app-switch': 'true' }
  const writes: string[] = []
  const exec: Exec = async (cmd, args) => {
    expect(cmd).toBe('gsettings')
    const k = `${args[1]} ${args[2]}`
    if (args[0] === 'get') { const v = db.get(k) ?? defaults[k]; return v === undefined ? { code: 1, stdout: '', stderr: 'No such key' } : { code: 0, stdout: v + '\n', stderr: '' } }
    if (args[0] === 'set') { db.set(k, args[3]); writes.push(`${k}=${args[3]}`); return { code: 0, stdout: '', stderr: '' } }
    return { code: 1, stdout: '', stderr: 'usage' }
  }
  return { db, exec, writes }
}

describe('desktop look (Settings › Personalization)', () => {
  it('a new account starts with glass, a centred 48 px bottom taskbar and standard animations', async () => {
    const r = await makeDesktopLook(fakeGsettings().exec).read()
    expect(r).toEqual({ available: true, value: { glass: true, transparency: true, animations: 'standard', taskbar: { align: 'center', size: 48, position: 'BOTTOM', autohide: false } } })
  })
  it('Glass effects off disables blur-my-shell outright and makes the taskbar and Start menu opaque; on restores both', async () => {
    const g = fakeGsettings(), look = makeDesktopLook(g.exec)
    const off = await look.apply({ glass: false, transparency: false })
    expect(off.available && off.value.glass).toBe(false)
    expect(parseGv(g.db.get('org.gnome.shell enabled-extensions')!)).not.toContain(BLUR)
    expect(parseGv(g.db.get('org.gnome.shell enabled-extensions')!)).toContain('dash-to-panel@jderose9.github.com')
    expect(g.db.get('org.gnome.shell.extensions.dash-to-panel trans-panel-opacity')).toBe('1')
    expect(g.db.get('org.gnome.shell.extensions.arcmenu menu-background-color')).toBe("'rgb(10,22,52)'")
    const on = await look.apply({ glass: true })
    expect(on.available && on.value.glass).toBe(true)
    expect(parseGv(g.db.get('org.gnome.shell enabled-extensions')!)).toContain(BLUR)
    expect(Number(g.db.get('org.gnome.shell.extensions.dash-to-panel trans-panel-opacity'))).toBeLessThan(1)
  })
  it('animations: off turns GNOME animations off; reduced keeps GNOME on and the taskbar effects off', async () => {
    const g = fakeGsettings(), look = makeDesktopLook(g.exec)
    let r = await look.apply({ animations: 'off' })
    expect(g.db.get('org.gnome.desktop.interface enable-animations')).toBe('false')
    expect(r.available && r.value.animations).toBe('off')
    r = await look.apply({ animations: 'reduced' })
    expect(g.db.get('org.gnome.desktop.interface enable-animations')).toBe('true')
    expect(g.db.get('org.gnome.shell.extensions.dash-to-panel animate-window-launch')).toBe('false')
    expect(r.available && r.value.animations).toBe('reduced')
  })
  it('the lightest look is glass off, no transparency, no animations', async () => {
    const r = await makeDesktopLook(fakeGsettings().exec).apply({ lightest: true })
    expect(r.available && { g: r.value.glass, t: r.value.transparency, a: r.value.animations }).toEqual({ g: false, t: false, a: 'off' })
  })
  it('taskbar: left alignment, size, top and auto-hide are written for every monitor and read back', async () => {
    const g = fakeGsettings(), look = makeDesktopLook(g.exec)
    const r = await look.apply({ taskbar: { align: 'left', size: 56, position: 'TOP', autohide: true } })
    expect(r.available && r.value.taskbar).toEqual({ align: 'left', size: 56, position: 'TOP', autohide: true })
    const pos = JSON.parse(parseGv(g.db.get('org.gnome.shell.extensions.dash-to-panel panel-element-positions')!) as string)
    expect(Object.keys(pos)).toEqual(['0', '1', '2', '3'])
    for (const m of Object.values(pos) as { element: string; position: string }[][]) {
      expect(m.find((e) => e.element === 'taskbar')!.position).toBe('stackedTL')
      expect(m.find((e) => e.element === 'dateMenu')!.position).toBe('stackedBR')   // the clock stays right
    }
    expect(JSON.parse(parseGv(g.db.get('org.gnome.shell.extensions.dash-to-panel panel-sizes')!) as string)).toEqual({ 0: 56, 1: 56, 2: 56, 3: 56 })
  })
  it('only changed keys are written (no churn on every click)', async () => {
    const g = fakeGsettings(), look = makeDesktopLook(g.exec)
    await look.apply({ taskbar: { autohide: true } })
    expect(g.writes.filter((w) => w.includes('enabled-extensions') || w.includes('panel-element-positions') || w.includes('enable-animations'))).toEqual([])
  })
  it('without gsettings (or the extensions) the panel says unavailable instead of pretending', async () => {
    const missing: Exec = async () => ({ code: 127, stdout: '', stderr: '', missing: true })
    expect(await makeDesktopLook(missing).read()).toEqual({ available: false, reason: 'unavailable' })
    const noSchema: Exec = async () => ({ code: 1, stdout: '', stderr: 'No such schema “org.gnome.shell.extensions.dash-to-panel”' })
    expect(await makeDesktopLook(noSchema).read()).toEqual({ available: false, reason: 'not_installed' })
  })
  it('IPC input: only known fields and values pass', () => {
    expect(cleanLookChange({ glass: false })).toEqual({ glass: false })
    expect(cleanLookChange({ taskbar: { size: 48, align: 'left' } })).toEqual({ taskbar: { size: 48, align: 'left' } })
    for (const bad of [null, 'x', { glass: 'yes' }, { animations: 'max' }, { taskbar: { size: 41 } }, { taskbar: { position: 'LEFT' } }, { extra: 1 }, { lightest: false }])
      expect(cleanLookChange(bad)).toBeNull()
  })
  it('alignment keeps every other element where it was', () => {
    const s = withAlignment('{}', 'center')
    expect(Object.values(JSON.parse(s))[0]).toHaveLength(9)
  })
})

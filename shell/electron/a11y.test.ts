import { describe, expect, it } from 'vitest'
import { cleanA11y, makeA11y } from './a11y'
import type { Exec } from './system'

function gs(initial: Record<string, string>) {
  const db = new Map(Object.entries(initial))
  const exec: Exec = async (_c, a) => {
    const k = `${a[1]} ${a[2]}`
    if (a[0] === 'get') return db.has(k) ? { code: 0, stdout: db.get(k)! + '\n', stderr: '' } : { code: 1, stdout: '', stderr: 'No such key' }
    db.set(k, a[3]); return { code: 0, stdout: '', stderr: '' }
  }
  return { db, exec }
}
const DEFAULTS = {
  'org.gnome.desktop.interface text-scaling-factor': '1.0', 'org.gnome.desktop.a11y.interface high-contrast': 'false',
  'org.gnome.desktop.interface enable-animations': 'true', 'org.gnome.desktop.a11y.applications screen-reader-enabled': 'false',
  'org.gnome.desktop.a11y.applications screen-keyboard-enabled': 'false', 'org.gnome.desktop.a11y.keyboard stickykeys-enable': 'false',
  'org.gnome.desktop.a11y.keyboard slowkeys-enable': 'false', 'org.gnome.desktop.interface cursor-size': '24',
}

describe('Settings › Accessibility (GNOME a11y keys)', () => {
  it('reads GNOME defaults', async () => {
    expect(await makeA11y(gs(DEFAULTS).exec).read()).toEqual({ available: true, value: { textSize: 1, highContrast: false, reduceMotion: false, screenReader: false, screenKeyboard: false, stickyKeys: false, slowKeys: false, cursorSize: 24 } })
  })
  it('reduce motion turns GNOME animations off; larger text and cursor write the real keys', async () => {
    const g = gs(DEFAULTS), a = makeA11y(g.exec)
    const r = await a.apply({ reduceMotion: true, textSize: 1.3, cursorSize: 48, highContrast: true })
    expect(g.db.get('org.gnome.desktop.interface enable-animations')).toBe('false')
    expect(g.db.get('org.gnome.desktop.interface text-scaling-factor')).toBe('1.3')
    expect(g.db.get('org.gnome.desktop.interface cursor-size')).toBe('48')
    expect(g.db.get('org.gnome.desktop.a11y.interface high-contrast')).toBe('true')
    expect(r.available && r.value).toMatchObject({ reduceMotion: true, textSize: 1.3, cursorSize: 48, highContrast: true })
  })
  it('only known settings with valid values pass IPC', () => {
    expect(cleanA11y({ screenReader: true })).toEqual({ screenReader: true })
    for (const bad of [null, {}, { textSize: 3 }, { cursorSize: 25 }, { screenReader: 'on' }, { other: true }]) expect(cleanA11y(bad)).toBeNull()
  })
  it('no gsettings: unavailable, not a fake switch', async () => {
    expect(await makeA11y(async () => ({ code: 127, stdout: '', stderr: '', missing: true })).read()).toEqual({ available: false, reason: 'unavailable' })
  })
})

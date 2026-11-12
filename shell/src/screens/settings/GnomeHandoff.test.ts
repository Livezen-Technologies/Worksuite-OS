import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { GNOME_PANELS } from './GnomeHandoff'

describe('GNOME Settings hand-off', () => {
  it('every handed-off section opens a panel the main process allows, and nothing else is allowed', () => {
    const main = readFileSync(new URL('../../../electron/main.ts', import.meta.url), 'utf8')
    const allowed = new Set([...(/GNOME_SETTINGS_PANELS = new Set\(\[([^\]]*)\]\)/.exec(main)![1].matchAll(/'([a-z-]+)'/g))].map((m) => m[1]))
    expect(new Set(Object.values(GNOME_PANELS))).toEqual(allowed)
  })
  it('hands off exactly the sections whose backends drive the old Labwc desktop', () => {
    expect(Object.keys(GNOME_PANELS).sort()).toEqual(['Appearance', 'Clipboard', 'Display', 'Keyboard', 'Lock screen', 'Mouse & touchpad', 'Multitasking', 'Notifications', 'Touchscreen & pen'])
  })
})

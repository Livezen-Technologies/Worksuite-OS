import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { GNOME_PANELS } from './GnomeHandoff'

describe('GNOME Settings hand-off', () => {
  it('every handed-off section opens a panel the main process allows, and nothing else is allowed', () => {
    const main = readFileSync(new URL('../../../electron/main.ts', import.meta.url), 'utf8')
    const allowed = new Set([...(/GNOME_SETTINGS_PANELS = new Set\(\[([^\]]*)\]\)/.exec(main)![1].matchAll(/'([a-z-]+)'/g))].map((m) => m[1]))
    expect(new Set(Object.values(GNOME_PANELS))).toEqual(allowed)
  })
  it('as on Ubuntu: under GNOME every section GNOME Settings covers opens there; WorkSuite Settings keeps only its own', async () => {
    const { WORKSUITE_ONLY } = await import('./GnomeHandoff')
    const settings = readFileSync(new URL('../Settings.tsx', import.meta.url), 'utf8')
    const all = [...settings.matchAll(/\{ id: '([^']+)', group:/g)].map((m) => m[1])
    for (const id of all) expect(WORKSUITE_ONLY.has(id) || id in GNOME_PANELS, id).toBe(true)          // nothing falls through
    for (const id of WORKSUITE_ONLY) expect(id in GNOME_PANELS, id).toBe(false)                           // no duplicates
    expect([...WORKSUITE_ONLY].sort()).toEqual(['AI', 'Devices', 'Drivers', 'Graphics', 'Managed', 'Personalization', 'Privacy & security', 'Updates', 'Users'])
  })
})

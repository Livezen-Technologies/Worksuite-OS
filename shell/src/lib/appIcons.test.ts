// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { brandIcon, glyphTile, MODULE_ICONS } from './brandIcons'
import { requestIcon, resetIconCache } from './appIcons'
import { appForWindow, buildLauncherApps } from './launcher'
import { shellPrefsFrom, taskbarAlign } from './shellPrefs'

describe('brandIcon', () => {
  it('bundles WorkSuite, Office, module and system icons; others get none', () => {
    expect(brandIcon('worksuite-desktop')).toMatch(/worksuite\.png/)
    expect(decodeURIComponent(brandIcon('office')!)).toMatch(/#4552E0/i)
    for (const id of ['worksuite-mail', 'worksuite-chat', 'worksuite-calendar', 'worksuite-tasks', 'worksuite-drive', 'worksuite-crm', 'worksuite-hr', 'appcenter', 'monitor', 'settings', 'office-sheets'])
      expect(brandIcon(id), id).toMatch(/^data:image\/svg\+xml,/)
    expect(brandIcon('worksuite-unknown')).toBeNull()
    expect(brandIcon('firefox-esr')).toBeNull()
  })
  it('draws the module colour from WorkSuite Desktop', () => {
    expect(decodeURIComponent(brandIcon('worksuite-mail')!)).toContain(`fill="${MODULE_ICONS.mail[1]}"`)
    expect(glyphTile('nope', '#000000')).toBeNull()
    expect(glyphTile('mail', 'red"/><script')).toBeNull()
  })
})

describe('requestIcon', () => {
  afterEach(() => { resetIconCache(); delete (window as { worksuite?: unknown }).worksuite })
  it('batches names into one call, caches results and keeps only image data URLs', async () => {
    const appIcons = vi.fn(async (names: string[]) => Object.fromEntries(names.map((n) => [n, n === 'firefox' ? 'data:image/png;base64,AA' : n === 'evil' ? 'javascript:x' : null])))
    ;(window as unknown as { worksuite: unknown }).worksuite = { appIcons }
    const got: Record<string, string | null> = {}
    for (const n of ['firefox', 'nope', 'evil']) requestIcon(n, 44, (v) => { got[n] = v })
    await new Promise((r) => setTimeout(r, 0))
    expect(appIcons).toHaveBeenCalledTimes(1)
    expect(got).toEqual({ firefox: 'data:image/png;base64,AA', nope: null, evil: null })
    expect(requestIcon('firefox', 44, () => undefined)).toBe('data:image/png;base64,AA')
    expect(appIcons).toHaveBeenCalledTimes(1)
  })
  it('resolves to null without the bridge (letter mark)', async () => {
    let v: string | null | undefined
    requestIcon('x', 30, (r) => { v = r })
    await new Promise((r) => setTimeout(r, 0))
    expect(v).toBeNull()
  })
})

describe('appForWindow', () => {
  const apps = buildLauncherApps([{ id: 'mail', name: 'Mail' }], [
    { id: 'org.gnome.Nautilus', name: 'Files', generic_name: null, comment: null, icon: 'org.gnome.Nautilus', categories: [], keywords: [] },
    { id: 'io.github.celluloid_player.Celluloid', name: 'Celluloid', generic_name: null, comment: null, icon: 'io.github.celluloid_player.Celluloid', categories: [], keywords: [], wm_class: 'celluloid' },
    { id: 'firefox-esr', name: 'Firefox ESR', generic_name: null, comment: null, icon: 'firefox-esr', categories: [], keywords: [] },
  ], null)
  it('maps Wayland app_ids to desktop entries', () => {
    expect(appForWindow(apps, 'firefox-esr')?.id).toBe('firefox-esr')
    expect(appForWindow(apps, 'Firefox-ESR')?.id).toBe('firefox-esr')
    expect(appForWindow(apps, 'celluloid')?.id).toBe('io.github.celluloid_player.Celluloid')
    expect(appForWindow(apps, 'nautilus')?.id).toBe('org.gnome.Nautilus')
    expect(appForWindow(apps, 'lk.worksuite.mail')?.id).toBe('worksuite-mail')
    expect(appForWindow(apps, 'something-else')).toBeUndefined()
    expect(appForWindow(apps, '')).toBeUndefined()
  })
  it('carries Icon= on Linux apps', () => {
    expect(apps.find((a) => a.id === 'firefox-esr')?.icon).toBe('firefox-esr')
  })
})

describe('taskbar alignment preference', () => {
  afterEach(() => localStorage.clear())
  it('defaults to centre, validates, and falls back to this computer', () => {
    expect(taskbarAlign({})).toBe('center')
    expect(shellPrefsFrom({ taskbarAlign: 'left' }).taskbarAlign).toBe('left')
    expect(shellPrefsFrom({ taskbarAlign: 'right' }).taskbarAlign).toBeUndefined()
    localStorage.setItem('ws.taskbarAlign', 'left')
    expect(taskbarAlign({})).toBe('left')
    expect(taskbarAlign({ taskbarAlign: 'center' })).toBe('center')
  })
})

describe('taskbar window matching', () => {
  it('a WorkSuite app window joins its worksuite-<module> pin', async () => {
    const { matchesApp } = await import('./panel')
    expect(matchesApp('worksuite-mail', 'lk.worksuite.mail')).toBe(true)
    expect(matchesApp('worksuite-mail', 'lk.worksuite.chat')).toBe(false)
  })
})

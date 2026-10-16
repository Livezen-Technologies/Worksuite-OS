import { describe, expect, it } from 'vitest'
import { applyShellPrefs, shellPrefsFrom, taskbarPins, toggleFavorite } from './shellPrefs'
import { buildLauncherApps, startPins } from './launcher'

describe('Shell ENH-01 preferences (WSOS-DSK-001)', () => {
  it('validates untrusted data', () => {
    expect(shellPrefsFrom(null)).toEqual({})
    expect(shellPrefsFrom({ favorites: ['worksuite-mail', 'worksuite-mail', '../x', 3], taskbar: 'no', order: ['office'] }))
      .toEqual({ favorites: ['worksuite-mail'], order: ['office'] })
    expect(shellPrefsFrom({ favorites: Array.from({ length: 200 }, (_, i) => `a${i}`) }).favorites).toHaveLength(64)
  })
  const apps = buildLauncherApps(null, null, null)
  it('keeps the shell defaults when the user has none', () => {
    expect(applyShellPrefs(apps, {})).toEqual(apps)
    expect(taskbarPins({}, ['worksuite-mail'])).toEqual(['worksuite-mail'])
  })
  it('favourites, order and taskbar pins come from the user', () => {
    const p = shellPrefsFrom({ favorites: ['worksuite-crm', 'worksuite-tasks'], order: ['worksuite-tasks', 'worksuite-crm'], taskbar: ['worksuite-meet'] })
    const mine = applyShellPrefs(apps, p)
    expect(mine.filter((a) => a.fav).map((a) => a.id)).toEqual(['worksuite-tasks', 'worksuite-crm'])
    expect(startPins(mine, 12).slice(0, 2).map((a) => a.id)).toEqual(['worksuite-tasks', 'worksuite-crm'])
    expect(taskbarPins(p, ['worksuite-mail'])).toEqual(['worksuite-meet'])
  })
  it('pin and unpin start from the current favourites', () => {
    const p1 = toggleFavorite({}, apps, 'worksuite-crm')
    expect(p1.favorites).toEqual([...apps.filter((a) => a.fav).map((a) => a.id), 'worksuite-crm'])
    expect(toggleFavorite(p1, apps, 'worksuite-crm').favorites).not.toContain('worksuite-crm')
  })
})

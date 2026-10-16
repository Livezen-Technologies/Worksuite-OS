import { describe, expect, it } from 'vitest'
import { appColor, detailSecurity, expandPermissions, featuredApp, launchIdFor } from './appdetail'
import { alphaGroups, buildLauncherApps, startPins, tileColor } from './launcher'
import { niceTop, pushHistory, sparkPoints } from './monitorApi'
import type { AppView } from './appcatalog'

const app = (o: Partial<AppView>): AppView => ({ key: 'k', catalogId: null, appimageId: null, name: 'X', publisher: '', summary: '', source: 'APT', category: 'Other', installed: false, blocked: null, trust: null, needsApproval: false, ...o })
const desk = (id: string, name: string) => ({ id, name, generic_name: null, comment: null, icon: null, categories: [], keywords: [] })

describe('App Center detail helpers', () => {
  it('features an approved, not installed app, Flatpak first', () => {
    const apps = [app({ key: 'a', name: 'A', catalogId: 'apt:a' }), app({ key: 'b', name: 'B', catalogId: 'flatpak:org.b.B', source: 'Flatpak' }), app({ key: 'c', name: 'C', catalogId: 'flatpak:org.c.C', source: 'Flatpak', installed: true })]
    expect(featuredApp(apps)?.key).toBe('b')
    expect(featuredApp([app({ catalogId: 'apt:x', blocked: 'policy' })])).toBeNull()
  })
  it('finds the desktop entry of an installed app, or none', () => {
    const installed = [desk('org.gimp.GIMP', 'GIMP'), desk('code', 'Visual Studio Code')]
    expect(launchIdFor(app({ installed: true, catalogId: 'flatpak:org.gimp.GIMP', source: 'Flatpak' }), installed)).toBe('org.gimp.GIMP')
    expect(launchIdFor(app({ installed: true, catalogId: 'apt:code', name: 'VS Code' }), installed)).toBe('code')
    expect(launchIdFor(app({ installed: true, catalogId: 'apt:zoom', name: 'Zoom' }), installed)).toBeNull()
    expect(launchIdFor(app({ installed: false, catalogId: 'apt:code' }), installed)).toBeNull()
  })
  it('splits permissions into switches and keeps the broad flag', () => {
    expect(expandPermissions(['filesystems=home;xdg-download', 'shared=network'], ['filesystems=home;xdg-download'])).toEqual([
      { perm: 'filesystems=home', broad: true }, { perm: 'filesystems=xdg-download', broad: true }, { perm: 'shared=network', broad: false }])
  })
  it('claims a sandbox only for Flatpak and never a vulnerability scan', () => {
    const fp = detailSecurity(app({ source: 'Flatpak', catalogId: 'flatpak:org.b.B' }), 'Acme')
    expect(fp[0].tone).toBe('ok')
    expect(detailSecurity(app({ source: 'APT' }), null)[0].tone).toBe('warn')
    for (const s of ['Flatpak', 'APT', 'AppImage', 'WorkSuite'] as const) expect(detailSecurity(app({ source: s }), null).at(-1)!.tone).toBe('none')
    expect(appColor('Slack')).toBe(appColor('Slack'))
  })
})

describe('Start menu (G02)', () => {
  it('pins favourites first and ends with App Center, Settings and the monitor', () => {
    const apps = buildLauncherApps([{ id: 'mail', name: 'Mail' }, { id: 'tasks', name: 'Tasks' }], [desk('firefox-esr', 'Firefox ESR')], null)
    const settings = { ...apps[0], id: 'settings', name: 'Settings' }
    const pins = startPins(apps, 5, [settings])
    expect(pins.map((p) => p.id)).toEqual(['worksuite-mail', 'firefox-esr', 'appcenter', 'settings', 'monitor'])
  })
  it('groups all apps by letter and picks the darker mark colour for tiles', () => {
    const apps = buildLauncherApps([], [desk('a', 'alpha'), desk('b', 'Beta'), desk('c', '3D Viewer')], null)
    expect(alphaGroups(apps).map((g) => g.letter)).toEqual(['#', 'A', 'B', 'S'])
    expect(tileColor({ bg: '#dbeafe', fg: '#1d4ed8' })).toBe('#1d4ed8')
    expect(tileColor({ bg: '#0f172a', fg: '#e2e8f0' })).toBe('#0f172a')
  })
})

describe('monitor graph helpers', () => {
  it('keeps a fixed history and scales points into the box', () => {
    expect(pushHistory([1, 2, 3], 4, 3)).toEqual([2, 3, 4])
    expect(pushHistory([1], null)).toEqual([1])
    expect(sparkPoints([0, 100], 100)).toBe('0.0,54.0 200.0,2.0')
    expect(niceTop([3.2e6], 1e6)).toBe(5e6)
    expect(niceTop([], 1e5)).toBe(1e5)
  })
})

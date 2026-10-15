import { describe, expect, it } from 'vitest'
import { buildLauncherApps, filterApps, taskbarApps } from './launcher'

const ff = { id: 'firefox-esr', name: 'Firefox ESR', generic_name: 'Web Browser', comment: null, icon: null, categories: ['Network'], keywords: ['internet'] }
const term = { id: 'foot', name: 'Foot', generic_name: 'Terminal', comment: null, icon: null, categories: ['TerminalEmulator'], keywords: [] }
const office = { id: 'worksuite-office', name: 'WorkSuite Office', generic_name: null, comment: null, icon: null, categories: ['Office'], keywords: [] }

describe('launcher list', () => {
  it("shows only the org's WorkSuite apps, launching worksuite-<id>", () => {
    const apps = buildLauncherApps([{ id: 'mail', name: 'Mail' }, { id: 'newmod', name: 'New Module' }], [], null)
    expect(apps.filter((a) => a.kind === 'WorkSuite').map((a) => [a.id, a.launch])).toEqual([
      ['worksuite-mail', { desktop: 'worksuite-mail' }], ['worksuite-newmod', { desktop: 'worksuite-newmod' }]])
    expect(apps.find((a) => a.id === 'worksuite-newmod')?.mark).toBe('NM')
  })
  it('falls back to the built-in list when the org list is unknown', () => {
    expect(buildLauncherApps(null, null, null).filter((a) => a.kind === 'WorkSuite')).toHaveLength(9)
  })
  it('lists Office entries only when WorkSuite Office is installed', () => {
    expect(buildLauncherApps([], [ff], null).some((a) => a.id.startsWith('office'))).toBe(false)
    const apps = buildLauncherApps([], [ff, office], 'worksuite-office')
    expect(apps.filter((a) => a.id.startsWith('office')).map((a) => a.launch)).toEqual([{ office: 'start' }, { office: 'docs' }, { office: 'sheets' }, { office: 'slides' }])
    expect(apps.some((a) => a.id === 'worksuite-office')).toBe(false)
  })
  it('lists installed Linux apps and skips worksuite-* entries', () => {
    const apps = buildLauncherApps([], [ff, term, { ...ff, id: 'worksuite-mail', name: 'WorkSuite Mail' }], null)
    expect(apps.filter((a) => a.kind === 'Linux app').map((a) => a.id)).toEqual(['firefox-esr', 'foot'])
    expect(apps.find((a) => a.id === 'foot')?.mark).toBe('>_')
    expect(apps.find((a) => a.id === 'firefox-esr')?.fav).toBe(true)
  })
  it('searches names and keywords; tabs filter; App Center only on search', () => {
    const apps = buildLauncherApps([{ id: 'mail', name: 'Mail' }], [ff, term], 'x')
    expect(filterApps(apps, 'all', '').some((a) => a.id === 'appcenter')).toBe(false)
    expect(filterApps(apps, 'all', 'browser').map((a) => a.id)).toEqual(['firefox-esr'])
    expect(filterApps(apps, 'all', 'xlsx').map((a) => a.id)).toEqual(['office-sheets'])
    expect(filterApps(apps, 'all', 'app center').map((a) => a.id)).toEqual(['appcenter'])
    expect(filterApps(apps, 'linux', '').map((a) => a.id)).toEqual(['firefox-esr', 'foot'])
    expect(filterApps(apps, 'ws', 'foot')).toEqual([])
  })
  it('drops taskbar pins that are not available', () => {
    const apps = buildLauncherApps([{ id: 'chat', name: 'Chat' }], [ff], null)
    expect(taskbarApps(apps, ['worksuite-mail', 'worksuite-chat', 'office', 'firefox-esr']).map((a) => a.id)).toEqual(['worksuite-chat', 'firefox-esr'])
  })
})

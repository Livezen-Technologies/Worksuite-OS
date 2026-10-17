import { describe, expect, it } from 'vitest'
import { alphaGroups, appForWindow, buildLauncherApps, filterApps, startPins, taskbarApps } from './launcher'

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
  it('carries the offline level each app declares (WSOS-SYN-009)', () => {
    const apps = buildLauncherApps([{ id: 'mail', name: 'Mail', offline_level: 'full_offline' }, { id: 'chat', name: 'Chat' }], [], null)
    expect(apps.filter((a) => a.kind === 'WorkSuite').map((a) => a.offline)).toEqual(['full_offline', undefined])
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
    expect(apps.filter((a) => a.kind === 'Linux app').map((a) => a.id)).toEqual(['lk.worksuite.whatsapp', 'firefox-esr', 'foot'])
    expect(apps.find((a) => a.id === 'foot')?.mark).toBe('>_')
    expect(apps.find((a) => a.id === 'firefox-esr')?.fav).toBe(true)
  })
  it('searches names and keywords; tabs filter; App Center only on search', () => {
    const apps = buildLauncherApps([{ id: 'mail', name: 'Mail' }], [ff, term], 'x')
    expect(filterApps(apps, 'all', '').some((a) => a.id === 'appcenter')).toBe(false)
    expect(filterApps(apps, 'all', 'browser').map((a) => a.id)).toEqual(['firefox-esr'])
    expect(filterApps(apps, 'all', 'xlsx').map((a) => a.id)).toEqual(['office-sheets'])
    expect(filterApps(apps, 'all', 'app center').map((a) => a.id)).toEqual(['appcenter'])
    expect(filterApps(apps, 'linux', '').map((a) => a.id)).toEqual(['lk.worksuite.whatsapp', 'firefox-esr', 'foot'])
    expect(filterApps(apps, 'ws', 'foot')).toEqual([])
  })
  it('"files" finds the shell\'s Files first, not an editor that edits text files', () => {
    const vim = { id: 'vim', name: 'Vim', generic_name: 'Text Editor', comment: 'Edit text files', icon: null, categories: ['Utility', 'TextEditor'], keywords: ['Text', 'editor'] }
    const fm = { id: 'org.example.Fm', name: 'Some File Manager', generic_name: null, comment: null, icon: null, categories: ['FileManager'], keywords: [] }
    const apps = buildLauncherApps([{ id: 'drive', name: 'Drive' }], [vim, fm], null)
    const hits = filterApps(apps, 'all', 'files').map((a) => a.id)
    expect(hits[0]).toBe('files')
    expect(hits).toContain('vim')
    expect(hits.indexOf('files')).toBeLessThan(hits.indexOf('vim'))
    expect(filterApps(apps, 'all', 'file')[0].id).toBe('files')   // the shell's own app before a Linux app's word match
    expect(apps.find((a) => a.id === 'files')?.launch).toEqual({ screen: 'files' })
  })
  it('drops taskbar pins that are not available', () => {
    const apps = buildLauncherApps([{ id: 'chat', name: 'Chat' }], [ff], null)
    expect(taskbarApps(apps, ['worksuite-mail', 'worksuite-chat', 'office', 'firefox-esr']).map((a) => a.id)).toEqual(['worksuite-chat', 'firefox-esr'])
  })
})

describe('WorkSuite Desktop in the start menu', () => {
  const desk = { id: 'worksuite', name: 'WorkSuite', generic_name: null, comment: null, icon: null, categories: ['Office'], keywords: [] }
  const web = [{ id: 'mail', name: 'Mail' }, { id: 'drive', name: 'Drive' }, { id: 'projects', name: 'Projects' }, { id: 'hr', name: 'HR' }]

  it('opens its modules in WorkSuite Desktop with --module, the rest in web app windows', () => {
    const apps = buildLauncherApps(web, [desk, ff], null, 'worksuite')
    expect(apps.filter((a) => a.kind === 'WorkSuite').map((a) => [a.id, a.launch])).toEqual([
      ['worksuite-desktop', { worksuite: 'home' }],
      ['worksuite-mail', { worksuite: 'mail' }],
      ['worksuite-drive', { worksuite: 'files' }],
      ['worksuite-projects', { desktop: 'worksuite-projects' }],
      ['worksuite-hr', { worksuite: 'hr' }],
    ])
    // Its own entry is the WorkSuite tile, not a Linux app.
    expect(apps.some((a) => a.kind === 'Linux app' && a.id === 'worksuite')).toBe(false)
  })

  it('without it, every tile is a web app window as before', () => {
    const apps = buildLauncherApps(web, [ff], null, null)
    expect(apps.filter((a) => a.kind === 'WorkSuite').every((a) => 'desktop' in a.launch)).toBe(true)
    expect(apps.some((a) => a.id === 'worksuite-desktop')).toBe(false)
  })
})

describe('WhatsApp in the launcher', () => {
  it('is pinned to Start by default and listed in All apps and search', async () => {
    const { WHATSAPP } = await import('./launcher')
    const apps = buildLauncherApps(null, null, null)
    expect(apps.find((a) => a.id === 'lk.worksuite.whatsapp')).toMatchObject({ name: 'WhatsApp', fav: true, launch: { desktop: 'lk.worksuite.whatsapp' } })
    expect(startPins(apps, 12).map((a) => a.id)).toContain(WHATSAPP.id)
    expect(alphaGroups(apps).flatMap((g) => g.apps.map((a) => a.id))).toContain(WHATSAPP.id)
    expect(filterApps(apps, 'all', 'whats').map((a) => a.id)).toEqual([WHATSAPP.id])
    expect(filterApps(apps, 'all', 'messenger').map((a) => a.id)).toContain(WHATSAPP.id)
    expect(WHATSAPP.kindLabel).toBe('launcher.kind.chat')
  })
  it('keeps a user\'s saved favourites (no WhatsApp forced in)', async () => {
    const { applyShellPrefs } = await import('./shellPrefs')
    const apps = applyShellPrefs(buildLauncherApps(null, null, null), { favorites: ['worksuite-mail'] })
    expect(apps.find((a) => a.id === 'lk.worksuite.whatsapp')?.fav).toBe(false)
  })
  it('is left out when policy turns it off, and the installed entry is not listed twice', () => {
    const entry = { id: 'lk.worksuite.whatsapp', name: 'WhatsApp', generic_name: null, comment: null, icon: 'lk.worksuite.whatsapp', categories: ['Network', 'InstantMessaging', 'Chat'], keywords: [] }
    expect(buildLauncherApps(null, [entry], null).filter((a) => a.id === 'lk.worksuite.whatsapp')).toHaveLength(1)
    expect(buildLauncherApps(null, [entry], null, null, false).some((a) => a.id === 'lk.worksuite.whatsapp')).toBe(false)
  })
  it('owns its window by app_id', () => {
    expect(appForWindow(buildLauncherApps(null, null, null), 'lk.worksuite.whatsapp')?.name).toBe('WhatsApp')
  })
})

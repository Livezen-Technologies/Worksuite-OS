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
    // One Office tile (its start centre makes documents, spreadsheets and presentations), with the suite's own icon.
    expect(apps.filter((a) => a.id.startsWith('office')).map((a) => a.launch)).toEqual([{ office: 'start' }])
    expect(apps.find((a) => a.id === 'office')?.icon).toBe(office.icon)
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
    expect(filterApps(apps, 'all', 'xlsx').map((a) => a.id)).toEqual(['office'])
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
  it('lists installed WorkSuite apps (POS, Desk, FrameFlow) with their own icons; hides only the shell\'s own entries', () => {
    const app = (id: string, name: string) => ({ id, name, generic_name: null, comment: null, icon: `/opt/${name}/icon.png`, categories: ['Office'], keywords: [] })
    const apps = buildLauncherApps([], [app('worksuite-pos', 'WorkSuite POS'), app('worksuite-desk', 'Worksuite Desk'), app('worksuite-frameflow', 'Worksuite FrameFlow'), app('worksuite-mail', 'WorkSuite Mail'), app('worksuite-url-handler', 'WorkSuite link handler')], null)
    const ours = apps.filter((a) => ['worksuite-pos', 'worksuite-desk', 'worksuite-frameflow'].includes(a.id))
    expect(ours.map((a) => [a.id, a.kind, a.icon])).toEqual([
      ['worksuite-pos', 'WorkSuite', '/opt/WorkSuite POS/icon.png'],
      ['worksuite-desk', 'WorkSuite', '/opt/Worksuite Desk/icon.png'],
      ['worksuite-frameflow', 'WorkSuite', '/opt/Worksuite FrameFlow/icon.png'],
    ])
    expect(apps.some((a) => a.id === 'worksuite-url-handler')).toBe(false)
    expect(apps.some((a) => a.id === 'worksuite-mail')).toBe(false)   // the shell's own web-app entry is never listed as an app
    expect(filterApps(apps, 'all', 'pos').map((a) => a.id)).toContain('worksuite-pos')
  })
  it('a taskbar pin for a module inside WorkSuite Desktop becomes the WorkSuite pin, once', () => {
    const desk = { id: 'worksuite', name: 'WorkSuite', generic_name: null, comment: null, icon: null, categories: [], keywords: [] }
    const apps = buildLauncherApps([{ id: 'mail', name: 'Mail' }, { id: 'chat', name: 'Chat' }, { id: 'meet', name: 'Meet' }], [desk, ff], null, 'worksuite')
    expect(taskbarApps(apps, ['worksuite-mail', 'worksuite-chat', 'worksuite-meet', 'firefox-esr']).map((a) => a.id)).toEqual(['worksuite-desktop', 'worksuite-meet', 'firefox-esr'])
  })
  it('Start pins WorkSuite apps before other Linux apps', () => {
    const app = (id: string, name: string) => ({ id, name, generic_name: null, comment: null, icon: null, categories: [], keywords: [] })
    const withIcon = (id: string, name: string) => ({ ...app(id, name), icon: id })
    const web = [{ id: 'projects', name: 'Projects' }, { id: 'meet', name: 'Meet' }, { id: 'pdf-studio', name: 'PDF Studio' }]
    const apps = buildLauncherApps(web, [app('celluloid', 'Celluloid'), withIcon('worksuite-pos', 'WorkSuite POS'), app('fcitx5-config', 'Fcitx 5')], null)
    const pins = startPins(apps, 12).map((a) => a.id)
    expect(pins.indexOf('worksuite-pos')).toBeLessThan(pins.indexOf('celluloid'))
    expect(pins.indexOf('worksuite-pos')).toBeLessThan(pins.indexOf('worksuite-projects'))   // installed app before web shortcuts
  })
  it('drops taskbar pins that are not available', () => {
    const apps = buildLauncherApps([{ id: 'chat', name: 'Chat' }], [ff], null)
    expect(taskbarApps(apps, ['worksuite-mail', 'worksuite-chat', 'office', 'firefox-esr']).map((a) => a.id)).toEqual(['worksuite-chat', 'firefox-esr'])
  })
})

describe('WorkSuite Desktop in the start menu', () => {
  const desk = { id: 'worksuite', name: 'WorkSuite', generic_name: null, comment: null, icon: null, categories: ['Office'], keywords: [] }
  const web = [{ id: 'mail', name: 'Mail' }, { id: 'drive', name: 'Drive' }, { id: 'projects', name: 'Projects' }, { id: 'hr', name: 'HR' }]

  it('is one WorkSuite tile with its own icon: modules it contains are not separate tiles, the rest stay web windows', () => {
    const icon = { ...desk, icon: '/usr/share/icons/hicolor/512x512/apps/worksuite.png', wm_class: 'WorkSuite' }
    const apps = buildLauncherApps(web, [icon, ff], null, 'worksuite')
    expect(apps.filter((a) => a.kind === 'WorkSuite').map((a) => [a.id, a.launch])).toEqual([
      ['worksuite-desktop', { worksuite: 'home' }],
      ['worksuite-projects', { desktop: 'worksuite-projects' }],   // not inside WorkSuite Desktop: still reachable
    ])
    const tile = apps.find((a) => a.id === 'worksuite-desktop')!
    expect(tile.icon).toBe(icon.icon)
    // Its window is matched to the tile (the taskbar shows its icon, not a letter placeholder).
    expect(appForWindow(apps, 'WorkSuite')?.id).toBe('worksuite-desktop')
    // Module names still find it.
    expect(filterApps(apps, 'all', 'mail').map((a) => a.id)).toContain('worksuite-desktop')
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

describe('shell entries', () => {
  it('SHELL_ENTRIES lists exactly the shell\'s own worksuite-* desktop entries (shell/apps), plus the HR web app', async () => {
    const { readdirSync } = await import('node:fs')
    const { SHELL_ENTRIES } = await import('../../electron/shellEntries')
    const files = readdirSync('apps').filter((f) => /^worksuite-.*\.desktop$/.test(f)).map((f) => f.replace(/\.desktop$/, ''))
    for (const f of files) expect(SHELL_ENTRIES.has(f), f).toBe(true)
    expect([...SHELL_ENTRIES].filter((id) => !files.includes(id))).toEqual(['worksuite-hr'])
  })
})

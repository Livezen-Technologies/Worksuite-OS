import { app, BrowserWindow, session, shell } from 'electron'
import { execFile } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import os from 'node:os'
import path from 'node:path'
import { appWebPreferences, appWindows } from './appwindows'
import { appLaunchCommand, scopeCommand, lockPaths, logoutCommand, readLockSettings, writeLockTimeout } from './session'
import { brokerCall, publicAccounts, syncCall } from './broker'
import { deviceCredential, deviceInfo } from './device'
import { checkOwnPassword } from './users'
import { ask } from './signin'
import { shellPrefsFrom } from '../src/lib/shellPrefs'
import { launcherApps, loadSession, resolveLink } from './webapps'
import { createSearch, localRecentHits, parseXbel } from './search'
import { createWidgets } from './widgets'
import { DESKTOP_MODULES, execProgram, findFrameFlow, findOffice, findPos, findWorkSuiteDesktop, installedApps, OFFICE_NEW } from './xdg'
import { APP_WINDOW } from './windowDefaults'
import { powerArgs } from './sessionHost'
import { externalAllowed, loadGrants, permissionAllowed } from './webSecurity'
import { xdgDirs } from './xdgDirs'
import { appIcons, parseJson, handle, run, markSessionVeil } from './shellCore'

// Shell IPC: lock screen, power, launcher and WorkSuite apps, search, widgets, cloud accounts and sync (from main.ts).

export function registerSessionIpc(webGrants: ReturnType<typeof loadGrants>) {
  // Sign-in is greetd/PAM's; the shell only re-checks the signed-in user's own password to unlock its lock screen.
  handle('ws:authenticate', async (user, secret, method) => {
    if (method === 'pin') {
      const r = await ask({ op: 'verify', user: os.userInfo().username, pin: secret })
      // #56: after too many wrong PINs the daemon answers "locked"; say so instead of "incorrect PIN" forever.
      return r.ok ? { ok: true } : { ok: false, reason: r.error === 'locked' ? 'pin_locked' : r.error === 'unavailable' ? 'unavailable' : 'wrong' }
    }
    if (method === 'key') return { ok: false, message: 'Use your password.' }
    return checkOwnPassword(user, secret)
  })
  // true = the system locker (swayidle → worksuite-lock → gtklock) has the screen; the shell then shows no lock board.
  handle('ws:lock', async () => {
    await brokerCall('Lock')
    return new Promise<boolean>((resolve) => execFile('loginctl', ['lock-session'], (err) => resolve(!err)))
  })
  handle('ws:logout', () => run(...logoutCommand()))
  handle('ws:power', (action) => {
    const args = powerArgs(String(action), false)
    return args ? run('systemctl', args) : undefined
  })
  // WorkSuite web apps: one window and one persistent session partition per app (WSOS-SEC-004).
  const apps = appWindows({
    session: (p) => session.fromPartition(p),
    window: ({ partition, title }) => new BrowserWindow({ ...APP_WINDOW, title, backgroundColor: '#0f172a', webPreferences: appWebPreferences(partition) }),
    openExternal: (u) => { if (externalAllowed(u)) void shell.openExternal(u) },
    permission: (perm, url) => permissionAllowed(webGrants, url, perm),
  })
  handle('ws:openWorkSuiteApp', (id, url) => apps.open(id, url))
  handle('ws:launchApp', (id) => { const c = appLaunchCommand(id); return c ? run(...c) : undefined })
  // Settings: idle lock timeout within the policy maximum (WSOS-LOCK-003).
  const lock = lockPaths(app.getPath('home'))
  handle('ws:lockSettings', () => readLockSettings(lock))
  handle('ws:setLockTimeout', (s) => writeLockTimeout(lock, Number(s)))
  // Launcher data: the org's WorkSuite web apps (no token leaves the main process) and installed XDG apps.
  handle('ws:webApps', async () => {
    // Cached per account in the user's cache dir so the launcher keeps the org's list offline (WSOS-DSK-001).
    const file = path.join(app.getPath('home'), '.cache', 'worksuite', 'launcher-apps.json')
    return launcherApps((m, p) => brokerCall(m, p ?? {}), (url, init) => fetch(url, { headers: init?.headers }), {
      read: () => (existsSync(file) ? readFileSync(file, 'utf8') : null),
      write: (text) => { mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 }); writeFileSync(file, text, { mode: 0o600 }) },
    })
  })
  // App icons (Icon= of desktop entries) as data: URLs, from icon directories only (electron/icons.ts).
  handle('ws:appIcons', (names, size, scale) => appIcons.resolve(parseJson(names), size, scale))
  handle('ws:installedApps', () => {
    const all = installedApps()
    const office = findOffice(all)
    const desktop = findWorkSuiteDesktop(all)
    const frameflow = findFrameFlow(all)
    const pos = findPos(all)
    // worksuite-* entries are the web app windows, listed from the org's data instead; the bundled native apps
    // (Office, FrameFlow, POS) stay and get their own WorkSuite tiles.
    const native = new Set([office, frameflow, pos].filter(Boolean))
    return {
      apps: all.filter((e) => !e.id.startsWith('worksuite-') || native.has(e)).map(({ exec: _e, ...e }) => e),
      office: office?.id ?? null, desktop: desktop?.id ?? null, frameflow: frameflow?.id ?? null, pos: pos?.id ?? null,
    }
  })
  // WorkSuite Desktop modules: its program with --module=<id> (fixed list, no shell), in its own app scope. A second
  // launch is handed to the running WorkSuite (single instance).
  handle('ws:launchWorkSuite', (module) => {
    if (!(DESKTOP_MODULES as readonly string[]).includes(module)) return undefined
    const desktop = findWorkSuiteDesktop(installedApps())
    const prog = desktop && execProgram(desktop.exec)
    const c = desktop && prog ? scopeCommand(desktop.id, [prog, `--module=${module}`]) : null
    return c ? run(...c) : undefined
  })
  // WorkSuite Office "new document" entries: the detected editor's program with its --new switch (no shell).
  handle('ws:launchOffice', (kind) => {
    const office = findOffice(installedApps())
    if (!office) return undefined
    const prog = execProgram(office.exec)
    // Own app scope either way, like every app launch (WSOS-SES-004).
    const c = kind in OFFICE_NEW && prog ? scopeCommand(office.id, [prog, OFFICE_NEW[kind]]) : appLaunchCommand(office.id)
    return c ? run(...c) : undefined
  })
  // Launcher global search (WSOS-LCH, DSK-010): the token is attached here; the renderer only gets results.
  const brokerFn = (m: string, p?: Record<string, unknown>) => brokerCall(m, p ?? {})
  const searcher = createSearch({ broker: brokerFn, device: () => deviceCredential(), fetch: (url, init) => fetch(url, { headers: init.headers, signal: init.signal }) })
  handle('ws:search', (q, types) => searcher.search(q, types ? types.split(',').filter(Boolean) : []))
  // Desktop widgets (WorkSuite Desktop's Home on the wallpaper): the same token path as search; the renderer gets
  // parsed data only. Cached per account (hashed id) under ~/.cache/worksuite/widgets for offline use; policy
  // desktop_widgets: false, or a kiosk device, turns them off here too, so no request is made.
  const widgetDir = path.join(app.getPath('home'), '.cache', 'worksuite', 'widgets')
  const widgetFile = (id: string) => path.join(widgetDir, `${createHash('sha256').update(id).digest('hex').slice(0, 32)}.json`)
  const widgets = createWidgets({
    broker: brokerFn, device: () => deviceCredential(), fetch: (url, init) => fetch(url, { headers: init.headers, signal: init.signal }),
    enabled: () => { const p = deviceInfo().policies as { desktop_widgets?: boolean | null; kiosk?: boolean } | null; return p?.desktop_widgets !== false && p?.kiosk !== true },
    cache: {
      read: (id) => { try { return JSON.parse(readFileSync(widgetFile(id), 'utf8')) } catch { return null } },
      write: (id, snap) => { try { mkdirSync(widgetDir, { recursive: true, mode: 0o700 }); writeFileSync(widgetFile(id), JSON.stringify(snap), { mode: 0o600 }) } catch { /* a convenience */ } },
      clear: () => { try { rmSync(widgetDir, { recursive: true, force: true }) } catch { /* nothing cached */ } },
    },
  })
  handle('ws:widgets', () => widgets.load())
  handle('ws:recentFiles', async () => {
    const home = app.getPath('home')
    let local: ReturnType<typeof localRecentHits> = []
    try {
      const xbel = path.join(xdgDirs(home).data, 'recently-used.xbel')
      local = localRecentHits(parseXbel(readFileSync(xbel, 'utf8')).filter((r) => existsSync(r.path)), home)
    } catch { /* no history yet */ }
    const cloud = await searcher.recent().catch(() => ({ state: 'offline' as const, hits: [] }))
    return { local, cloud }
  })
  // Opens a result: file:// with the default app (or its folder), worksuite:// in WorkSuite Desktop when installed,
  // else in the module's app window via links/resolve.
  handle('ws:openSearchResult', async (link, where) => {
    const u = new URL(link)
    if (u.protocol === 'file:') {
      const p = decodeURIComponent(u.pathname)
      if (!existsSync(p)) return { ok: false, error: 'not_found' }
      if (where === 'location') shell.showItemInFolder(p); else await shell.openPath(p)
      return { ok: true }
    }
    if (u.protocol !== 'worksuite:') return { ok: false, error: 'invalid_argument' }
    const desktop = findWorkSuiteDesktop(installedApps())
    const prog = desktop && execProgram(desktop.exec)
    const c = desktop && prog ? scopeCommand(desktop.id, [prog, u.toString()]) : null
    if (c) { await run(...c); return { ok: true } }
    const s = await loadSession(brokerFn, (url, init) => fetch(url, { headers: init?.headers }))
    if (!s.ok) return s
    // "Search in WorkSuite" without WorkSuite Desktop: the web app's own search page.
    if (u.hostname === 'search') return apps.open('search', new URL(`search?q=${encodeURIComponent(u.searchParams.get('q') ?? '')}`, s.value.account.server_url.replace(/\/?$/, '/')).toString())
    const web = await resolveLink(s.value, u.toString(), (url, init) => fetch(url, { headers: init?.headers }))
    return web ? apps.open(u.hostname, web) : { ok: false, error: 'not_found' }
  })
  handle('ws:openLink', (url) => {
    if (!externalAllowed(url)) throw new Error('Scheme not allowed')
    return shell.openExternal(new URL(url).toString())
  })
  // Sign-in waits for the user in the browser; the broker gives up after 5 minutes.
  handle('ws:cloudSignIn', async (serverUrl, mode) => {
    if (mode !== 'personal' && mode !== 'enterprise') return { ok: false, error: 'invalid_argument' }
    let https = false
    try { https = new URL(serverUrl).protocol === 'https:' } catch { /* invalid URL */ }
    if (!https) return { ok: false, error: 'insecure_url' }
    const r = await brokerCall('SignIn', { server_url: serverUrl, mode }, 6 * 60_000)
    return r.ok ? { ok: true, value: publicAccounts([r.value])[0] } : r
  })
  // #55: before the browser opens, check the address answers as a WorkSuite server over trusted https.
  handle('ws:cloudCheckServer', async (serverUrl) => {
    let https = false
    try { https = new URL(serverUrl).protocol === 'https:' } catch { return { ok: false, error: 'invalid_url' } }
    if (!https) return { ok: false, error: 'insecure_url' }
    return brokerCall('CheckServer', { server_url: serverUrl }, 40_000)
  })
  // "Cancel" or "Try again" while the browser is open: the broker ends the waiting sign-in (sign_in_cancelled).
  handle('ws:cloudSignInCancel', () => brokerCall('CancelSignIn'))
  // WSOS-SYN-008: the renderer asks how many changes are unsent, the user chooses, then sign-out runs.
  handle('ws:cloudSignOut', async (accountId, choice) => {
    if (!['none', 'export', 'discard'].includes(choice)) return { ok: false, error: 'invalid_argument' }
    let exported: string | null = null
    if (choice === 'export') {
      const r = await syncCall('ExportUnsent', { account_id: accountId })
      if (!r.ok) return r
      exported = String(r.value)
    }
    // Remove this account's local WorkSuite data in every case; no sync service running means there is none.
    const f = await syncCall('Forget', { account_id: accountId })
    if (!f.ok && f.error !== 'broker_unavailable') return f
    const r = await brokerCall('SignOut', { account_id: accountId })
    return r.ok ? { ok: true, value: { exported } } : r
  })
  handle('ws:syncUnsent', async (accountId) => {
    const r = await syncCall('Unsent', { account_id: accountId })
    // No sync service running means nothing can be queued for this account.
    return r.ok ? { ok: true, value: Number(r.value) } : r.error === 'broker_unavailable' ? { ok: true, value: 0 } : r
  })
  handle('ws:syncNow', () => syncCall('SyncNow'))
  handle('ws:syncStatus', () => syncCall('Status'))
  // Shell ENH-01 preferences (favourites, taskbar pins, order): the user's synced 'preferences/shell' object.
  handle('ws:shellPrefs', () => syncCall('GetPreference', { object_id: 'shell' }))
  // The preferences come as JSON text (handle() passes strings only).
  handle('ws:setShellPrefs', (prefs) => syncCall('SetPreference', { object_id: 'shell', data: shellPrefsFrom(parseJson(prefs)) }))
  // WSOS-SYN-004: rejected changes are shown against their record; retry only when the user asks.
  handle('ws:syncFailed', () => syncCall('ListFailed'))
  handle('ws:syncRetry', (mutationId) => syncCall('RetryFailed', { mutation_id: mutationId }))
  handle('ws:deviceInfo', () => deviceInfo())
  handle('ws:firstFrame', () => { markSessionVeil(); return true })
  return { brokerFn }
}

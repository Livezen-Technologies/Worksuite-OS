import { app, BrowserWindow, screen, dialog, nativeImage } from 'electron'
import { execFile, spawn } from 'node:child_process'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { appLaunchCommand } from './session'
import { brokerCall, syncCall } from './broker'
import { deviceCredential, deviceInfo, STATUS_PATH } from './device'
import { loadSession } from './webapps'
import { installedApps } from './xdg'
import { AGENT_POLICY_PATH } from './system'
import { locate } from './archives'
import { startPanel, type PanelHooks } from './panelHost'
import { startActivity } from './activityHost'
import { startSecurity } from './securityCenter'
import { captureHost, imageData, runBytes, screenshotFileName, screenshotsDir, wlCopyImage, type CaptureKind, type SnipMode } from './capture'
import { clipboardAllowed } from './clipboard'
import { applyShortcuts } from './shortcutsHost'
import { applyWindowTheme } from './windowTheme'
import { ACTIVATED_FLAG, FULLSCREEN_FLAG } from './panel'
import { arrange, displayManager, outputRects, type DisplayState } from './displays'
import type { Layout } from './displays'
import { realExec } from './system'
import { startDesktopHost } from './desktopHost'
import { startSessionHost } from './sessionHost'
import { bannerAllowed, toastHost, type ToastMsg } from './toastHost'
import { startMonitorHost } from './monitorHost'
import { startPeripheralsHost } from './peripherals'
import { startPrintersHost } from './printers'
import { startRemoteSupportHost } from './remoteSupport'
import { appPermissionsBridge, startAppPermissionsHost } from './appPermissions'
import { startTouchHost } from './touch'
import { startPointerHost } from './pointer'
import { startNotifications, windowForNotification } from './notifications'
import { startPolkitBridge } from './polkit'
import { xdgDirs } from './xdgDirs'
import { taskbarHost, taskbarTitle, writeTaskbarRules, type TaskbarRect } from './taskbar'
import type { FileEnv } from './files'
import { win, shellContents, broadcast, shellPrefs, monitors, settleShell, parseJson, ipcSender, handle, run } from './shellCore'

// The desktop around the shell window: displays, taskbar windows, panel bridge, capture, shortcuts, session overlay,
// peripherals, notifications and toasts, security and monitoring hosts (from main.ts).

export function startDesktopShell(files: FileEnv, brokerFn: (m: string, p?: Record<string, unknown>) => ReturnType<typeof brokerCall>) {
  // Settings › Display (WSOS-DSK-006): changes revert after 15 s unless kept; kept layouts are saved per monitor set
  // and re-applied at login and on hotplug, which also re-plans the per-monitor windows (DSK-005/007).
  const displays = displayManager({
    exec: realExec,
    storeFile: path.join(xdgDirs(app.getPath('home')).config, 'worksuite', 'displays.json'),
    spawn: (cmd, args) => { const p = spawn(cmd, args, { stdio: 'ignore' }); p.on('error', () => undefined); return { kill: () => p.kill() } },
    onChange: (st: DisplayState) => { layout = st.layout; broadcast('ws:displaysChanged', st); monitors.sync(outputRects(st.layout)); taskbarOutputs() },
    settle: (l) => settleShell(outputRects(l)),
  })
  // Chromium learns of a new scale or mode from wl_output on its own and may keep the old window size or drop
  // fullscreen: every metrics change re-places all shell windows, the main one included (#60).
  let refitTimer: ReturnType<typeof setTimeout> | null = null
  const refitSoon = () => { if (refitTimer) clearTimeout(refitTimer); refitTimer = setTimeout(() => { refitTimer = null; monitors.refit() }, 150) }
  screen.on('display-metrics-changed', refitSoon)
  screen.on('display-added', refitSoon)
  screen.on('display-removed', refitSoon)
  let layout: Layout | null = null
  void displays.state().then((r) => { if (r.ok && !layout) { layout = r.value.layout; taskbarOutputs() } })

  // #53: the taskbar's own always-on-top window per output (electron/taskbar.ts). Each mirrors the taskbar of the shell
  // window on that output (its "owner": the main window for the primary output, ''), which keeps every state.
  const userRc = path.join(xdgDirs(app.getPath('home')).config, 'worksuite', 'labwc', 'rc.xml')
  const taskbarWins = new Map<string, BrowserWindow>()         // output → taskbar window
  const taskbarOwners = new Map<string, Electron.WebContents>() // output ('' = primary) → shell window it mirrors
  let primaryOutput = ''
  const taskbars = taskbarHost({
    writeRules: async (block) => {
      try { writeTaskbarRules(userRc, '/etc/xdg/worksuite/labwc/rc.xml', block) } catch { return false }
      return new Promise<boolean>((resolve) => execFile('labwc', ['--reconfigure'], (err) => resolve(!err)))
    },
    settle: () => new Promise((r) => setTimeout(r, 150)),
    make: (r, b) => {
      const w = new BrowserWindow({ ...b, frame: false, transparent: true, backgroundColor: '#00000000', resizable: false, movable: false, minimizable: false,
        maximizable: false, fullscreenable: false, skipTaskbar: true, title: taskbarTitle(r.name), webPreferences: shellPrefs() })
      const wc = w.webContents
      shellContents.add(wc)
      taskbarWins.set(r.name, w)
      w.on('page-title-updated', (e) => e.preventDefault())   // Labwc's rules match this title
      w.on('closed', () => { shellContents.delete(wc); if (taskbarWins.get(r.name) === w) taskbarWins.delete(r.name) })
      wc.on('will-navigate', (e) => e.preventDefault())
      wc.setWindowOpenHandler(() => ({ action: 'deny' }))
      void w.loadFile(path.join(__dirname, '../dist/index.html'), { query: { mode: 'taskbar', output: r.name } })
      return w
    },
    refocus: (h) => { setTimeout(() => void panelClient?.activate(h), 150) },
  })
  function taskbarOutputs() {
    let rects: TaskbarRect[] = layout ? outputRects(layout) : []
    if (layout) primaryOutput = layout.primary
    if (!rects.length) {
      // No layout from wlr-randr yet: the primary display as Electron sees it.
      const d = screen.getPrimaryDisplay().bounds
      rects = [{ name: primaryOutput || 'primary', x: d.x, y: d.y, width: d.width, height: d.height }]
      primaryOutput = rects[0].name
    }
    void taskbars.setOutputs(rects)
  }
  const ownerOf = (output: string) => taskbarOwners.get(output === primaryOutput ? '' : output) ?? (output === primaryOutput ? win?.webContents : undefined)
  // The owner's taskbar markup and root attributes (touch mode, theme) for the taskbar window of its output.
  handle('ws:taskbarPublish', (output, html, attrs) => {
    if (!ipcSender || html.length > 2_000_000) return false
    taskbarOwners.set(output, ipcSender)
    const tw = taskbarWins.get(output || primaryOutput)
    if (tw && !tw.isDestroyed()) tw.webContents.send('ws:taskbarHtml', { html, attrs: parseJson(attrs) })
    return true
  })
  // A taskbar window loaded (or reloaded): its owner sends its taskbar again.
  handle('ws:taskbarHello', () => {
    const name = [...taskbarWins].find(([, w]) => w.webContents === ipcSender)?.[0]
    if (name) ownerOf(name)?.send('ws:taskbarRepublish', null)
    return !!name
  })
  // A click (or right-click, wheel) in a taskbar window: the owner performs it on its own taskbar.
  handle('ws:taskbarEvent', (json) => {
    const name = [...taskbarWins].find(([, w]) => w.webContents === ipcSender)?.[0]
    const ev = parseJson(json)
    if (!name || !ev || typeof ev !== 'object') return false
    ownerOf(name)?.send('ws:taskbarEvent', ev)
    return true
  })
  // The desktop is showing (signed in, not ending the session): the taskbar windows exist only then.
  handle('ws:taskbarWanted', (on) => { void taskbars.setWanted(on === '1'); return true })
  app.on('before-quit', () => taskbars.stop())
  // A thrown error would reach the renderer as a bare IPC rejection ("Unexpected error", #60): answer with a code.
  const safe = <T>(p: Promise<T>) => p.catch((e: unknown) => { console.error('display:', e); return { ok: false, error: 'internal' } })
  handle('ws:displayState', () => safe(displays.state()))
  handle('ws:displayApply', (json) => {
    try { const p = JSON.parse(json); return safe(displays.apply(arrange(p.layout, p.sides ?? {}))) } catch { return { ok: false, error: 'bad_layout' } }
  })
  handle('ws:displayKeep', () => safe(displays.confirm()))
  handle('ws:displayRevert', () => safe(displays.revert()))
  handle('ws:displayWallpaper', (output, id) => displays.setWallpaper(output, id))
  void displays.applySaved()
  // Taskbar windows, tray and the Super key (lk.worksuite.Shell1) through the Wayland bridge.
  const hooks: PanelHooks = {}
  const panelClient = startPanel(handle, broadcast, () => void displays.applySaved(), (full) => {
    // An archive opened from elsewhere (worksuite-open-archive, the default handler): browse it in Files.
    const at = locate(files, full)
    if (at) { broadcast('ws:openArchive', at); win?.show(); win?.focus() }
  }, hooks)
  const home = app.getPath('home')
  const policies = () => deviceInfo().policies as { screen_capture?: string | null; clipboard_history?: string | null; kiosk?: boolean } | null
  // The app window with the focus (not the shell's): where Super+V pastes, and whose copies the deny list checks.
  const focusedWindow = () => panelClient?.windows.find((w) => w.flags & ACTIVATED_FLAG && !['worksuite-shell', 'worksuite', 'electron'].includes(w.appId.toLowerCase())) ?? null
  // Default apps, clipboard history, problem report (WSOS-DSK-008/009, SES-005).
  startDesktopHost(handle, broadcast, home, app.getVersion(), {
    focusedApp: () => focusedWindow()?.appId ?? null,
    allowed: () => clipboardAllowed(policies()),
    preview: (data) => { try { const img = nativeImage.createFromBuffer(data); if (img.isEmpty()) return null; const s = img.getSize(); return (s.width > 360 || s.height > 240 ? img.resize(s.width / 360 > s.height / 240 ? { width: 360 } : { height: 240 }) : img).toDataURL() } catch { return null } },
    activate: (h) => panelClient?.activate(h) ?? Promise.resolve(),
  })
  // Screenshots and the snipping tool (electron/capture.ts): Shell1.Capture from the Print/Super+Shift+S bindings.
  const capture = captureHost({
    run: runBytes, copy: (png) => wlCopyImage(png), policies, broadcast,
    outputs: () => (layout ? outputRects(layout).map(({ name, x, y, width, height }) => ({ name, x, y, width, height })) : []),
    lift: (on) => hooks.lift?.('snip', on),
    dir: () => screenshotsDir(process.env, home),
    settingsFile: path.join(xdgDirs(home).config, 'worksuite', 'capture.json'),
  })
  hooks.capture = (k) => void capture.request(k as CaptureKind)
  // Open(what) from the key bindings: shell surfaces, or an app (custom shortcuts, Ctrl+Alt+T) in its own scope.
  // Super+V, Super+. and Super+/ show over a capture of the screen, so they look like they float over the app.
  hooks.open = (what) => void (async () => {
    if (what.startsWith('app:')) { const c = appLaunchCommand(what.slice(4)); if (c) await run(...c); return }
    const previous = focusedWindow()?.handle ?? ''
    let backdrop: string | null = null
    if (['clipboard', 'emoji', 'shortcuts'].includes(what) && capture.allowed()) {
      const primary = layout?.primary
      const jpg = await runBytes('grim', [...(primary && /^[A-Za-z0-9._-]{1,64}$/.test(primary) ? ['-o', primary] : []), '-t', 'jpeg', '-q', '80', '-'])
      if (jpg) backdrop = `data:image/jpeg;base64,${jpg.toString('base64')}`
    }
    broadcast('ws:shellOpen', { what, previous, backdrop })
  })()
  handle('ws:captureAllowed', () => capture.allowed())
  handle('ws:captureSettings', () => capture.settings())
  handle('ws:captureSetSettings', (json) => capture.setSettings((parseJson(json) ?? {}) as object))
  handle('ws:capture', (kind) => (['print', 'save', 'window', 'snip'].includes(kind) ? capture.request(kind as CaptureKind) : false))
  handle('ws:snipStart', (mode, delay) => capture.start(mode as SnipMode, Number(delay) || 0))
  handle('ws:snipFrame', (id, output) => capture.frame(Number(id), output))
  handle('ws:snipDone', (id, dataUrl) => capture.done(Number(id), dataUrl))
  handle('ws:snipCancel', (id) => capture.cancel(Number(id)))
  handle('ws:snipImage', (id) => capture.image(Number(id) || 0))
  handle('ws:snipCopy', (dataUrl) => capture.copyImage(dataUrl))
  // Save as: the person picks the place (default Pictures/Screenshots) and PNG or JPEG; nothing is written elsewhere.
  handle('ws:snipSave', async (dataUrl) => {
    const img = imageData(dataUrl)
    if (!img || !win) return { ok: false, error: 'invalid_argument' }
    const dir = screenshotsDir(process.env, home)
    try { mkdirSync(dir, { recursive: true }) } catch { /* the dialog still opens */ }
    const d = await dialog.showSaveDialog(win, { defaultPath: path.join(dir, screenshotFileName(new Date(), img.ext)), filters: [img.ext === 'png' ? { name: 'PNG', extensions: ['png'] } : { name: 'JPEG', extensions: ['jpg', 'jpeg'] }] })
    if (d.canceled || !d.filePath) return { ok: false, error: 'cancelled' }
    try { writeFileSync(d.filePath, img.data, { mode: 0o644 }) } catch { return { ok: false, error: 'failed' } }
    return { ok: true, value: d.filePath }
  })
  // "Show in Files": the saved file's folder in the shell's own Files, when it is in the home folder.
  handle('ws:snipReveal', (file) => {
    const rel = path.relative(home, path.dirname(path.resolve(file)))
    return rel.startsWith('..') || path.isAbsolute(rel) ? null : { root: 'home', rel, name: path.basename(file) }
  })
  // Settings › Keyboard › Shortcuts: the user's block in their Labwc rc.xml; also applied at start from the synced
  // preferences, so shortcuts follow the person to another computer.
  const shortcutFiles = { userRc: path.join(xdgDirs(home).config, 'worksuite', 'labwc', 'rc.xml'), systemRc: '/etc/xdg/worksuite/labwc/rc.xml' }
  handle('ws:shortcutsApply', (json) => applyShortcuts(parseJson(json), shortcutFiles, realExec))
  // Settings › Appearance: the Labwc title bar theme (light or dark) in the same file.
  handle('ws:windowTheme', (dark) => applyWindowTheme(dark === 'dark', shortcutFiles, realExec))
  setTimeout(() => void syncCall('GetPreference', { object_id: 'shell' }).then((r) => {
    const sc = r.ok ? (r.value as { shortcuts?: unknown } | null)?.shortcuts : undefined
    if (sc) void applyShortcuts(sc, shortcutFiles, realExec)
  }).catch(() => undefined), 3000).unref?.()
  // Edit commands for the shell's own text fields (right-click menu): the focused field of the asking window.
  handle('ws:edit', (cmd) => {
    const wc = ipcSender
    if (!wc) return false
    const fn = ({ cut: () => wc.cut(), copy: () => wc.copy(), paste: () => wc.paste(), selectAll: () => wc.selectAll(), undo: () => wc.undo(), redo: () => wc.redo() } as Record<string, () => void>)[String(cmd)]
    fn?.()
    return !!fn
  })
  // Shutdown/restart/sign-out overlay on every display, inhibitors, crashed apps, administrators' diagnostics.
  startSessionHost(handle, broadcast, {
    apps: () => installedApps(), user: os.userInfo().username, readGroup: () => readFileSync('/etc/group', 'utf8'),
    launch: (id) => { const c = appLaunchCommand(id); return c ? run(...c) : undefined },
  })
  // System monitor (G11) and quick settings brightness / power mode (G01).
  startMonitorHost(handle)
  // Bluetooth pairing, removable storage, power profiles, printers, input methods (WSOS-INT-003…006, 011).
  startPeripheralsHost(handle, app.getPath('home'))
  // Settings › Printers: state, default, preferences, pause, test page, held jobs (issue #51).
  startPrintersHost(handle)
  startRemoteSupportHost(handle, undefined, {
    exec: realExec, credential: () => deviceCredential(),
    serverBase: () => { try { const h = JSON.parse(readFileSync(STATUS_PATH, 'utf8'))?.server; return typeof h === 'string' && /^[A-Za-z0-9.:[\]-]+$/.test(h) ? `https://${h}/` : null } catch { return null } },
  })
  startAppPermissionsHost(handle, appPermissionsBridge({
    exec: realExec,
    readPolicy: () => { try { return readFileSync(AGENT_POLICY_PATH, 'utf8') } catch { return null } },
    stateDir: path.join(app.getPath('home'), '.local/state/worksuite/permissions'),
  }))
  // #53: the bridge reserves the taskbar's height (52 px, touch mode 64 px) at the bottom of every output.
  startTouchHost(handle, broadcast, app.getPath('home'), undefined, (h) => { void taskbars.setHeight(h); return panelClient?.setPanelHeight(h) })
  // Settings › Mouse & touchpad (#35): Labwc libinput block, applied live with labwc --reconfigure.
  startPointerHost(handle, app.getPath('home'))
  // The shell is the session's org.freedesktop.Notifications server (WSOS-INT-007).
  // Clicking one (its "default" action) also raises the sender's window through the bridge, whatever the app does.
  const notices = startNotifications(handle, broadcast, (n) => {
    if (n.app === DRIVERS_APP) { broadcast('ws:openSettings', 'Drivers'); return }
    const w = panelClient && windowForNotification(n, panelClient.windows, installedApps())
    if (w) void panelClient.activate(w.handle)
  })
  // Toasts over the apps (worksuite-toasts, a layer-shell overlay surface): the renderer hands its toast here when the
  // helper runs. Clicking an app notification's toast takes its default action, which focuses the sender's window.
  const toasts = toastHost((key) => {
    const m = /^app-(\d+)$/.exec(key)
    if (m) notices.invoke(Number(m[1]), 'default')
    else broadcast('ws:toastClicked', key)
  })
  handle('ws:toastsAvailable', () => toasts.available())
  // Fn keys (worksuite-hotkey, #62): the level indicator over the apps, or in the shell's window without the helper.
  hooks.osd = (o) => { if (!toasts.osd(o)) broadcast('ws:osd', o) }
  handle('ws:toastShow', (json) => {
    try {
      const t = JSON.parse(json) as ToastMsg
      // Held back under a full-screen window: true, so the renderer does not draw it itself (it stays in the centre).
      if (!bannerAllowed(panelClient?.windows ?? [], ACTIVATED_FLAG, FULLSCREEN_FLAG)) return true
      return toasts.show({ ...t, key: String(t.key) })
    } catch { return false }
  })
  // A notification closed by its app (or from the notification centre) takes its toast away too.
  let liveIds = new Set<number>()
  notices.onChange((list) => {
    const now = new Set(list.map((n) => n.id))
    for (const id of liveIds) if (!now.has(id)) toasts.hide(`app-${id}`)
    liveIds = now
  })
  app.on('before-quit', () => toasts.stop())
  // Files' "Notify me when done" (FO1): a notice in the shell's own notification centre, text only.
  // "Drivers available for your Wi-Fi card": the renderer words it (en/si/ta); clicking opens Settings › Drivers.
  handle('ws:driversNotify', (summary, body) => {
    return notices.notify(DRIVERS_APP, 0, String(summary).slice(0, 200), String(body).slice(0, 400), ['default', ''], 1)
  })
  handle('ws:filesNotify', (summary, body) => notices.notify('Files', 0, String(summary).slice(0, 200), String(body).slice(0, 400), [], 1))
  // WorkSuite Security (#20): status, Scan now, and notices for threats, firewall alerts, protection off, isolation.
  startSecurity(handle, (n) => void notices.notify('WorkSuite Security', 0, n.title, n.body, [], n.kind === 'threat_detected' || n.kind === 'isolated' ? 2 : 1), broadcast)
  // Employee monitoring (#22): only when the signed policy turns it on; Settings and the taskbar indicator show it.
  const activity = startActivity(handle, {
    home, broadcast, device: () => deviceCredential(),
    session: async () => { const s = await loadSession(brokerFn, (url, init) => fetch(url, { headers: init?.headers }), () => deviceCredential()); return s.ok ? s.value : null },
    fetch: (url, init) => fetch(url, init as RequestInit),
  })
  hooks.windows = (w) => { activity.windows(w, ACTIVATED_FLAG); void taskbars.setWindows(w) }
  app.on('before-quit', () => activity.stop())
  // Administrator prompts from the WorkSuite polkit agent (G05, WSOS-INT-010).
  startPolkitBridge(handle, broadcast)
}

const DRIVERS_APP = 'WorkSuite Drivers'

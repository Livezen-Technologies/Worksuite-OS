import { contextBridge, ipcRenderer, webUtils } from 'electron'

// Named functions only; the renderer never sees ipcRenderer (WSOS-SEC-001, §10.3).
contextBridge.exposeInMainWorld('worksuite', {
  firstFrame: () => ipcRenderer.invoke('ws:firstFrame'),
  authenticate: (user: string, password: string, method?: string) => ipcRenderer.invoke('ws:authenticate', String(user), String(password), String(method ?? 'password')),
  lock: () => ipcRenderer.invoke('ws:lock'),
  logout: () => ipcRenderer.invoke('ws:logout'),
  power: (action: string) => ipcRenderer.invoke('ws:power', String(action)),
  launchApp: (appId: string) => ipcRenderer.invoke('ws:launchApp', String(appId)),
  openWorkSuiteApp: (appId: string, url: string) => ipcRenderer.invoke('ws:openWorkSuiteApp', String(appId), String(url)),
  lockSettings: () => ipcRenderer.invoke('ws:lockSettings'),
  setLockTimeout: (seconds: number) => ipcRenderer.invoke('ws:setLockTimeout', String(seconds)),
  webApps: () => ipcRenderer.invoke('ws:webApps'),
  shellPrefs: () => ipcRenderer.invoke('ws:shellPrefs'),
  setShellPrefs: (prefs: unknown) => ipcRenderer.invoke('ws:setShellPrefs', JSON.stringify(prefs ?? null)),
  installedApps: () => ipcRenderer.invoke('ws:installedApps'),
  appIcons: (names: string[], size: number, scale: number) => ipcRenderer.invoke('ws:appIcons', JSON.stringify(names), size, scale),
  launchOffice: (kind: string) => ipcRenderer.invoke('ws:launchOffice', String(kind)),
  launchWorkSuite: (module: string) => ipcRenderer.invoke('ws:launchWorkSuite', String(module)),
  search: (q: string, types?: string[]) => ipcRenderer.invoke('ws:search', String(q), (types ?? []).map(String).join(',')),
  recentFiles: () => ipcRenderer.invoke('ws:recentFiles'),
  widgets: () => ipcRenderer.invoke('ws:widgets'),
  openSearchResult: (link: string, where?: string) => ipcRenderer.invoke('ws:openSearchResult', String(link), where === 'location' ? 'location' : 'open'),
  openLink: (url: string) =>ipcRenderer.invoke('ws:openLink', String(url)),
  cloudSignIn: (serverUrl: string, mode: string) => ipcRenderer.invoke('ws:cloudSignIn', String(serverUrl), String(mode)),
  cloudSignOut: (accountId: string, choice: string) => ipcRenderer.invoke('ws:cloudSignOut', String(accountId), String(choice)),
  syncUnsent: (accountId: string) => ipcRenderer.invoke('ws:syncUnsent', String(accountId)),
  syncNow: () => ipcRenderer.invoke('ws:syncNow'),
  syncStatus: () => ipcRenderer.invoke('ws:syncStatus'),
  deviceInfo: () => ipcRenderer.invoke('ws:deviceInfo'),
  sysNetwork: () => ipcRenderer.invoke('ws:sysNetwork'),
  sysSetWifi: (on: boolean) => ipcRenderer.invoke('ws:sysSetWifi', on ? 'on' : 'off'),
  sysWifiConnect: (ssid: string, password: string) => ipcRenderer.invoke('ws:sysWifiConnect', String(ssid), String(password)),
  sysVpn: () => ipcRenderer.invoke('ws:sysVpn'),
  sysVpnImport: (handle: string) => ipcRenderer.invoke('ws:sysVpnImport', String(handle)),
  sysVpnImportOpenvpn: (handle: string) => ipcRenderer.invoke('ws:sysVpnImportOpenvpn', String(handle)),
  sysVpnConnect: (uuid: string, on: boolean, creds?: { username: string; password: string }) => creds
    ? ipcRenderer.invoke('ws:sysVpnConnect', String(uuid), on ? 'on' : 'off', String(creds.username), String(creds.password))
    : ipcRenderer.invoke('ws:sysVpnConnect', String(uuid), on ? 'on' : 'off'),
  sysVpnRemove: (uuid: string) => ipcRenderer.invoke('ws:sysVpnRemove', String(uuid)),
  sysBluetooth: () => ipcRenderer.invoke('ws:sysBluetooth'),
  sysSetBluetooth: (on: boolean) => ipcRenderer.invoke('ws:sysSetBluetooth', on ? 'on' : 'off'),
  sysBtConnect: (address: string, on: boolean) => ipcRenderer.invoke('ws:sysBtConnect', String(address), on ? 'on' : 'off'),
  sysWifiRescan: () => ipcRenderer.invoke('ws:sysWifiRescan'),
  sysWifiDisconnect: () => ipcRenderer.invoke('ws:sysWifiDisconnect'),
  radioDiagnose: (kind: string) => ipcRenderer.invoke('ws:radioDiagnose', String(kind)),
  radioFix: (kind: string, fix: string) => ipcRenderer.invoke('ws:radioFix', String(kind), String(fix)),
  graphics: () => ipcRenderer.invoke('ws:graphics'),
  graphicsSetRenderer: (choice: string) => ipcRenderer.invoke('ws:graphicsSetRenderer', String(choice)),
  graphicsReset: () => ipcRenderer.invoke('ws:graphicsReset'),
  sysSound: () => ipcRenderer.invoke('ws:sysSound'),
  sysSetVolume: (percent: number) => ipcRenderer.invoke('ws:sysSetVolume', String(Number(percent))),
  sysSetMute: (muted: boolean) => ipcRenderer.invoke('ws:sysSetMute', muted ? 'on' : 'off'),
  sysSetDefaultAudio: (id: number) => ipcRenderer.invoke('ws:sysSetDefaultAudio', String(Number(id))),
  sysBattery: () => ipcRenderer.invoke('ws:sysBattery'),
  sysPrinters: () => ipcRenderer.invoke('ws:sysPrinters'),
  sysDisplays: () => ipcRenderer.invoke('ws:sysDisplays'),
  displayState: () => ipcRenderer.invoke('ws:displayState'),
  displayApply: (layout: unknown, sides: unknown) => ipcRenderer.invoke('ws:displayApply', JSON.stringify({ layout, sides })),
  displayKeep: () => ipcRenderer.invoke('ws:displayKeep'),
  displayRevert: () => ipcRenderer.invoke('ws:displayRevert'),
  displayWallpaper: (output: string, id: string) => ipcRenderer.invoke('ws:displayWallpaper', String(output), String(id)),
  onDisplaysChanged: (cb: (s: unknown) => void) => {
    const listener = (_e: unknown, s: unknown) => cb(s)
    ipcRenderer.on('ws:displaysChanged', listener)
    return () => { ipcRenderer.removeListener('ws:displaysChanged', listener) }
  },
  sysDisks: () => ipcRenderer.invoke('ws:sysDisks'),
  enrollDevice: (serverUrl: string, code: string) => ipcRenderer.invoke('ws:enrollDevice', String(serverUrl), String(code)),
  pkgPreview: (catalogId: string, op: string) => ipcRenderer.invoke('ws:pkgPreview', String(catalogId), String(op)),
  pkgInstall: (catalogId: string) => ipcRenderer.invoke('ws:pkgInstall', String(catalogId)),
  pkgRemove: (catalogId: string) => ipcRenderer.invoke('ws:pkgRemove', String(catalogId)),
  pkgApplyUpdate: () => ipcRenderer.invoke('ws:pkgApplyUpdate'),
  pkgCheckUpdates: () => ipcRenderer.invoke('ws:pkgCheckUpdates'),
  updateStatus: (check: boolean) => ipcRenderer.invoke('ws:updateStatus', check ? 'check' : 'get'),
  updateDefer: () => ipcRenderer.invoke('ws:updateDefer'),
  updateInstallNow: () => ipcRenderer.invoke('ws:updateInstallNow'),
  onUpdateStatus: (cb: (s: unknown) => void) => {
    const listener = (_e: unknown, payload: unknown) => cb(payload)
    ipcRenderer.on('ws:updateStatusChanged', listener)
    return () => { ipcRenderer.removeListener('ws:updateStatusChanged', listener) }
  },
  filesRoots: () => ipcRenderer.invoke('ws:filesRoots'),
  filesList: (root: string, rel: string) => ipcRenderer.invoke('ws:filesList', String(root), String(rel)),
  filesOpen: (root: string, rel: string) => ipcRenderer.invoke('ws:filesOpen', String(root), String(rel)),
  filesStatus: (root: string) => ipcRenderer.invoke('ws:filesStatus', String(root)),
  filesPlaces: () => ipcRenderer.invoke('ws:filesPlaces'),
  filesStarred: () => ipcRenderer.invoke('ws:filesStarred'),
  filesStar: (root: string, rel: string, on: boolean) => ipcRenderer.invoke('ws:filesStar', String(root), String(rel), on ? '1' : '0'),
  filesRecent: () => ipcRenderer.invoke('ws:filesRecent'),
  filesSearch: (root: string, rel: string, q: string, kind: string, days: number) => ipcRenderer.invoke('ws:filesSearch', String(root), String(rel), String(q), String(kind), String(days)),
  filesMkdir: (root: string, rel: string, name: string) => ipcRenderer.invoke('ws:filesMkdir', String(root), String(rel), String(name)),
  filesRename: (root: string, rel: string, name: string) => ipcRenderer.invoke('ws:filesRename', String(root), String(rel), String(name)),
  filesTrash: (root: string, rels: string[]) => ipcRenderer.invoke('ws:filesTrash', String(root), JSON.stringify(rels.map(String))),
  filesDelete: (root: string, rels: string[]) => ipcRenderer.invoke('ws:filesDelete', String(root), JSON.stringify(rels.map(String))),
  filesNotify: (summary: string, body: string) => ipcRenderer.invoke('ws:filesNotify', String(summary), String(body)),
  toastsAvailable: () => ipcRenderer.invoke('ws:toastsAvailable'),
  toastShow: (t: unknown) => ipcRenderer.invoke('ws:toastShow', JSON.stringify(t ?? null)),
  filesTrashList: () => ipcRenderer.invoke('ws:filesTrashList'),
  filesTrashRestore: (ids: string[]) => ipcRenderer.invoke('ws:filesTrashRestore', JSON.stringify(ids.map(String))),
  filesTrashDelete: (ids: string[] | 'all') => ipcRenderer.invoke('ws:filesTrashDelete', ids === 'all' ? 'all' : JSON.stringify(ids.map(String))),
  filesDrop: (paths: string[], dstRoot: string, dstRel: string) => ipcRenderer.invoke('ws:filesDrop', JSON.stringify(paths.map(String)), String(dstRoot), String(dstRel)),
  filesStartDrag: (root: string, rels: string[]) => ipcRenderer.invoke('ws:filesStartDrag', String(root), JSON.stringify(rels.map(String))),
  // A dropped File's path on disk (Electron 32+: File.path is gone); '' for data that isn't a file.
  pathForFile: (f: File) => { try { return webUtils.getPathForFile(f) } catch { return '' } },
  filesPaste: (op: string, srcRoot: string, rels: string[], dstRoot: string, dstRel: string) => ipcRenderer.invoke('ws:filesPaste', String(op), String(srcRoot), JSON.stringify(rels.map(String)), String(dstRoot), String(dstRel)),
  filesResolve: (id: string, r: string, all: boolean) => ipcRenderer.invoke('ws:filesResolve', String(id), String(r), all ? '1' : '0'),
  filesCompress: (root: string, rels: string[], opts: { format: string; name: string; level: number; password?: string | null }) =>
    ipcRenderer.invoke('ws:filesCompress', String(root), JSON.stringify(rels.map(String)), JSON.stringify({ format: String(opts.format), name: String(opts.name), level: Number(opts.level) || 0, password: opts.password ? String(opts.password) : null })),
  filesExtract: (root: string, rel: string, mode: string, items: string[], password: string | null) => ipcRenderer.invoke('ws:filesExtract', String(root), String(rel), String(mode), JSON.stringify(items.map(String)), password ? String(password) : ''),
  filesArchivePassword: (id: string, pw: string | null) => ipcRenderer.invoke('ws:filesArchivePassword', String(id), pw ?? '', pw === null ? '1' : '0'),
  filesArchiveList: (root: string, rel: string, password: string | null) => ipcRenderer.invoke('ws:filesArchiveList', String(root), String(rel), password ? String(password) : ''),
  filesEject: (id: string) => ipcRenderer.invoke('ws:filesEject', String(id)),
  onOpenArchive: (cb: (e: unknown) => void) => {
    const listener = (_e: unknown, payload: unknown) => cb(payload)
    ipcRenderer.on('ws:openArchive', listener)
    return () => { ipcRenderer.removeListener('ws:openArchive', listener) }
  },
  onFilesJob: (cb: (e: unknown) => void) => {
    const listener = (_e: unknown, payload: unknown) => cb(payload)
    ipcRenderer.on('ws:filesJob', listener)
    return () => { ipcRenderer.removeListener('ws:filesJob', listener) }
  },
  // Only the event payload reaches the renderer, never the IPC event object.
  onPkgJob: (cb: (e: unknown) => void) => {
    const listener = (_e: unknown, payload: unknown) => cb(payload)
    ipcRenderer.on('ws:pkgJob', listener)
    return () => { ipcRenderer.removeListener('ws:pkgJob', listener) }
  },
  hwDevices: () => ipcRenderer.invoke('ws:hwDevices'),
  hwDriverReport: (check?: boolean) => ipcRenderer.invoke('ws:hwDriverReport', check ? 'check' : ''),
  hwMokPassword: () => ipcRenderer.invoke('ws:hwMokPassword'),
  driversNotify: (summary: string, body: string) => ipcRenderer.invoke('ws:driversNotify', String(summary), String(body)),
  onDriversChanged: (cb: (r: unknown) => void) => {
    const listener = (_e: unknown, r: unknown) => cb(r)
    ipcRenderer.on('ws:driversChanged', listener)
    return () => { ipcRenderer.removeListener('ws:driversChanged', listener) }
  },
  onOpenSettings: (cb: (section: string) => void) => {
    const listener = (_e: unknown, s: unknown) => cb(String(s))
    ipcRenderer.on('ws:openSettings', listener)
    return () => { ipcRenderer.removeListener('ws:openSettings', listener) }
  },
  hwInstallDrivers: (ids: string[]) => ipcRenderer.invoke('ws:hwInstallDrivers', ...(Array.isArray(ids) ? ids.map(String) : [])),
  sysUsers: () => ipcRenderer.invoke('ws:sysUsers'),
  signinMethods: () => ipcRenderer.invoke('ws:signinMethods'),
  signinPinSet: (pin: string) => ipcRenderer.invoke('ws:signinPinSet', String(pin)),
  signinPinRemove: () => ipcRenderer.invoke('ws:signinPinRemove'),
  signinKeyAdd: (name: string) => ipcRenderer.invoke('ws:signinKeyAdd', String(name)),
  signinKeyRemove: (id: string) => ipcRenderer.invoke('ws:signinKeyRemove', String(id)),
  signinSetDefault: (method: string) => ipcRenderer.invoke('ws:signinSetDefault', String(method)),
  cloudAccounts: () => ipcRenderer.invoke('ws:cloudAccounts'),
  pkgRepair: () => ipcRenderer.invoke('ws:pkgRepair'),
  pkgState: () => ipcRenderer.invoke('ws:pkgState'),
  reportCollect: () => ipcRenderer.invoke('ws:reportCollect'),
  reportSave: (id: string, keep: string[], description: string) => ipcRenderer.invoke('ws:reportSave', String(id), keep.map(String).join(','), String(description)),
  reportSend: (id: string, keep: string[], description: string) => ipcRenderer.invoke('ws:reportSend', String(id), keep.map(String).join(','), String(description)),
  pkgCatalog: () => ipcRenderer.invoke('ws:pkgCatalog'),
  pickFile: (kind: string) => ipcRenderer.invoke('ws:pickFile', String(kind)),
  localDebPreview: (handle: string) => ipcRenderer.invoke('ws:localDebPreview', String(handle)),
  localDebInstall: (token: string) => ipcRenderer.invoke('ws:localDebInstall', String(token)),
  appPermissions: (catalogId: string) => ipcRenderer.invoke('ws:appPermissions', String(catalogId)),
  appPermissionsReset: (catalogId: string) => ipcRenderer.invoke('ws:appPermissionsReset', String(catalogId)),
  appPermsUserOff: (catalogId: string) => ipcRenderer.invoke('ws:appPermsUserOff', String(catalogId)),
  appPermSet: (catalogId: string, perm: string, on: boolean) => ipcRenderer.invoke('ws:appPermSet', String(catalogId), String(perm), on ? 'on' : 'off'),
  appDataRemove: (catalogId: string) => ipcRenderer.invoke('ws:appDataRemove', String(catalogId)),
  pruneRuntimes: () => ipcRenderer.invoke('ws:pruneRuntimes'),
  bundleInspect: (handle: string) => ipcRenderer.invoke('ws:bundleInspect', String(handle)),
  bundleInstall: (handle: string) => ipcRenderer.invoke('ws:bundleInstall', String(handle)),
  findBundles: () => ipcRenderer.invoke('ws:findBundles'),
  appimageList: () => ipcRenderer.invoke('ws:appimageList'),
  appimageImport: (handle: string) => ipcRenderer.invoke('ws:appimageImport', String(handle)),
  appimageApprove: (id: string) => ipcRenderer.invoke('ws:appimageApprove', String(id)),
  appimageRemove: (id: string) => ipcRenderer.invoke('ws:appimageRemove', String(id)),
  appimageUpdate: (id: string, handle: string) => ipcRenderer.invoke('ws:appimageUpdate', String(id), String(handle)),
  appimageLaunch: (id: string) => ipcRenderer.invoke('ws:appimageLaunch', String(id)),
  recoveryInfo: () => ipcRenderer.invoke('ws:recoveryInfo'),
  recoveryCheck: (id: string) => ipcRenderer.invoke('ws:recoveryCheck', String(id)),
  recoveryUnlock: (device: string, secret: string) => ipcRenderer.invoke('ws:recoveryUnlock', String(device), String(secret)),
  recoverySnapshots: () => ipcRenderer.invoke('ws:recoverySnapshots'),
  recoveryRestore: (id: string) => ipcRenderer.invoke('ws:recoveryRestore', String(id)),
  recoveryReinstall: (mode: string, confirm = '') => ipcRenderer.invoke('ws:recoveryReinstall', String(mode), String(confirm)),
  recoveryCopyToUsb: () => ipcRenderer.invoke('ws:recoveryCopyToUsb'),
  recoveryTerminal: () => ipcRenderer.invoke('ws:recoveryTerminal'),
  recoverySaveReport: (text: string) => ipcRenderer.invoke('ws:recoverySaveReport', String(text)),
})

// Panel (taskbar windows, tray, Super key) — see electron/panel.ts.
const on = (channel: string) => (cb: (payload: unknown) => void) => {
  const listener = (_e: unknown, payload: unknown) => cb(payload)
  ipcRenderer.on(channel, listener)
  return () => { ipcRenderer.removeListener(channel, listener) }
}
contextBridge.exposeInMainWorld('worksuitePanel', {
  windows: () => ipcRenderer.invoke('ws:panelWindows'),
  activate: (handle: string) => ipcRenderer.invoke('ws:panelActivate', String(handle)),
  close: (handle: string) => ipcRenderer.invoke('ws:panelClose', String(handle)),
  minimize: (handle: string, state: boolean) => ipcRenderer.invoke('ws:panelMinimize', String(handle), state ? '1' : '0'),
  tray: () => ipcRenderer.invoke('ws:panelTray'),
  trayActivate: (key: string, x: number, y: number) => ipcRenderer.invoke('ws:panelTrayActivate', String(key), String(x), String(y)),
  onWindows: on('ws:panelWindowsChanged'),
  onTray: on('ws:panelTrayChanged'),
  onLauncher: on('ws:launcher'),
  workspaces: () => ipcRenderer.invoke('ws:panelWorkspaces'),
  activateWorkspace: (n: number) => ipcRenderer.invoke('ws:panelWorkspaceActivate', String(Number(n) | 0)),
  moveToWorkspace: (handle: string, n: number) => ipcRenderer.invoke('ws:panelMoveToWorkspace', String(handle), String(Number(n) | 0)),
  onWorkspaces: on('ws:panelWorkspacesChanged'),
  // Desktops (Task View, WSOS-DSK-003)
  createWorkspace: () => ipcRenderer.invoke('ws:panelWorkspaceCreate'),
  removeWorkspace: (n: number) => ipcRenderer.invoke('ws:panelWorkspaceRemove', String(Number(n) | 0)),
  moveWorkspace: (from: number, to: number) => ipcRenderer.invoke('ws:panelWorkspaceMove', String(Number(from) | 0), String(Number(to) | 0)),
  renameWorkspace: (n: number, name: string) => ipcRenderer.invoke('ws:panelWorkspaceRename', String(Number(n) | 0), String(name)),
  restoreWorkspaces: (names: string[], prefix: string) => ipcRenderer.invoke('ws:panelWorkspacesRestore', JSON.stringify(names.map(String)), String(prefix)),
  setWindowOnAllDesktops: (handle: string, on: boolean) => ipcRenderer.invoke('ws:panelWindowAllDesktops', String(handle), on ? '1' : '0'),
  setAppOnAllDesktops: (appId: string, on: boolean) => ipcRenderer.invoke('ws:panelAppAllDesktops', String(appId), on ? '1' : '0'),
  setSwitcherAllDesktops: (on: boolean) => ipcRenderer.invoke('ws:panelSwitcherAll', on ? '1' : '0'),
  openTaskView: () => ipcRenderer.invoke('ws:panelTaskView', 'open'),
  taskViewState: (open: boolean) => ipcRenderer.invoke('ws:panelTaskView', open ? '1' : '0'),
  shellOnTop: (on: boolean) => ipcRenderer.invoke('ws:panelShellOnTop', on ? '1' : '0'),
  onTaskView: on('ws:taskView'),
  onShellBehind: on('ws:shellBehind'),
})

// On-device AI assistant — see electron/ai.ts and services/ai. Answers stream back as onEvent.
contextBridge.exposeInMainWorld('worksuiteAI', {
  status: () => ipcRenderer.invoke('ws:aiStatus'),
  models: () => ipcRenderer.invoke('ws:aiModels'),
  refresh: () => ipcRenderer.invoke('ws:aiRefresh'),
  install: (id: string) => ipcRenderer.invoke('ws:aiInstall', String(id)),
  cancel: (id: string, discard: boolean) => ipcRenderer.invoke('ws:aiCancel', String(id), discard ? '1' : '0'),
  remove: (id: string) => ipcRenderer.invoke('ws:aiRemove', String(id)),
  setDefault: (id: string) => ipcRenderer.invoke('ws:aiSetDefault', String(id)),
  check: (id: string) => ipcRenderer.invoke('ws:aiCheck', String(id)),
  test: (id: string) => ipcRenderer.invoke('ws:aiTest', String(id)),
  restart: () => ipcRenderer.invoke('ws:aiRestart'),
  setSettings: (patch: unknown) => ipcRenderer.invoke('ws:aiSetSettings', JSON.stringify(patch ?? {})),
  ask: (req: unknown) => ipcRenderer.invoke('ws:aiAsk', JSON.stringify(req ?? {})),
  cancelAsk: (id: string) => ipcRenderer.invoke('ws:aiCancelAsk', String(id)),
  selection: () => ipcRenderer.invoke('ws:aiSelection'),
  clipboard: () => ipcRenderer.invoke('ws:aiClipboard'),
  readFile: (root: string, rel: string) => ipcRenderer.invoke('ws:aiReadFile', String(root), String(rel)),
  onEvent: on('ws:aiEvent'),
  onChanged: on('ws:aiChanged'),
})

// Default apps, clipboard history, problem report — see electron/desktopHost.ts.
contextBridge.exposeInMainWorld('worksuiteDesktop', {
  defaultApps: () => ipcRenderer.invoke('ws:defaultApps'),
  setDefaultApp: (category: string, id: string) => ipcRenderer.invoke('ws:setDefaultApp', String(category), String(id)),
  clipboardState: () => ipcRenderer.invoke('ws:clipboardState'),
  clipboardSetEnabled: (on: boolean) => ipcRenderer.invoke('ws:clipboardSetEnabled', on ? 'on' : 'off'),
  clipboardClear: (all?: boolean) => ipcRenderer.invoke('ws:clipboardClear', all ? 'all' : ''),
  clipboardPin: (id: number, on: boolean) => ipcRenderer.invoke('ws:clipboardPin', String(Number(id)), on ? '1' : '0'),
  clipboardPaste: (id: number, previous: string) => ipcRenderer.invoke('ws:clipboardPaste', String(Number(id)), String(previous ?? '')),
  clipboardType: (text: string, previous: string) => ipcRenderer.invoke('ws:clipboardType', String(text).slice(0, 64), String(previous ?? '')),
  clipboardRemove: (id: number) => ipcRenderer.invoke('ws:clipboardRemove', String(Number(id))),
  clipboardCopy: (id: number) => ipcRenderer.invoke('ws:clipboardCopy', String(Number(id))),
  onClipboard: on('ws:clipboardChanged'),
  problemReport: () => ipcRenderer.invoke('ws:problemReport'),
  shellRestart: () => ipcRenderer.invoke('ws:shellRestart'),
  shellRestartSeen: (n: number) => ipcRenderer.invoke('ws:shellRestartSeen', String(Math.max(0, Math.floor(Number(n)) || 0))),
})

// Shutdown/restart/sign-out overlay, inhibitors, crashed apps, administrators' diagnostics — see electron/sessionHost.ts.
contextBridge.exposeInMainWorld('worksuiteSession', {
  inhibitors: (action: string) => ipcRenderer.invoke('ws:inhibitors', String(action)),
  powerForce: (action: string) => ipcRenderer.invoke('ws:powerForce', String(action)),
  setEndState: (state: unknown) => ipcRenderer.invoke('ws:sessionEndState', JSON.stringify(state ?? null)),
  onEndState: on('ws:sessionEnd'),
  onCrash: on('ws:appCrashed'),
  reopen: (id: string) => ipcRenderer.invoke('ws:reopenApp', String(id)),
  isAdmin: () => ipcRenderer.invoke('ws:isAdmin'),
  sessionJournal: (lines: number) => ipcRenderer.invoke('ws:sessionJournal', String(lines)),
  systemJournal: (kind: string, lines: number) => ipcRenderer.invoke('ws:systemJournal', String(kind), String(lines)),
  bootDetails: (op: string) => ipcRenderer.invoke('ws:bootDetails', String(op)),
})

// System monitor (G11) and quick settings brightness / power mode (G01).
contextBridge.exposeInMainWorld('worksuiteMonitor', {
  sysBrightness: () => ipcRenderer.invoke('ws:sysBrightness'),
  sysSetBrightness: (percent: number) => ipcRenderer.invoke('ws:sysSetBrightness', String(percent)),
  monitorSample: () => ipcRenderer.invoke('ws:monitorSample'),
  monitorHealth: () => ipcRenderer.invoke('ws:monitorHealth'),
  monitorStartup: () => ipcRenderer.invoke('ws:monitorStartup'),
  monitorEnd: (pid: number) => ipcRenderer.invoke('ws:monitorEnd', String(pid)),
})

// Administrator prompts from the WorkSuite polkit agent — see electron/polkit.ts.
contextBridge.exposeInMainWorld('worksuitePolkit', {
  state: () => ipcRenderer.invoke('ws:polkitState'),
  respond: (id: string, password: string) => ipcRenderer.invoke('ws:polkitRespond', String(id), String(password)),
  cancel: (id: string) => ipcRenderer.invoke('ws:polkitCancel', String(id)),
  onState: on('ws:polkit'),
})

// Bluetooth pairing, removable storage, power profiles, printers, input methods, sync errors — see electron/peripherals.ts.
contextBridge.exposeInMainWorld('worksuitePeripherals', {
  btScan: () => ipcRenderer.invoke('ws:btScan'),
  btPair: (address: string) => ipcRenderer.invoke('ws:btPair', String(address)),
  btRemove: (address: string) => ipcRenderer.invoke('ws:btRemove', String(address)),
  volumes: () => ipcRenderer.invoke('ws:volumes'),
  volMount: (device: string) => ipcRenderer.invoke('ws:volMount', String(device)),
  volUnlock: (device: string, passphrase: string) => ipcRenderer.invoke('ws:volUnlock', String(device), String(passphrase)),
  volEject: (device: string) => ipcRenderer.invoke('ws:volEject', String(device)),
  powerProfiles: () => ipcRenderer.invoke('ws:powerProfiles'),
  setPowerProfile: (name: string) => ipcRenderer.invoke('ws:setPowerProfile', String(name)),
  inhibitors: () => ipcRenderer.invoke('ws:powerInhibitors'),
  findPrinters: () => ipcRenderer.invoke('ws:findPrinters'),
  addPrinter: (uri: string, name: string) => ipcRenderer.invoke('ws:addPrinter', String(uri), String(name)),
  removePrinter: (name: string) => ipcRenderer.invoke('ws:removePrinter', String(name)),
  printQueue: () => ipcRenderer.invoke('ws:printQueue'),
  cancelJob: (id: string) => ipcRenderer.invoke('ws:cancelJob', String(id)),
  screenCapture: () => ipcRenderer.invoke('ws:screenCapture'),
  stopScreenCapture: () => ipcRenderer.invoke('ws:stopScreenCapture'),
  inputMethods: () => ipcRenderer.invoke('ws:inputMethods'),
  setInputMethods: (ids: string[]) => ipcRenderer.invoke('ws:setInputMethods', ...(Array.isArray(ids) ? ids.map(String) : [])),
  syncFailed: () => ipcRenderer.invoke('ws:syncFailed'),
  syncRetry: (mutationId: string) => ipcRenderer.invoke('ws:syncRetry', String(mutationId)),
})

// Notifications from apps through the shell's org.freedesktop.Notifications server — see electron/notifications.ts.
contextBridge.exposeInMainWorld('worksuiteNotifications', {
  list: () => ipcRenderer.invoke('ws:notifications'),
  invoke: (id: number, key: string) => ipcRenderer.invoke('ws:notificationInvoke', String(Number(id)), String(key)),
  dismiss: (id: number) => ipcRenderer.invoke('ws:notificationDismiss', String(Number(id))),
  onChange: on('ws:notificationsChanged'),
})

// Touchscreen, pen, touch mode and the on-screen keyboard — see electron/touch.ts.
contextBridge.exposeInMainWorld('worksuiteTouch', {
  state: () => ipcRenderer.invoke('ws:touchState'),
  set: (patch: unknown) => ipcRenderer.invoke('ws:touchSet', JSON.stringify(patch)),
  osk: (show: boolean, purpose = 0, hints = 0) => ipcRenderer.invoke('ws:oskShow', show ? '1' : '0', String(Number(purpose) | 0), String(Number(hints) | 0)),
  oskToggle: () => ipcRenderer.invoke('ws:oskToggle'),
  penTest: (on: boolean) => ipcRenderer.invoke('ws:penTest', on ? '1' : '0'),
  onChange: on('ws:touchChanged'),
  onPen: on('ws:penEvent'),
})

// Screenshots, the snipping overlay and editor, Windows-style Open targets, shortcuts — see electron/capture.ts,
// electron/shortcutsHost.ts. Images travel as data: URLs; files are written only where the person saves them.
contextBridge.exposeInMainWorld('worksuiteCapture', {
  allowed: () => ipcRenderer.invoke('ws:captureAllowed'),
  settings: () => ipcRenderer.invoke('ws:captureSettings'),
  setSettings: (patch: unknown) => ipcRenderer.invoke('ws:captureSetSettings', JSON.stringify(patch ?? {})),
  capture: (kind: string) => ipcRenderer.invoke('ws:capture', String(kind)),
  snipStart: (mode: string, delay: number) => ipcRenderer.invoke('ws:snipStart', String(mode), String(Number(delay) || 0)),
  snipFrame: (id: number, output: string) => ipcRenderer.invoke('ws:snipFrame', String(Number(id)), String(output ?? '')),
  snipDone: (id: number, dataUrl: string) => ipcRenderer.invoke('ws:snipDone', String(Number(id)), String(dataUrl)),
  snipCancel: (id: number) => ipcRenderer.invoke('ws:snipCancel', String(Number(id))),
  snipImage: (id: number) => ipcRenderer.invoke('ws:snipImage', String(Number(id) || 0)),
  snipCopy: (dataUrl: string) => ipcRenderer.invoke('ws:snipCopy', String(dataUrl)),
  snipSave: (dataUrl: string) => ipcRenderer.invoke('ws:snipSave', String(dataUrl)),
  snipReveal: (file: string) => ipcRenderer.invoke('ws:snipReveal', String(file)),
  shortcutsApply: (prefs: unknown) => ipcRenderer.invoke('ws:shortcutsApply', JSON.stringify(prefs ?? null)),
  edit: (cmd: string) => ipcRenderer.invoke('ws:edit', String(cmd)),
  onSnipOpen: on('ws:snipOpen'),
  onSnipClose: on('ws:snipClose'),
  onCaptured: on('ws:captured'),
  onShellOpen: on('ws:shellOpen'),
  onToastClicked: on('ws:toastClicked'),
})

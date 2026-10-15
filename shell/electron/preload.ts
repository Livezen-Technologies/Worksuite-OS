import { contextBridge, ipcRenderer } from 'electron'

// Named functions only; the renderer never sees ipcRenderer (WSOS-SEC-001, §10.3).
contextBridge.exposeInMainWorld('worksuite', {
  authenticate: (user: string, password: string) => ipcRenderer.invoke('ws:authenticate', String(user), String(password)),
  lock: () => ipcRenderer.invoke('ws:lock'),
  logout: () => ipcRenderer.invoke('ws:logout'),
  power: (action: string) => ipcRenderer.invoke('ws:power', String(action)),
  launchApp: (appId: string) => ipcRenderer.invoke('ws:launchApp', String(appId)),
  openWorkSuiteApp: (appId: string, url: string) => ipcRenderer.invoke('ws:openWorkSuiteApp', String(appId), String(url)),
  lockSettings: () => ipcRenderer.invoke('ws:lockSettings'),
  setLockTimeout: (seconds: number) => ipcRenderer.invoke('ws:setLockTimeout', String(seconds)),
  webApps: () => ipcRenderer.invoke('ws:webApps'),
  installedApps: () => ipcRenderer.invoke('ws:installedApps'),
  launchOffice: (kind: string) => ipcRenderer.invoke('ws:launchOffice', String(kind)),
  launchWorkSuite: (module: string) => ipcRenderer.invoke('ws:launchWorkSuite', String(module)),
  search: (q: string, types?: string[]) => ipcRenderer.invoke('ws:search', String(q), (types ?? []).map(String).join(',')),
  recentFiles: () => ipcRenderer.invoke('ws:recentFiles'),
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
  filesTrashList: () => ipcRenderer.invoke('ws:filesTrashList'),
  filesTrashRestore: (ids: string[]) => ipcRenderer.invoke('ws:filesTrashRestore', JSON.stringify(ids.map(String))),
  filesTrashDelete: (ids: string[] | 'all') => ipcRenderer.invoke('ws:filesTrashDelete', ids === 'all' ? 'all' : JSON.stringify(ids.map(String))),
  filesPaste: (op: string, srcRoot: string, rels: string[], dstRoot: string, dstRel: string) => ipcRenderer.invoke('ws:filesPaste', String(op), String(srcRoot), JSON.stringify(rels.map(String)), String(dstRoot), String(dstRel)),
  filesResolve: (id: string, r: string, all: boolean) => ipcRenderer.invoke('ws:filesResolve', String(id), String(r), all ? '1' : '0'),
  filesCompress: (root: string, rels: string[]) => ipcRenderer.invoke('ws:filesCompress', String(root), JSON.stringify(rels.map(String))),
  filesEject: (id: string) => ipcRenderer.invoke('ws:filesEject', String(id)),
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
  hwDriverUpdates: () => ipcRenderer.invoke('ws:hwDriverUpdates'),
  hwInstallDrivers: (ids: string[]) => ipcRenderer.invoke('ws:hwInstallDrivers', ...(Array.isArray(ids) ? ids.map(String) : [])),
  sysUsers: () => ipcRenderer.invoke('ws:sysUsers'),
  cloudAccounts: () => ipcRenderer.invoke('ws:cloudAccounts'),
  pkgRepair: () => ipcRenderer.invoke('ws:pkgRepair'),
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
  recoveryReinstall: (mode: string) => ipcRenderer.invoke('ws:recoveryReinstall', String(mode)),
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
})

// Default apps, clipboard history, problem report — see electron/desktopHost.ts.
contextBridge.exposeInMainWorld('worksuiteDesktop', {
  defaultApps: () => ipcRenderer.invoke('ws:defaultApps'),
  setDefaultApp: (category: string, id: string) => ipcRenderer.invoke('ws:setDefaultApp', String(category), String(id)),
  clipboardState: () => ipcRenderer.invoke('ws:clipboardState'),
  clipboardSetEnabled: (on: boolean) => ipcRenderer.invoke('ws:clipboardSetEnabled', on ? 'on' : 'off'),
  clipboardClear: () => ipcRenderer.invoke('ws:clipboardClear'),
  clipboardRemove: (id: number) => ipcRenderer.invoke('ws:clipboardRemove', String(Number(id))),
  clipboardCopy: (id: number) => ipcRenderer.invoke('ws:clipboardCopy', String(Number(id))),
  onClipboard: on('ws:clipboardChanged'),
  problemReport: () => ipcRenderer.invoke('ws:problemReport'),
  shellRestart: () => ipcRenderer.invoke('ws:shellRestart'),
  shellRestartSeen: (n: number) => ipcRenderer.invoke('ws:shellRestartSeen', String(Math.max(0, Math.floor(Number(n)) || 0))),
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
  inhibitors: () => ipcRenderer.invoke('ws:inhibitors'),
  findPrinters: () => ipcRenderer.invoke('ws:findPrinters'),
  addPrinter: (uri: string, name: string) => ipcRenderer.invoke('ws:addPrinter', String(uri), String(name)),
  removePrinter: (name: string) => ipcRenderer.invoke('ws:removePrinter', String(name)),
  printQueue: () => ipcRenderer.invoke('ws:printQueue'),
  cancelJob: (id: string) => ipcRenderer.invoke('ws:cancelJob', String(id)),
  screenCapture: () => ipcRenderer.invoke('ws:screenCapture'),
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

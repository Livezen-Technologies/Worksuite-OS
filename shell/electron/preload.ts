import { contextBridge, ipcRenderer } from 'electron'

// Named functions only; the renderer never sees ipcRenderer (WSOS-SEC-001, §10.3).
contextBridge.exposeInMainWorld('worksuite', {
  authenticate: (user: string, password: string) => ipcRenderer.invoke('ws:authenticate', String(user), String(password)),
  lock: () => ipcRenderer.invoke('ws:lock'),
  logout: () => ipcRenderer.invoke('ws:logout'),
  power: (action: string) => ipcRenderer.invoke('ws:power', String(action)),
  launchApp: (appId: string) => ipcRenderer.invoke('ws:launchApp', String(appId)),
  openLink: (url: string) => ipcRenderer.invoke('ws:openLink', String(url)),
  cloudSignIn: (serverUrl: string, mode: string) => ipcRenderer.invoke('ws:cloudSignIn', String(serverUrl), String(mode)),
  cloudSignOut: (accountId: string, choice: string) => ipcRenderer.invoke('ws:cloudSignOut', String(accountId), String(choice)),
  syncUnsent: (accountId: string) => ipcRenderer.invoke('ws:syncUnsent', String(accountId)),
  syncNow: () => ipcRenderer.invoke('ws:syncNow'),
  syncStatus: () => ipcRenderer.invoke('ws:syncStatus'),
  deviceInfo: () => ipcRenderer.invoke('ws:deviceInfo'),
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
  // Only the event payload reaches the renderer, never the IPC event object.
  onPkgJob: (cb: (e: unknown) => void) => {
    const listener = (_e: unknown, payload: unknown) => cb(payload)
    ipcRenderer.on('ws:pkgJob', listener)
    return () => { ipcRenderer.removeListener('ws:pkgJob', listener) }
  },
  cloudAccounts: () => ipcRenderer.invoke('ws:cloudAccounts'),
  pkgRepair: () => ipcRenderer.invoke('ws:pkgRepair'),
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

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
  deviceInfo: () => ipcRenderer.invoke('ws:deviceInfo'),
  enrollDevice: (serverUrl: string, code: string) => ipcRenderer.invoke('ws:enrollDevice', String(serverUrl), String(code)),
  pkgPreview: (catalogId: string, op: string) => ipcRenderer.invoke('ws:pkgPreview', String(catalogId), String(op)),
  pkgInstall: (catalogId: string) => ipcRenderer.invoke('ws:pkgInstall', String(catalogId)),
  pkgRemove: (catalogId: string) => ipcRenderer.invoke('ws:pkgRemove', String(catalogId)),
  pkgApplyUpdate: () => ipcRenderer.invoke('ws:pkgApplyUpdate'),
  pkgCheckUpdates: () => ipcRenderer.invoke('ws:pkgCheckUpdates'),
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
})

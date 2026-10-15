import { contextBridge, ipcRenderer } from 'electron'

// Named functions only; the renderer never sees ipcRenderer (WSOS-SEC-001, §10.3).
contextBridge.exposeInMainWorld('worksuite', {
  authenticate: (user: string, password: string) => ipcRenderer.invoke('ws:authenticate', String(user), String(password)),
  lock: () => ipcRenderer.invoke('ws:lock'),
  logout: () => ipcRenderer.invoke('ws:logout'),
  power: (action: string) => ipcRenderer.invoke('ws:power', String(action)),
  launchApp: (appId: string) => ipcRenderer.invoke('ws:launchApp', String(appId)),
  openLink: (url: string) => ipcRenderer.invoke('ws:openLink', String(url)),
  cloudSignIn: (serverUrl: string) => ipcRenderer.invoke('ws:cloudSignIn', String(serverUrl)),
  cloudSignOut: (accountId: string) => ipcRenderer.invoke('ws:cloudSignOut', String(accountId)),
  cloudAccounts: () => ipcRenderer.invoke('ws:cloudAccounts'),
})

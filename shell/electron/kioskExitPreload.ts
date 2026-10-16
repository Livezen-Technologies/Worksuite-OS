// Preload of the kiosk exit prompt (src/screens/KioskExit.tsx). Named functions only; the main process checks that
// calls come from the prompt window.
import { contextBridge, ipcRenderer } from 'electron'

contextBridge.exposeInMainWorld('worksuiteKiosk', {
  info: () => ipcRenderer.invoke('kiosk:info'),
  exitWithPin: (pin: string) => ipcRenderer.invoke('kiosk:exitPin', String(pin)),
  exitAsAdmin: () => ipcRenderer.invoke('kiosk:exitAdmin'),
  cancel: () => ipcRenderer.invoke('kiosk:cancel'),
})

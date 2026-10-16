// Preload of the WhatsApp window (contextIsolation stays on): clicking one of WhatsApp Web's notifications asks main
// to show and focus the window, then the page's own handler opens the chat. Only the bare "focus" request crosses.
import { contextBridge, ipcRenderer } from 'electron'
import { WHATSAPP_FOCUS_CHANNEL, WHATSAPP_FOCUS_GLOBAL, wrapNotification } from './whatsapp'

contextBridge.exposeInMainWorld(WHATSAPP_FOCUS_GLOBAL, () => ipcRenderer.send(WHATSAPP_FOCUS_CHANNEL))
contextBridge.executeInMainWorld({ func: wrapNotification as (...a: unknown[]) => unknown, args: [null, WHATSAPP_FOCUS_GLOBAL] })

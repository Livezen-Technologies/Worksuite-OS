// The app window processes name themselves before 'ready': Chromium's libnotify path sends app.getName() as
// app_name and CHROME_DESKTOP (set by setDesktopName) as the desktop-entry hint, which the shell's notification
// server uses to raise the sender's window on click.
import { beforeEach, describe, expect, it, vi } from 'vitest'

const calls = vi.hoisted(() => ({ name: [] as string[], desktop: [] as string[], switches: [] as [string, string?][] }))
vi.mock('electron', () => {
  const app = {
    setName: (n: string) => calls.name.push(n), setDesktopName: (n: string) => calls.desktop.push(n),
    commandLine: { appendSwitch: (k: string, v?: string) => calls.switches.push([k, v]) },
    setPath: () => {}, requestSingleInstanceLock: () => true, isReady: () => false,
  }
  return { app, default: { app }, BrowserWindow: class {}, desktopCapturer: {}, dialog: {}, ipcMain: {}, session: {}, shell: {} }
})

beforeEach(() => { calls.name.length = 0; calls.desktop.length = 0; calls.switches.length = 0 })

describe('app window process names', () => {
  it('WhatsApp: app_name "WhatsApp", desktop-entry and app_id lk.worksuite.whatsapp', async () => {
    const { prepareWhatsApp } = await import('./whatsappwindow')
    expect(prepareWhatsApp()).toBe(true)
    expect(calls.name).toEqual(['WhatsApp'])
    expect(calls.desktop).toEqual(['lk.worksuite.whatsapp.desktop'])
    expect(calls.switches).toContainEqual(['class', 'lk.worksuite.whatsapp'])
  })
  it('WorkSuite web apps: their own name and desktop entry', async () => {
    const { prepareAppMode } = await import('./appwindow')
    expect(prepareAppMode({ id: 'meet', link: null })).toBe(true)
    expect(calls.name).toEqual(['WorkSuite Meet'])
    expect(calls.desktop).toEqual(['worksuite-meet.desktop'])
    expect(calls.switches).toContainEqual(['class', 'worksuite-meet'])
  })
})

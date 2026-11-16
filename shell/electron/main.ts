import { app, session } from 'electron'
import { syncCall } from './broker'
import { prepareAppMode, runAppMode } from './appwindow'
import { prepareWhatsApp, runWhatsApp } from './whatsappwindow'
import { WHATSAPP_ID } from './whatsapp'
import { parseAppArgs } from './webapps'
import { accelerationPlan, noteGpuCrash, readCrashLog, readRendererChoice } from './graphics'
import { defaultEnv } from './files'
import { loadGrants } from './webSecurity'
import { createWindow } from './shellCore'
import { registerSessionIpc } from './ipcSession'
import { registerSystemIpc } from './ipcSystem'
import { registerFilesIpc } from './ipcFiles'
import { startDesktopShell } from './desktopShell'

// Runs as the logged-in user; never a general root command runner (WSOS-ARC-001).
// URL scheme allow-list, renderer prefs and per-origin permission grants: ./webSecurity (WSOS-SEC-001/003/006).

// WSOS-INT-011: Sinhala/Tamil typing in the shell and app windows through fcitx5 (Wayland text-input-v3).
app.commandLine.appendSwitch('enable-wayland-ime')
// #58: Chromium speaks text-input-v1 unless told otherwise, and Labwc only offers v3: without this the shell's own text
// fields never reached fcitx5 (no Sinhala in search or Settings), and fcitx5 had no input context to switch.
app.commandLine.appendSwitch('wayland-text-input-version', '3')
// #16: GPU compositing, rasterization and VA-API video in the shell and every WorkSuite app window, or software
// rendering when the session has no usable GPU or the GPU process kept crashing (graphics.ts).
const accel = accelerationPlan(process.env, readCrashLog(), readRendererChoice())
if (accel.disable) app.disableHardwareAcceleration()
for (const [k, v] of accel.switches) app.commandLine.appendSwitch(k, v)
app.on('child-process-gone', (_e, d) => {
  if (d.type === 'GPU' && d.reason !== 'clean-exit' && d.reason !== 'killed') noteGpuCrash()
})
// `worksuite-app <module>` starts the same binary as a WorkSuite app window instead of the shell.
const appRequest = parseAppArgs(process.argv)
if (appRequest?.id === WHATSAPP_ID) {
  // WhatsApp Web: its own window, partition and app_id; no WorkSuite account involved (whatsappwindow.ts).
  if (prepareWhatsApp()) runWhatsApp()
  else app.quit()
} else if (appRequest) {
  if (prepareAppMode(appRequest)) runAppMode(appRequest)
  else app.quit()
} else startShell()

/** The shell's Wayland app_id is Electron's default, "worksuite-shell" (package.json name): Labwc's window rule
 *  (services/session/labwc/rc.xml) keeps it always on bottom by that id: below every app, and on every desktop. */
export const SHELL_APP_ID = 'worksuite-shell'
function startShell() {
app.whenReady().then(() => {
  // Web permissions denied by default; the shell's own session never gets any (WSOS-SEC-003).
  session.defaultSession.setPermissionRequestHandler((_wc, _perm, cb) => cb(false))
  session.defaultSession.setPermissionCheckHandler(() => false)
  // Administrator grants for exact HTTPS origins of WorkSuite apps (/etc/worksuite/web-permissions.json).
  const webGrants = loadGrants()

  const { brokerFn } = registerSessionIpc(webGrants)
  // Files: real folders plus Drive sync states from the sync service.
  const files = defaultEnv(async (dir) => { const r = await syncCall('FileStates', { dir }); return r.ok && Array.isArray(r.value) ? r.value as { name: string; state: string }[] : null })
  registerSystemIpc(accel, files, brokerFn)
  registerFilesIpc(files)
  createWindow()
  startDesktopShell(files, brokerFn)
})

app.on('window-all-closed', () => app.quit())
}

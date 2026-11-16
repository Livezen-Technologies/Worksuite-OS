import { findBundles } from './bundles'
import { app, dialog, powerMonitor } from 'electron'
import { readFileSync, statSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { brokerCall } from './broker'
import { deviceCredential, enrollDevice } from './device'
import { appimageClient, flatpakUserClient, packageClient } from './packages'
import { listDevices } from './hardware'
import { localUsers } from './users'
import { signinHost, type SignInMethod } from './signin'
import { recoveryHost } from './recovery'
import { loadSession } from './webapps'
import { systemBridge } from './system'
import { applyFix, diagnose, diagnosisText, type RadioFix, type RadioKind } from './radios'
import { accelerationPlan, graphicsState, resetGpuFallback, setRenderer } from './graphics'
import { roots } from './files'
import { realExec } from './system'
import { collectReport, finalReport, reportText, sendReport, type ProblemReport } from './problemReport'
import { flatpakPermsClient } from './flatpakPerms'
import { startSysWatch } from './sysWatch'
import type { FileEnv } from './files'
import { win, broadcast, handle } from './shellCore'
import { startPortalWatch } from './portal'

// Shell IPC: Settings' system services, radios, graphics, packages, drivers, sign-in methods, picked files, problem
// reports, VPN, App Center and recovery (from main.ts).

export function registerSystemIpc(accel: ReturnType<typeof accelerationPlan>, files: FileEnv, brokerFn: (m: string, p?: Record<string, unknown>) => ReturnType<typeof brokerCall>) {
  // Settings → NetworkManager, BlueZ, PipeWire, UPower, CUPS, wlr-randr, UDisks2 (WSOS-INT-001…006, DSK-006).
  const sys = systemBridge()
  handle('ws:sysNetwork', () => sys.network())
  handle('ws:sysSetWifi', (on) => sys.setWifi(on === 'on'))
  handle('ws:sysWifiConnect', (ssid, password) => sys.wifiConnect(ssid, password))
  handle('ws:sysBluetooth', () => sys.bluetooth())
  handle('ws:sysSetBluetooth', (on) => sys.setBluetooth(on === 'on'))
  handle('ws:sysBtConnect', (address, on) => sys.btConnect(address, on === 'on'))
  handle('ws:sysWifiRescan', () => sys.wifiRescan())
  handle('ws:sysWifiDisconnect', () => sys.wifiDisconnect())
  // #31: why Wi-Fi or Bluetooth doesn't work, and the fixes a person can apply (radios.ts).
  const radioKind = (k: string): RadioKind | null => (k === 'wifi' || k === 'bluetooth' ? k : null)
  handle('ws:radioDiagnose', async (kind) => {
    const k = radioKind(kind)
    if (!k) return { ok: false, error: 'invalid_argument' }
    const d = await diagnose(k, { exec: realExec })
    return { ok: true, value: { ...d, text: diagnosisText(d) } }
  })
  handle('ws:radioFix', (kind, fix) => {
    const k = radioKind(kind)
    if (!k || (fix !== 'unblock' && fix !== 'restart_service')) return { ok: false, error: 'invalid_argument' }
    return applyFix(k, fix as RadioFix, realExec)
  })
  // #16: Settings › Graphics.
  handle('ws:graphics', async () => ({ ok: true, value: await graphicsState({ exec: realExec, plan: accel, featureStatus: () => app.getGPUFeatureStatus() as unknown as Record<string, string>, gpuInfo: () => app.getGPUInfo('complete') }) }))
  handle('ws:graphicsSetRenderer', (choice) => setRenderer(choice))
  handle('ws:graphicsReset', () => resetGpuFallback())
  handle('ws:sysSound', () => sys.sound())
  handle('ws:sysSetVolume', (p) => sys.setVolume(Number(p)))
  handle('ws:sysSetMute', (on) => sys.setMute(on === 'on'))
  handle('ws:sysSetDefaultAudio', (id) => sys.setDefaultAudio(Number(id)))
  handle('ws:sysBattery', () => sys.battery())
  // The taskbar's Wi-Fi, Bluetooth and power indicators update when the services signal a change (#28).
  void startSysWatch(broadcast)
  // After sleep the AC and Wi-Fi may have changed while no signal could arrive (#43): re-read everything on wake.
  powerMonitor.on('resume', () => { for (const k of ['battery', 'network', 'bluetooth']) broadcast('ws:sysChanged', k) })
  handle('ws:sysPrinters', () => sys.printers())
  handle('ws:sysDisplays', () => sys.displays())
  handle('ws:sysDisks', () => sys.disks())
  handle('ws:enrollDevice', (serverUrl, code) => enrollDevice(serverUrl, code))
  // App Center (WSOS-APP-001/002): preview before confirmation, then a job whose result arrives as an event.
  const pkg = packageClient()
  handle('ws:pkgPreview', (catalogId, op) => pkg.preview(catalogId, op === 'remove' ? 'remove' : 'install'))
  handle('ws:pkgInstall', (catalogId) => pkg.start('Install', catalogId))
  handle('ws:pkgRemove', (catalogId) => pkg.start('Remove', catalogId))
  handle('ws:pkgApplyUpdate', () => pkg.applyUpdate())
  handle('ws:pkgCheckUpdates', () => pkg.checkUpdates())
  handle('ws:updateStatus', (check) => pkg.updateStatus(check === 'check'))
  handle('ws:updateDefer', () => pkg.deferUpdate())
  handle('ws:updateInstallNow', () => pkg.installUpdateNow())
  // Devices: sysfs, read-only. There is no driver catalog or driver installer service yet, so those say so.
  handle('ws:hwDevices', () => { try { return { ok: true, value: listDevices() } } catch { return { ok: false, error: 'unavailable' } } })
  // Settings › Drivers: the package service's driver report (hardware scan, online search) and installs (polkit).
  handle('ws:hwDriverReport', (check) => pkg.driverReport(check === 'check'))
  handle('ws:hwMokPassword', () => pkg.mokPassword())
  handle('ws:hwInstallDrivers', (...ids) => pkg.installDrivers(ids.map(String)))
  handle('ws:sysUsers', () => localUsers())
  // Settings › Users › Sign-in options. Every change runs worksuite-signin through pkexec; the PIN goes on stdin.
  const signin = signinHost()
  handle('ws:signinMethods', () => signin.methods())
  handle('ws:signinPinSet', (pin) => signin.pinSet(pin))
  handle('ws:signinPinRemove', () => signin.pinRemove())
  handle('ws:signinKeyAdd', (name) => signin.keyAdd(name))
  handle('ws:signinKeyRemove', (id) => signin.keyRemove(id))
  handle('ws:signinSetDefault', (m) => ['password', 'pin', 'key'].includes(m) ? signin.setDefault(m as SignInMethod) : { ok: false, error: 'bad_method' })
  handle('ws:pkgRepair', () => pkg.repair())
  handle('ws:pkgState', () => pkg.serviceState())
  handle('ws:pkgCatalog', () => pkg.catalog())
  handle('ws:pkgRequestApp', (catalogId, reason) => pkg.requestApp(String(catalogId), String(reason ?? '')))
  handle('ws:updateHistory', () => pkg.updateHistory())
  handle('ws:appUpdates', () => pkg.appUpdates())
  handle('ws:updateApps', (...ids) => pkg.updateApps(ids.map(String)))
  // Files for local installs come only from the user's own choice in a file dialog: the renderer gets an opaque
  // handle, never the ability to name a path (WSOS-APT-005, WSOS-AIM-001, WSOS-AUP-010).
  const picked = new Map<string, string>()
  const FILTERS: Record<string, { name: string; extensions: string[] }> = {
    deb: { name: 'Debian package', extensions: ['deb'] }, appimage: { name: 'AppImage', extensions: ['AppImage', 'appimage'] }, wsupdate: { name: 'WorkSuite update bundle', extensions: ['wsupdate'] },
    wgconf: { name: 'WireGuard configuration', extensions: ['conf'] }, ovpn: { name: 'OpenVPN configuration', extensions: ['ovpn', 'conf'] },
  }
  handle('ws:pickFile', async (kind) => {
    const filter = FILTERS[kind]
    if (!filter || !win) return { ok: false, error: 'invalid_argument' }
    const r = await dialog.showOpenDialog(win, { properties: ['openFile'], filters: [filter], defaultPath: kind === 'wsupdate' ? '/media' : app.getPath('downloads') })
    if (r.canceled || !r.filePaths[0]) return { ok: false, error: 'cancelled' }
    const handleId = `${kind}:${picked.size + 1}:${Date.now()}`
    picked.set(handleId, r.filePaths[0])
    return { ok: true, value: { handle: handleId, name: path.basename(r.filePaths[0]) } }
  })
  // §11.6-d Report a problem: collected only when asked, reviewed by the person, then saved or sent.
  const reports = new Map<string, ProblemReport>()
  handle('ws:reportCollect', async () => {
    const r = await collectReport({ exec: realExec, readFile: (p) => { try { return readFileSync(p, 'utf8') } catch { return null } }, home: app.getPath('home') })
    reports.clear(); reports.set(r.id, r)
    return { ok: true, value: r }
  })
  const finalOf = (id: string, keep: string, desc: string) => { const r = reports.get(id); return r ? finalReport(r, keep.split(',').filter(Boolean), desc) : null }
  handle('ws:reportSave', async (id, keep, desc) => {
    const f = finalOf(id, keep, desc)
    if (!f || !win) return { ok: false, error: 'invalid_argument' }
    const d = await dialog.showSaveDialog(win, { defaultPath: path.join(app.getPath('documents'), `worksuite-problem-report-${f.created_at.slice(0, 10)}.txt`) })
    if (d.canceled || !d.filePath) return { ok: false, error: 'cancelled' }
    try { writeFileSync(d.filePath, reportText(f), { mode: 0o600 }) } catch { return { ok: false, error: 'failed' } }
    return { ok: true, value: d.filePath }
  })
  handle('ws:reportSend', async (id, keep, desc) => {
    const f = finalOf(id, keep, desc)
    if (!f) return { ok: false, error: 'invalid_argument' }
    const s = await loadSession(brokerFn, (url, init) => fetch(url, { headers: init?.headers }), () => deviceCredential())
    const r = await sendReport(f, s.ok ? s.value : null, (url, init) => fetch(url, init), deviceCredential())
    return r.ok ? { ok: true, value: f.id } : (!s.ok && s.error !== 'not_signed_in' ? { ok: false, error: s.error } : r)
  })
  const pickedPath = (h: string, kind: string) => (h.startsWith(`${kind}:`) ? picked.get(h) ?? null : null)
  const noFile = { ok: false, error: 'invalid_argument' }
  // G14: .wsupdate bundles on mounted USB drives, behind the same opaque handles as a picked file.
  handle('ws:findBundles', () => {
    const found = findBundles(roots(files).filter((r) => r.id.startsWith('media:')))
    return { ok: true, value: found.map((f) => {
      const h = [...picked].find(([, p]) => p === f.path)?.[0] ?? `wsupdate:${picked.size + 1}:${Date.now()}`
      picked.set(h, f.path)
      return { handle: h, name: f.name, drive: f.drive }
    }) }
  })
  // VPN (WSOS-INT-001): list/connect/disconnect/remove, and import of a WireGuard .conf the user picked.
  handle('ws:sysVpn', () => sys.vpn())
  // OpenVPN user name/password arrive only with a Connect click and go to nmcli on stdin (system.ts).
  handle('ws:sysVpnConnect', (uuid, on, username, password) => sys.vpnConnect(uuid, on === 'on', username !== undefined && password !== undefined ? { username, password } : undefined))
  handle('ws:sysVpnRemove', (uuid) => sys.vpnRemove(uuid))
  handle('ws:sysVpnImport', (h) => {
    const p = pickedPath(h, 'wgconf')
    if (!p) return noFile
    try {
      if (statSync(p).size > 64 * 1024) return { ok: false, error: 'invalid_file' }
      return sys.vpnImport(path.basename(p), readFileSync(p, 'utf8'))
    } catch { return { ok: false, error: 'invalid_file' } }
  })
  // OpenVPN: certificates the .ovpn names must sit next to it (no '..' or absolute paths); they are copied into
  // the user's private VPN folder by system.ts.
  handle('ws:sysVpnImportOpenvpn', (h) => {
    const p = pickedPath(h, 'ovpn')
    if (!p) return noFile
    try {
      if (statSync(p).size > 256 * 1024) return { ok: false, error: 'invalid_file' }
      const dir = path.dirname(p)
      return sys.vpnImportOpenvpn(path.basename(p), readFileSync(p, 'utf8'), {
        readRef(rel) {
          const f = path.resolve(dir, rel)
          if (path.dirname(f) !== dir && !f.startsWith(dir + path.sep)) return null
          try { return statSync(f).isFile() && statSync(f).size <= 256 * 1024 ? readFileSync(f) : null } catch { return null }
        },
      })
    } catch { return { ok: false, error: 'invalid_file' } }
  })
  startPortalWatch(sys)
  handle('ws:localDebPreview', (h) => { const p = pickedPath(h, 'deb'); return p ? pkg.localDebPreview(p) : noFile })
  handle('ws:localDebInstall', (token) => pkg.localDebInstall(token))
  const fpUser = flatpakUserClient()
  handle('ws:appPermissions', (id) => pkg.appPermissions(id))
  // Reset = system overrides (package service, admin) + this user's overrides and portal grants.
  handle('ws:appPermissionsReset', async (id) => {
    const u = await fpUser.resetUserPermissions(id)
    if (!u.ok) return u
    return pkg.resetAppPermissions(id)
  })
  handle('ws:appDataRemove', (id) => fpUser.removeAppData(id))
  // App detail (G09): this user's switches for single declared permissions (flatpak override --user).
  const fpPerms = flatpakPermsClient(realExec)
  handle('ws:appPermsUserOff', (id) => fpPerms.userOff(id))
  handle('ws:appPermSet', async (id, perm, on) => {
    const d = await pkg.appPermissions(id)
    if (!d.ok) return d
    return fpPerms.set(id, perm, on === 'on', (d.value as { permissions?: string[] }).permissions ?? [])
  })
  handle('ws:pruneRuntimes', () => pkg.pruneRuntimes())
  handle('ws:bundleInspect', (h) => { const p = pickedPath(h, 'wsupdate'); return p ? pkg.bundleInspect(p) : noFile })
  handle('ws:bundleInstall', (h) => { const p = pickedPath(h, 'wsupdate'); return p ? pkg.bundleInstall(p) : noFile })
  const appimages = appimageClient()
  handle('ws:appimageList', () => appimages.list())
  handle('ws:appimageImport', (h) => { const p = pickedPath(h, 'appimage'); return p ? appimages.import(p, `file://${p}`) : noFile })
  handle('ws:appimageApprove', (id) => appimages.approve(id))
  handle('ws:appimageRemove', (id) => appimages.remove(id))
  handle('ws:appimageUpdate', (id, h) => { const p = pickedPath(h, 'appimage'); return p ? appimages.update(id, p) : noFile })
  handle('ws:appimageLaunch', (id) => appimages.launch(id))
  // Recovery screens (§9.2). The unlock secret goes to udisksctl's stdin only; it is never logged or stored.
  const rec = recoveryHost(pkg)
  handle('ws:recoveryInfo', () => rec.info())
  handle('ws:recoveryCheck', (id) => rec.check(id))
  handle('ws:recoveryUnlock', (device, secret) => rec.unlock(device, secret))
  handle('ws:recoveryReinstall', (mode, confirm) => rec.reinstall(mode, confirm ?? ''))
  for (const ch of ['ws:recoverySnapshots', 'ws:recoveryRestore', 'ws:recoveryCopyToUsb', 'ws:recoveryTerminal', 'ws:recoverySaveReport']) handle(ch, () => rec.unavailable())
}

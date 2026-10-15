// Typed renderer API. In Electron the preload exposes `window.worksuite` with named functions only
// (WSOS-SEC-001, §10.3); in a plain browser (dev/design review) a local stub answers instead.
export interface WorkSuiteApi {
  authenticate(user: string, password: string): Promise<{ ok: boolean; message?: string }>
  lock(): Promise<void>
  logout(): Promise<void>
  power(action: 'suspend' | 'restart' | 'shutdown'): Promise<void>
  launchApp(appId: string): Promise<void>
  /** Idle screen-lock timeout (seconds, 0 = never) and the organization's maximum (WSOS-LOCK-003). */
  lockSettings(): Promise<LockSettings>
  setLockTimeout(seconds: number): Promise<CloudResult<LockSettings>>
  openLink(url: string): Promise<void>
  /** Launcher global search across WorkSuite records and Drive (the main process holds the token). */
  search(q: string, types?: string[]): Promise<SearchResponse>
  /** Recent files: local (recently-used.xbel) and WorkSuite Drive. */
  recentFiles(): Promise<{ local: SearchHit[]; cloud: { state: SourceState; hits: SearchHit[] } }>
  /** Open a search result (worksuite:// or file://), or its location. */
  openSearchResult(link: string, where?: 'open' | 'location'): Promise<{ ok: boolean; error?: string }>
  /** WorkSuite web apps the org has enabled (from bootstrap via the broker); an error when not signed in/offline. */
  webApps(): Promise<CloudResult<{ id: string; name: string; offline_level?: 'full_offline' | 'cached_read' | 'online_only' }[]>>
  /** Installed applications from XDG desktop entries, and the detected WorkSuite Office entry id (null if absent). */
  installedApps(): Promise<{ apps: InstalledApp[]; office: string | null; desktop?: string | null }>
  /** WorkSuite Office: 'start' (start centre) or a new 'docs' | 'sheets' | 'slides' document. */
  launchOffice(kind: 'start' | 'docs' | 'sheets' | 'slides'): Promise<void>
  /** WorkSuite Desktop with --module=<id> (only when installed; the launcher checks). */
  launchWorkSuite(module: DesktopModule): Promise<void>
  // WorkSuite cloud identity through the credentials broker (SRS §8.1). Tokens never reach the renderer.
  cloudSignIn(serverUrl: string, mode: 'personal' | 'enterprise'): Promise<CloudResult<CloudAccount>>
  /** choice: 'none' when nothing is unsent; 'export' or 'discard' otherwise ("wait" = syncNow, then 'none'). */
  cloudSignOut(accountId: string, choice: SignOutChoice): Promise<CloudResult<{ exported: string | null }>>
  syncUnsent(accountId: string): Promise<CloudResult<number>>
  syncNow(): Promise<CloudResult<unknown>>
  /** Sync service Status: state (idle|syncing|offline|auth_required|device_revoked|stopped), pending, failed, conflicts, last_sync. */
  syncStatus(): Promise<CloudResult<SyncStatus>>
  cloudAccounts(): Promise<CloudResult<CloudAccount[]>>
  /** Settings > About this device (WSOS-MDM-007, WSOS-WIPE-007): device agent status, or local facts when it isn't running. */
  deviceInfo(): Promise<DeviceInfo>
  /** Enterprise enrollment through the device agent; asks for an administrator password (polkit). */
  enrollDevice(serverUrl: string, code: string): Promise<CloudResult<{ device_id: string; org_name: string | null }>>
  // App Center through the package service (catalog ids "apt:<name>" / "flatpak:<app id>").
  pkgPreview(catalogId: string, op: 'install' | 'remove'): Promise<CloudResult<PackagePreview>>
  pkgInstall(catalogId: string): Promise<CloudResult<string>>
  pkgRemove(catalogId: string): Promise<CloudResult<string>>
  pkgApplyUpdate(): Promise<CloudResult<string>>
  pkgCheckUpdates(): Promise<CloudResult<UpdateSummary>>
  // OS update coordinator in the package service (WSOS-AUP-011).
  updateStatus(check: boolean): Promise<CloudResult<OsUpdateStatus>>
  updateDefer(): Promise<CloudResult<boolean>>
  updateInstallNow(): Promise<CloudResult<true>>
  onUpdateStatus(cb: (s: OsUpdateStatus) => void): () => void
  // Files: roots are "home", "drive" (~/WorkSuite Drive) and "media:<name>"; paths are relative to the root.
  filesRoots(): Promise<{ roots: { id: string; label: string }[]; drive_exists: boolean }>
  filesList(root: string, rel: string): Promise<CloudResult<FileEntry[]>>
  filesOpen(root: string, rel: string): Promise<CloudResult<true>>
  filesStatus(root: string): Promise<{ free_bytes: number | null; drive: { states: Record<string, number>; last_sync: number | null; service_state: string } | null }>
  onPkgJob(cb: (e: PackageJobEvent) => void): () => void
  // Settings › Devices: real devices from sysfs (electron/hardware.ts).
  hwDevices(): Promise<CloudResult<HwDevice[]>>
  /** Driver catalog. No service provides one yet, so Electron answers { ok: false, error: 'unavailable' }. */
  hwDriverUpdates(): Promise<CloudResult<DriverOffer[]>>
  /** Install driver offers; progress arrives through onPkgJob with phase = offer id. Electron: 'unavailable'. */
  hwInstallDrivers(ids: string[]): Promise<CloudResult<string>>
  /** Settings › Users: accounts on this computer (electron/users.ts). */
  sysUsers(): Promise<Avail<{ current: string; users: LocalUser[] }>>
  /** Package repair (§9.2): finishes interrupted dpkg/apt changes; result arrives through onPkgJob. */
  pkgRepair(): Promise<CloudResult<string>>
  /** Organization app catalog from the server via the package service (WSOS-APP-001). Never sample data. */
  pkgCatalog(): Promise<CloudResult<AppCatalog>>
  /** Native file dialog; returns an opaque handle the other calls accept (the renderer never names paths). */
  pickFile(kind: 'deb' | 'appimage' | 'wsupdate' | 'wgconf' | 'ovpn'): Promise<CloudResult<{ handle: string; name: string }>>
  localDebPreview(handle: string): Promise<CloudResult<LocalDebPreview>>
  localDebInstall(token: string): Promise<CloudResult<string>>
  appPermissions(catalogId: string): Promise<CloudResult<AppPermissions>>
  appPermissionsReset(catalogId: string): Promise<CloudResult<string>>
  appDataRemove(catalogId: string): Promise<CloudResult<boolean>>
  pruneRuntimes(): Promise<CloudResult<string>>
  bundleInspect(handle: string): Promise<CloudResult<BundleInfo>>
  bundleInstall(handle: string): Promise<CloudResult<string>>
  appimageList(): Promise<CloudResult<AppImageRecord[]>>
  appimageImport(handle: string): Promise<CloudResult<AppImageRecord>>
  appimageApprove(id: string): Promise<CloudResult<AppImageRecord>>
  appimageRemove(id: string): Promise<CloudResult<{ removed: string }>>
  appimageUpdate(id: string, handle: string): Promise<CloudResult<AppImageRecord>>
  appimageLaunch(id: string): Promise<CloudResult<true>>
  // Recovery screens (§9.2). Features that have no service yet answer { ok: false, error: 'unavailable' }.
  recoveryInfo(): Promise<RecoveryInfo>
  recoveryCheck(id: CheckId): Promise<CheckResult>
  /** secret: the formatted recovery key or the passphrase. Sent to udisks over stdin only; never stored. */
  recoveryUnlock(device: string, secret: string): Promise<CloudResult<true>>
  recoverySnapshots(): Promise<CloudResult<SnapshotInfo[]>>
  recoveryRestore(snapshotId: string): Promise<CloudResult<true>>
  recoveryReinstall(mode: 'keep' | 'erase'): Promise<CloudResult<true>>
  recoveryCopyToUsb(): Promise<CloudResult<true>>
  recoveryTerminal(): Promise<CloudResult<true>>
  recoverySaveReport(text: string): Promise<CloudResult<string>>
  // Settings → host services (WSOS-INT-001…006, DSK-006). `available: false` means the tool/service isn't there.
  sysNetwork(): Promise<Avail<NetworkState>>
  sysSetWifi(on: boolean): Promise<Avail<true>>
  /** The password reaches nmcli on stdin only. */
  sysWifiConnect(ssid: string, password: string): Promise<{ ok: true } | { ok: false; error: string }>
  /** VPN profiles (managed "WorkSuite VPN" first) and whether policy allows user VPNs (WSOS-INT-001). */
  sysVpn(): Promise<Avail<VpnState>>
  /** Imports the WireGuard .conf behind a pickFile('wgconf') handle; the private key never reaches the renderer. */
  sysVpnImport(handle: string): Promise<CloudResult<{ uuid: string | null; name: string }>>
  /** Imports the OpenVPN .ovpn behind a pickFile('ovpn') handle; certificates are copied to a private folder. */
  sysVpnImportOpenvpn(handle: string): Promise<CloudResult<{ uuid: string | null; name: string; needs_credentials: boolean }>>
  /** creds: OpenVPN user name/password, passed to nmcli on stdin only; 'credentials_required' when missing. */
  sysVpnConnect(uuid: string, on: boolean, creds?: { username: string; password: string }): Promise<Avail<true>>
  sysVpnRemove(uuid: string): Promise<Avail<true>>
  sysBluetooth(): Promise<Avail<BluetoothState>>
  sysSetBluetooth(on: boolean): Promise<Avail<true>>
  sysBtConnect(address: string, on: boolean): Promise<Avail<true>>
  sysSound(): Promise<Avail<SoundState>>
  sysSetVolume(percent: number): Promise<Avail<true>>
  sysSetMute(muted: boolean): Promise<Avail<true>>
  sysSetDefaultAudio(id: number): Promise<Avail<true>>
  sysBattery(): Promise<Avail<BatteryState>>
  sysPrinters(): Promise<Avail<Printer[]>>
  sysDisplays(): Promise<Avail<Display[]>>
  sysDisks(): Promise<Avail<Drive[]>>
}

export type Avail<T> = { available: true; value: T } | { available: false; reason: string }
export interface WifiNetwork { ssid: string; signal: number; security: string; in_use: boolean }
export interface NetDevice { device: string; type: string; state: string; connection: string | null }
export interface NetworkState { wifi_enabled: boolean; devices: NetDevice[]; networks: WifiNetwork[] }
export interface VpnConnection { name: string; uuid: string; type: 'wireguard' | 'vpn'; kind: 'wireguard' | 'openvpn' | 'vpn'; active: boolean; device: string | null; managed: boolean; needs_credentials: boolean }
export interface VpnState { connections: VpnConnection[]; user_vpn_allowed: boolean; vpn_required: boolean }
export interface BtDevice { address: string; name: string; connected: boolean }
export interface BluetoothState { powered: boolean; name: string | null; discoverable: boolean; paired: BtDevice[] }
export interface AudioDevice { id: number; name: string; is_default: boolean }
export interface SoundState { volume: number; muted: boolean; outputs: AudioDevice[]; inputs: AudioDevice[] }
export interface BatteryState { present: boolean; percentage: number | null; state: string; time_to_full_s: number | null; time_to_empty_s: number | null; on_battery: boolean }
export interface Printer { name: string; state: 'idle' | 'printing' | 'disabled' | 'unknown'; is_default: boolean }
export interface Display { name: string; description: string; enabled: boolean; width: number | null; height: number | null; refresh: number | null; scale: number | null }
export interface Drive { model: string; serial: string; device: string }

/** "about 1 h 20 min" from seconds. */
export function formatDuration(s: number | null): string | null {
  if (s === null || s <= 0) return null
  const h = Math.floor(s / 3600), m = Math.round((s % 3600) / 60)
  return h ? (m ? t('time.aboutHM', { h, m }) : t('time.aboutH', { h })) : t('time.aboutM', { m })
}

export type RecoveryFeature = 'unlock' | 'repair' | 'snapshots' | 'reinstall' | 'copy_usb' | 'terminal' | 'report_usb'
export interface RecoveryLuksDevice { device: string; name: string; label: string | null; version: string | null; size_bytes: number | null; unlocked: boolean }
export interface RecoveryInfo {
  os_version: string | null; disk: string | null; firmware: 'EFI' | 'BIOS'
  /** Shell restarts counted by systemd before recovery opened; null when unknown. */
  failures: number | null
  luks: RecoveryLuksDevice[]; features: Record<RecoveryFeature, boolean>
}

import type { DesktopModule } from './launcher'
import type { HwDevice, HwKind } from '../../electron/hardware'
import type { LocalUser } from '../../electron/users'
import type { SearchHit, SearchResponse, SourceState } from '../../electron/search'
export type { HwDevice, HwKind, LocalUser }
export interface DriverOffer {
  id: string; device_id: string | null; name: string; summary: string
  from_version: string | null; to_version: string
  license: 'open' | 'proprietary'; category: 'security' | 'recommended' | 'optional'
  size_bytes: number | null; restart: boolean
}

export interface PackagePreview {
  plan: { install: { name: string; version: string }[]; upgrade: { name: string; version: string }[]; remove: { name: string; version: string }[] }
  disk_bytes: number | null
  permissions: string[]
  broad: string[]
}
export interface OsUpdateStatus {
  state: 'up_to_date' | 'checking' | 'available' | 'waiting' | 'installing' | 'ready_to_restart' | 'restart_pending' | 'failed'
  version: string | null; installed: string; release_id: string | null; mandatory: boolean; deadline: string | null
  deferrals_left: number | null; reason: string | null; restart_at: number | null; last_check: number | null
}
export interface CatalogEntry {
  id: string; source: 'apt' | 'flatpak' | 'appimage'; name: string; arches: string[]
  required?: boolean; blocked?: boolean; sha256?: string; category?: string; summary?: string; publisher?: string
  installed: boolean; available: boolean; blocked_reason: string | null
}
export type AppCatalog =
  | { state: 'ok'; arch: string; items: CatalogEntry[]; fetched_at: number }
  | { state: 'not_enrolled' | 'unreachable' | 'error'; arch: string; items: []; error: string }
export interface LocalDebPreview {
  package: string; version: string; architecture: string; publisher: string; publisher_verified: false; description: string
  plan: PackagePreview['plan']; disk_bytes: number | null; token: string
}
export interface AppPermissions { app: string; permissions: string[]; overrides: string[]; broad: string[] }
export interface BundleInfo { release_id: string; version: string; packages: number; bytes: number; critical: boolean; verified: true }
export interface AppImageRecord {
  id: string; name: string; version: string | null; origin: string; sha256: string; arch: string; size: number
  signature: { status: 'signed'; fingerprint: string; trusted: boolean } | { status: 'unsigned' } | { status: 'invalid'; reason: string }
  approved: boolean; imported_at: string; approved_at: string | null; categories: string[]
}
export interface UpdateSummary { packages: string[]; flatpaks: string[]; reboot_required: boolean; state: string }
/** state: Drive sync state (WSOS-DRV-002), "folder", "local" outside Drive, or "unknown" when sync isn't running. */
export interface FileEntry { name: string; dir: boolean; size: number | null; modified: number | null; state: string; local: boolean }
export interface PackageJobEvent { job: string; kind: 'progress' | 'finished'; percent?: number; phase?: string; result?: string; error?: string }

export function formatBytes(n: number | null): string {
  if (n == null) return '—'
  const a = Math.abs(n)
  const s = a >= 1e9 ? `${formatNumber(Number((a / 1e9).toFixed(1)))} GB` : a >= 1e6 ? `${formatNumber(Math.round(a / 1e6))} MB` : `${formatNumber(Math.max(1, Math.round(a / 1e3)))} kB`
  return n < 0 ? t('bytes.freed', { size: s }) : s
}

/** Package service error → text. Its own messages are already written for people. */
export function packageErrorText(code: string): string {
  switch (code) {
    case 'not_authorized': return t('rec.err.notAuthorized')
    case 'cancelled': return ''
    case 'service_unavailable': return t('pkg.err.service')
    case 'invalid_argument': return t('pkg.err.invalid')
    case 'failed': return t('rec.err.default')
    default: return code.charAt(0).toUpperCase() + code.slice(1) + (/[.!]$/.test(code) ? '' : '.')
  }
}

import type { SyncStatus } from './syncNotices'
import type { CheckId, CheckResult, SnapshotInfo } from './recovery'
import { formatNumber, t } from '../i18n'

export interface DevicePolicies {
  version: string; update_ring: string | null; update_mode: string | null; maintenance_window: string | null
  lock_timeout_max_s: number | null; offline_access_days: number | null; usb_storage: string | null; bluetooth: boolean | null
  app_allowlist_size: number
}
export interface DeviceInfo {
  agent: boolean
  device: { hostname: string; os_version: string; arch: string; kernel_version: string; encrypted: boolean | null } | null
  managed: boolean
  org_name: string | null
  server: string | null
  last_check_in: number | null
  policies: DevicePolicies | null
}

/** Taskbar chip text: null when the device isn't managed (WSOS-MDM-007). */
export function managedLabel(info: DeviceInfo | null): string | null {
  if (!info?.managed) return null
  return info.policies?.update_ring ? t('mdm.managedRing', { ring: info.policies.update_ring }) : t('mdm.managed')
}

/** Policy → plain sentences for the management notice. Only what the policy actually sets. */
export function policyLines(p: DevicePolicies | null): string[] {
  if (!p) return []
  const out: string[] = []
  if (p.app_allowlist_size > 0) out.push(t('mdm.allowlist', { count: p.app_allowlist_size }))
  if (p.update_ring || p.update_mode) out.push(t('mdm.updates', { list: [p.update_ring && t('mdm.ring', { ring: p.update_ring }), p.update_mode && t('mdm.mode', { mode: p.update_mode }), p.maintenance_window && t('mdm.restarts', { window: p.maintenance_window })].filter(Boolean).join(', ') }))
  if (p.lock_timeout_max_s) out.push(t('mdm.lock', { min: Math.round(p.lock_timeout_max_s / 60) }))
  if (p.offline_access_days) out.push(t('mdm.offline', { days: p.offline_access_days }))
  if (p.usb_storage === 'block') out.push(t('mdm.usbBlocked'))
  else if (p.usb_storage === 'read_only') out.push(t('mdm.usbRO'))
  if (p.bluetooth === false) out.push(t('mdm.btOff'))
  return out
}

export interface LockSettings { timeout_s: number; max_s: number | null; choices: number[] }

export function lockChoiceLabel(s: number): string {
  if (s === 0) return t('time.never')
  if (s < 3600) return t('time.min', { n: Math.round(s / 60) })
  return s === 3600 ? t('time.hour') : t('time.hours', { n: formatNumber(Math.round(s / 360) / 10) })
}
export interface InstalledApp { id: string; name: string; generic_name: string | null; comment: string | null; icon: string | null; categories: string[]; keywords: string[] }

export type SignOutChoice = 'none' | 'export' | 'discard'

export interface CloudAccount { id: string; name: string | null; server_url: string; state?: string }
export type CloudResult<T> = { ok: true; value: T } | { ok: false; error: string }

declare global {
  interface Window { worksuite?: WorkSuiteApi }
}

const stub: WorkSuiteApi = {
  async authenticate(_user, password) {
    // Preview: the password "wrong" is rejected so the error state can be reviewed.
    if (password === 'wrong') return { ok: false, message: 'Incorrect password. Try again.' }
    return password.length > 0 ? { ok: true } : { ok: false, message: 'Enter your password.' }
  },
  async lock() {},
  async logout() {},
  async power() {},
  async launchApp() {},
  // Preview: the shipped default (5 min), no policy maximum.
  async lockSettings() { return { timeout_s: stubLock, max_s: null, choices: [60, 120, 300, 600, 900, 1800, 3600, 0] } },
  async setLockTimeout(s) { stubLock = s; return { ok: true, value: { timeout_s: s, max_s: null, choices: [60, 120, 300, 600, 900, 1800, 3600, 0] } } },
  async openLink() {},
  // Preview: signed out, so search says so instead of inventing results.
  async search(q) {
    const query = q.trim()
    return { query, sources: query ? [{ source: 'worksuite', state: 'not_signed_in', hits: [] }, { source: 'drive', state: 'not_signed_in', hits: [] }] : [], hits: [] }
  },
  async recentFiles() { return { local: [], cloud: { state: 'not_signed_in', hits: [] } } },
  async openSearchResult() { return { ok: true } },
  async webApps() { return { ok: false, error: 'not_signed_in' } },
  async installedApps() {
    return { apps: [
      { id: 'firefox-esr', name: 'Firefox ESR', generic_name: 'Web Browser', comment: null, icon: 'firefox-esr', categories: ['Network', 'WebBrowser'], keywords: ['internet', 'web'] },
      { id: 'foot', name: 'Foot', generic_name: 'Terminal', comment: null, icon: 'foot', categories: ['System', 'TerminalEmulator'], keywords: ['shell'] },
    ], office: null, desktop: null }
  },
  async launchOffice() {},
  async launchWorkSuite() {},
  async cloudSignIn(serverUrl, _mode) {
    stubAccounts = [{ id: 'preview:u-1', name: 'Hasarinda', server_url: serverUrl, state: 'signed_in' }]
    return { ok: true, value: stubAccounts[0] }
  },
  async cloudSignOut(id, choice) {
    stubAccounts = stubAccounts.filter((a) => a.id !== id)
    stubUnsent = 0
    return { ok: true, value: { exported: choice === 'export' ? '~/Documents/WorkSuite unsent changes.json' : null } }
  },
  async syncUnsent() { return { ok: true, value: stubUnsent } },
  async syncNow() { stubUnsent = Math.max(0, stubUnsent - 1); return { ok: true, value: true } },
  // Preview: offline with 14 pending, then back online on the second poll.
  async syncStatus() {
    stubPolls++
    return { ok: true, value: stubPolls < 2 ? { state: 'offline', pending: 14, failed: 0, conflicts: 0, last_sync: null } : { state: 'idle', pending: 0, failed: 0, conflicts: 0, last_sync: Date.now() } }
  },
  async enrollDevice(_url, code) {
    if (code === 'BAD-CODE') return { ok: false, error: 'enrollment_rejected' }
    stubManaged = true
    return { ok: true, value: { device_id: 'preview-device', org_name: 'Livezen Technologies' } }
  },
  async pkgPreview(id, op) {
    if (id.includes('nmap')) return { ok: false, error: 'not approved by your organization' }
    return { ok: true, value: {
      plan: { install: op === 'install' ? [{ name: id.split(':')[1], version: '' }] : [], upgrade: [], remove: op === 'remove' ? [{ name: id.split(':')[1], version: '' }] : [] },
      disk_bytes: op === 'install' ? 418_000_000 : -418_000_000,
      permissions: id.startsWith('flatpak:') ? ['shared=network;ipc;', 'filesystems=xdg-pictures;', 'sockets=x11;wayland;'] : [],
      broad: id.startsWith('flatpak:') ? ['sockets=x11;wayland;'] : [],
    } }
  },
  async pkgInstall(id) { return stubJob(id, 'install') },
  async pkgRemove(id) { return stubJob(id, 'remove') },
  async pkgApplyUpdate() { const r = stubJob('update', 'update'); setTimeout(() => { stubUpdates = { packages: [], flatpaks: [] } }, 800); return r },
  async pkgCheckUpdates() { return { ok: true, value: { ...stubUpdates, reboot_required: false, state: 'idle' } } },
  onPkgJob(cb) { stubListeners.add(cb); return () => { stubListeners.delete(cb) } },
  async updateStatus(check) {
    if (check) { stubOs = { ...stubOs, last_check: Date.now() }; stubOsListeners.forEach((l) => l(stubOs)) }
    return { ok: true, value: stubOs }
  },
  async updateDefer() {
    if ((stubOs.deferrals_left ?? 0) <= 0) return { ok: true, value: false }
    stubOs = { ...stubOs, state: 'waiting', reason: 'deferred', deferrals_left: (stubOs.deferrals_left ?? 1) - 1 }
    stubOsListeners.forEach((l) => l(stubOs)); return { ok: true, value: true }
  },
  async updateInstallNow() {
    stubOs = { ...stubOs, state: 'installing', reason: null }; stubOsListeners.forEach((l) => l(stubOs))
    setTimeout(() => { stubOs = { ...stubOs, state: 'ready_to_restart', installed: stubOs.version ?? stubOs.installed }; stubOsListeners.forEach((l) => l(stubOs)) }, 1200)
    return { ok: true, value: true }
  },
  onUpdateStatus(cb) { stubOsListeners.add(cb); return () => { stubOsListeners.delete(cb) } },
  async filesRoots() { return { roots: [{ id: 'home', label: 'Home' }, { id: 'media:KINGSTON', label: 'KINGSTON' }, { id: 'drive', label: 'WorkSuite Drive' }], drive_exists: true } },
  async filesList(root, rel) {
    const t = Date.now()
    const f = (name: string, state: string, size: number | null, local = true, dir = false): FileEntry => ({ name, dir, size, modified: local ? t - 3_600_000 : null, state, local })
    if (root === 'drive' && !rel) return { ok: true, value: [f('Tenders 2026', 'folder', null, true, true), f('Finance', 'folder', null, true, true), f('Handbook.pdf', 'synced', 1_200_000)] }
    if (root === 'drive') return { ok: true, value: [
      f('SFCL proposal v3.docx', 'syncing', 6_400_000), f('TSHDA bid — pricing.xlsx', 'synced', 212_000),
      f('TSHDA bid — pricing (conflict Hasarinda-laptop 2026-10-15).xlsx', 'conflict', 208_000),
      f('MBSL digital media tender.pdf', 'online-only', null, false), f('Care Me platform — clarifications.pdf', 'pending', 480_000),
      f('Site walk-through recording.mp4', 'error', 6_200_000_000) ] }
    if (!rel) return { ok: true, value: [f('Documents', 'local', null, true, true), f('Downloads', 'local', null, true, true), f('notes.txt', 'local', 2_000)] }
    return { ok: true, value: [f('Invoice INV-2026-0418.pdf', 'local', 182_000), f('worksuite-agent-2.4.1.zip', 'local', 38_200_000)] }
  },
  async filesOpen() { return { ok: true, value: true } },
  async filesStatus(root) { return { free_bytes: 212e9, drive: root === 'drive' ? { states: { synced: 2, syncing: 1, pending: 1, conflict: 1, 'online-only': 1, error: 1 }, last_sync: Date.now() - 60_000, service_state: 'idle' } : null } },
  async deviceInfo() {
    return {
      agent: true, managed: stubManaged, org_name: stubManaged ? 'Livezen Technologies' : null, server: stubManaged ? 'work.livezentech.com' : null, last_check_in: stubManaged ? Date.now() - 4 * 60_000 : null,
      device: { hostname: 'LZT-LAP-0142', os_version: 'WorkSuite OS 1.0 (preview)', arch: 'amd64', kernel_version: '6.12', encrypted: true },
      policies: !stubManaged ? null : { version: 'preview', update_ring: 'pilot', update_mode: 'automatic', maintenance_window: '02:00-04:00', lock_timeout_max_s: 300, offline_access_days: 7, usb_storage: 'read_only', bluetooth: null, app_allowlist_size: 42 },
    }
  },
  async cloudAccounts() { return { ok: true, value: stubAccounts } },
  async hwDevices() {
    if (stubSim === 'none') return { ok: false, error: 'unavailable' }
    const extra = PV.get('hw') === 'new' && Date.now() - stubStart > 3000 ? [STUB_NEW] : PV.get('hw') === 'problem' && Date.now() - stubStart > 3000 ? [{ ...STUB_NEW, driver: null, driver_version: null }] : []
    return { ok: true, value: [...STUB_DEVICES, ...extra] }
  },
  async hwDriverUpdates() { return PV.get('hw') === 'catalog' ? { ok: true, value: STUB_OFFERS } : { ok: false, error: 'unavailable' } },
  async hwInstallDrivers(ids) {
    if (PV.get('hw') !== 'catalog') return { ok: false, error: 'unavailable' }
    const job = `/lk/worksuite/PackageService1/job/${++stubJobId}`
    ids.forEach((id, i) => {
      setTimeout(() => stubListeners.forEach((l) => l({ job, kind: 'progress', percent: 100, phase: id })), 400 + i * 100)
      if (i === 1) setTimeout(() => stubListeners.forEach((l) => l({ job, kind: 'progress', percent: 62, phase: ids[1] })), 500)
    })
    return { ok: true, value: job }
  },
  async sysUsers() { return stubAvail({ current: 'preview', users: [{ login: 'preview', name: 'Preview User', uid: 1000, admin: true }, { login: 'second', name: 'Second User', uid: 1001, admin: false }] }) },
  async pkgRepair() { return stubJob('repair', 'repair') },
  // Browser preview: there is no package service or server here, so these answer honestly instead of inventing apps.
  async pkgCatalog() { return { ok: true, value: { state: 'not_enrolled', arch: 'amd64', items: [], error: 'Preview mode: no package service, so there is no app catalog.' } } },
  async pickFile() { return { ok: false, error: 'service_unavailable' } },
  async localDebPreview() { return { ok: false, error: 'service_unavailable' } },
  async localDebInstall() { return { ok: false, error: 'service_unavailable' } },
  async appPermissions() { return { ok: false, error: 'service_unavailable' } },
  async appPermissionsReset() { return { ok: false, error: 'service_unavailable' } },
  async appDataRemove() { return { ok: false, error: 'service_unavailable' } },
  async pruneRuntimes() { return { ok: false, error: 'service_unavailable' } },
  async bundleInspect() { return { ok: false, error: 'service_unavailable' } },
  async bundleInstall() { return { ok: false, error: 'service_unavailable' } },
  async appimageList() { return { ok: true, value: [] } },
  async appimageImport() { return { ok: false, error: 'service_unavailable' } },
  async appimageApprove() { return { ok: false, error: 'service_unavailable' } },
  async appimageRemove() { return { ok: false, error: 'service_unavailable' } },
  async appimageUpdate() { return { ok: false, error: 'service_unavailable' } },
  async appimageLaunch() { return { ok: false, error: 'service_unavailable' } },
  async recoveryInfo() {
    const all = stubSim !== 'none'
    return { os_version: '1.1', disk: 'vda', firmware: 'EFI', failures: all ? 3 : null,
      luks: stubSim === 'none' ? [] : [{ device: '/dev/vda2', name: 'vda2', label: 'WorkSuite', version: '2', size_bytes: 42_412_802_048, unlocked: false }],
      features: { unlock: all, repair: true, snapshots: all, reinstall: all, copy_usb: false, terminal: false, report_usb: false } }
  },
  async recoveryCheck(id) {
    await stubWait(id === 'packages' ? 1500 : 700)
    const preview: Record<CheckId, CheckResult> = {
      boot: { status: 'ok', note: 'Fine' }, disk: { status: 'ok', note: 'Fine' }, crypt: { status: 'ok', note: 'Unlocked' },
      packages: stubSim === 'none' ? { status: 'unavailable', note: 'Package service isn’t running' } : { status: 'problem', note: 'Interrupted package changes', fixable: true },
      drivers: { status: 'unavailable', note: 'Not checked in this version' },
      update: stubSim === 'none' ? { status: 'unavailable', note: 'Update service isn’t running' } : { status: 'ok', note: 'Version 1.1' },
    }
    return preview[id]
  },
  async recoveryUnlock(_device, secret) {
    await stubWait(600)
    // Preview: a key starting 00000 (or the passphrase "wrong") is refused so the error state can be reviewed.
    return secret.startsWith('00000') || secret === 'wrong' ? { ok: false, error: 'wrong_key' } : { ok: true, value: true }
  },
  async recoverySnapshots() {
    if (stubSim === 'none') return { ok: false, error: 'unavailable' }
    const at = (d: number, h: number, m: number) => { const t = new Date(); t.setDate(t.getDate() - d); t.setHours(h, m, 0, 0); return t.getTime() }
    return { ok: true, value: [
      { id: 'snap-4', title: 'Before update to 1.1', created: at(0, 2, 3), kind: 'automatic', os_version: '1.0', last_working: true },
      { id: 'snap-3', title: 'Weekly snapshot', created: at(4, 3, 0), kind: 'automatic', os_version: '1.0', last_working: false },
      { id: 'snap-2', title: 'Before installing Docs', created: at(7, 14, 22), kind: 'app install', os_version: '1.0', last_working: false },
      { id: 'snap-1', title: 'After first setup', created: at(14, 18, 40), kind: 'install', os_version: '1.0', last_working: false },
    ] }
  },
  async recoveryRestore() { await stubWait(800); return stubSim === 'none' ? { ok: false, error: 'unavailable' } : { ok: true, value: true } },
  async recoveryReinstall() { await stubWait(800); return stubSim === 'none' ? { ok: false, error: 'unavailable' } : { ok: true, value: true } },
  async recoveryCopyToUsb() { return { ok: false, error: 'unavailable' } },
  async recoveryTerminal() { return { ok: false, error: 'unavailable' } },
  async recoverySaveReport() { return { ok: false, error: 'unavailable' } },
  // Preview only: simulated host state; `?sim=none` shows every area as unavailable.
  async sysNetwork() { return stubAvail({ ...stubSys.net, networks: stubSys.net.wifi_enabled ? stubSys.net.networks : [] }) },
  async sysSetWifi(on) { stubSys.net.wifi_enabled = on; return stubAvail(true as const) },
  async sysWifiConnect(ssid, password) {
    await stubWait(700)
    if (password === 'wrong') return { ok: false, error: 'bad_password' }
    stubSys.net.networks = stubSys.net.networks.map((n) => ({ ...n, in_use: n.ssid === ssid }))
    return { ok: true }
  },
  async sysVpn() { return stubAvail({ connections: stubSys.vpn, user_vpn_allowed: true, vpn_required: false }) },
  async sysVpnImport() { return { ok: false, error: 'service_unavailable' } },
  async sysVpnImportOpenvpn() { return { ok: false, error: 'service_unavailable' } },
  async sysVpnConnect(uuid, on) { stubSys.vpn = stubSys.vpn.map((c) => c.uuid === uuid ? { ...c, active: on } : c); return stubAvail(true as const) },
  async sysVpnRemove(uuid) { stubSys.vpn = stubSys.vpn.filter((c) => c.uuid !== uuid || c.managed); return stubAvail(true as const) },
  async sysBluetooth() { return stubAvail(stubSys.bt) },
  async sysSetBluetooth(on) { stubSys.bt.powered = on; return stubAvail(true as const) },
  async sysBtConnect(address, on) { stubSys.bt.paired = stubSys.bt.paired.map((d) => d.address === address ? { ...d, connected: on } : d); return stubAvail(true as const) },
  async sysSound() { return stubAvail(stubSys.sound) },
  async sysSetVolume(p) { stubSys.sound.volume = Math.max(0, Math.min(100, Math.round(p))); return stubAvail(true as const) },
  async sysSetMute(m) { stubSys.sound.muted = m; return stubAvail(true as const) },
  async sysSetDefaultAudio(id) { stubSys.sound.outputs = stubSys.sound.outputs.map((o) => ({ ...o, is_default: o.id === id })); return stubAvail(true as const) },
  async sysBattery() { return stubAvail({ present: true, percentage: 74, state: 'charging', time_to_full_s: 4800, time_to_empty_s: null, on_battery: false }) },
  async sysPrinters() { return stubAvail([{ name: 'HP_LaserJet_M507_Floor3', state: 'idle', is_default: true }] as Printer[]) },
  async sysDisplays() { return stubAvail([{ name: 'eDP-1', description: 'Built-in display', enabled: true, width: 1920, height: 1200, refresh: 60, scale: 1 }]) },
  async sysDisks() { return stubAvail([{ model: 'Preview NVMe SSD', serial: 'PREVIEW0001', device: 'nvme0n1' }]) },
}

function stubAvail<T>(value: T): Avail<T> {
  return stubSim === 'none' ? { available: false, reason: 'service_unavailable' } : { available: true, value: structuredClone(value) }
}
const stubSys: { net: NetworkState; bt: BluetoothState; sound: SoundState; vpn: VpnConnection[] } = {
  vpn: [{ name: 'WorkSuite VPN', uuid: '6f1d9a52-3c47-4b8e-9a0d-57e2c1b4f0a3', type: 'wireguard', kind: 'wireguard', active: true, device: 'wsvpn0', managed: true, needs_credentials: false }],
  net: { wifi_enabled: true, devices: [{ device: 'wlan0', type: 'wifi', state: 'connected', connection: 'Preview-WiFi' }, { device: 'eth0', type: 'ethernet', state: 'unavailable', connection: null }],
    networks: [{ ssid: 'Preview-WiFi', signal: 82, security: 'WPA2', in_use: true }, { ssid: 'Guest', signal: 54, security: '', in_use: false }] },
  bt: { powered: false, name: 'preview-laptop', discoverable: false, paired: [{ address: 'AA:BB:CC:DD:EE:01', name: 'Preview keyboard', connected: false }] },
  sound: { volume: 60, muted: false, outputs: [{ id: 46, name: 'Built-in speakers', is_default: true }, { id: 51, name: 'HDMI output', is_default: false }], inputs: [{ id: 47, name: 'Built-in microphone', is_default: true }] },
}

// Preview only: `?sim=none` shows the recovery screens as on a host where none of the optional services exist.
const stubSim = typeof location !== 'undefined' ? new URLSearchParams(location.search).get('sim') ?? 'preview' : 'preview'
const stubWait = (ms: number) => new Promise((r) => setTimeout(r, ms))

let stubLock = 300
// Browser preview only (never in Electron): ?upd=available|downloading|ready|forced|failed|whatsnew|uptodate,
// ?hw=catalog|new|problem, ?sim=none drive the stub into each board's state.
const PV = new URLSearchParams(typeof location === 'undefined' ? '' : location.search)
const stubStart = Date.now()
const dev = (id: string, name: string, vendor: string | null, kind: HwKind, bus: 'usb' | 'pci', driver: string | null, extra: Partial<HwDevice> = {}): HwDevice =>
  ({ id, name, vendor, kind, bus, built_in: bus === 'pci', driver, driver_version: null, driver_proprietary: driver ? false : null, ids: '0000:0000', ...extra })
const STUB_DEVICES: HwDevice[] = [
  dev('usb:1-1', 'USB Keyboard', 'Preview', 'keyboard', 'usb', 'usbhid'),
  dev('usb:1-3', 'USB Printer', 'Preview', 'printer', 'usb', 'usblp'),
  dev('pci:0000:00:14.3', 'Wireless adapter', 'Preview', 'wireless', 'pci', 'iwlwifi'),
  dev('pci:0000:00:02.0', 'Integrated graphics', 'Preview', 'graphics', 'pci', 'i915'),
  dev('pci:0000:00:1f.3', 'Audio controller', 'Preview', 'audio', 'pci', 'snd_hda_intel'),
]
const STUB_NEW = dev('usb:1-2', 'USB Camera', 'Preview', 'camera', 'usb', 'uvcvideo', { driver_version: '1.1.1' })
const STUB_OFFERS: DriverOffer[] = [
  { id: 'drv-gfx', device_id: 'pci:0000:00:02.0', name: 'Graphics driver (preview)', summary: 'Preview catalog entry', from_version: '1.0', to_version: '1.1', license: 'proprietary', category: 'optional', size_bytes: 140e6, restart: true },
  { id: 'drv-cam', device_id: 'usb:1-2', name: 'Camera driver (preview)', summary: 'Preview catalog entry', from_version: null, to_version: '2.0', license: 'open', category: 'recommended', size_bytes: 4e6, restart: false },
  { id: 'drv-wifi', device_id: 'pci:0000:00:14.3', name: 'Wi-Fi firmware (preview)', summary: 'Preview catalog entry', from_version: '83', to_version: '86', license: 'open', category: 'security', size_bytes: 2e6, restart: false },
]

let stubAccounts: CloudAccount[] = []
// Preview only: package jobs finish after a short delay.
const stubListeners = new Set<(e: PackageJobEvent) => void>()
let stubJobId = 0
// Preview: a mandatory security release waiting for the user.
let stubOs: OsUpdateStatus = stubUpdateState(PV.get('upd'))
function stubUpdateState(k: string | null): OsUpdateStatus {
  const base: OsUpdateStatus = { state: 'waiting', version: '1.0.3', installed: '1.0.2', release_id: 'os-1.0.3', mandatory: true,
    deadline: new Date(Date.now() + 2 * 86_400_000).toISOString(), deferrals_left: 2, reason: 'waiting_for_user', restart_at: null, last_check: Date.now() - 3_600_000 }
  const opt = { ...base, mandatory: false, deadline: null, deferrals_left: null }
  switch (k) {
    case 'available': return opt
    case 'downloading': return { ...opt, state: 'installing', reason: null }
    case 'ready': return { ...opt, state: 'ready_to_restart', installed: '1.0.3', reason: null }
    case 'forced': return { ...base, state: 'restart_pending', reason: 'deadline', restart_at: Date.now() + 60_000 }
    case 'failed': return { ...opt, state: 'installing', reason: null }
    case 'whatsnew': return { ...opt, state: 'up_to_date', installed: '1.0.3', version: '1.0.3', reason: null }
    case 'uptodate': return { ...opt, state: 'up_to_date', version: null, installed: '1.0.2', release_id: null, reason: null }
    default: return base
  }
}
// Preview: drive the update job the way the package service does (JobProgress phases, then a status change).
if (typeof window !== 'undefined') {
  const k = PV.get('upd')
  const job = '/lk/worksuite/PackageService1/job/90'
  const emitJob = (percent: number, phase: string) => stubListeners.forEach((l) => l({ job, kind: 'progress', percent, phase }))
  const setOs = (p: Partial<OsUpdateStatus>) => { stubOs = { ...stubOs, ...p }; stubOsListeners.forEach((l) => l(stubOs)) }
  if (k === 'downloading') setTimeout(() => emitJob(41, 'downloading'), 400)
  if (k === 'forced') { setTimeout(() => setOs({ state: 'installing', reason: null, restart_at: null }), 600); setTimeout(() => emitJob(50, 'applying'), 800) }
  if (k === 'failed') { setTimeout(() => emitJob(50, 'applying'), 400); setTimeout(() => setOs({ state: 'failed', reason: 'dpkg: error processing package linux-image-6.12 (--configure)' }), 700) }
}
const stubOsListeners = new Set<(s: OsUpdateStatus) => void>()
let stubUpdates = { packages: ['firefox-esr', 'libc6', 'openssl'], flatpaks: ['org.gimp.GIMP'] }
function stubJob(_id: string, _kind: string): CloudResult<string> {
  const job = `/lk/worksuite/PackageService1/job/${++stubJobId}`
  setTimeout(() => stubListeners.forEach((l) => l({ job, kind: 'progress', percent: 50, phase: 'installing' })), 300)
  setTimeout(() => stubListeners.forEach((l) => l({ job, kind: 'finished', result: 'success' })), 900)
  return { ok: true, value: job }
}
// Preview only: pretend three offline edits are waiting so the sign-out prompt can be seen.
let stubUnsent = 3
let stubPolls = 0
// Preview only: unmanaged until enrolled (first-run or Settings).
let stubManaged = false

/** Broker error codes → text for the user. */
export function cloudErrorText(code: string): string {
  switch (code) {
    case 'discovery_failed': return t('cloud.err.discovery')
    case 'insecure_url': return t('cloud.err.insecure')
    case 'sign_in_timeout': return t('cloud.err.timeout')
    case 'access_denied': return t('cloud.err.denied')
    case 'broker_unavailable': return t('cloud.err.broker')
    case 'device_not_enrolled': return t('cloud.err.notEnrolled')
    case 'bootstrap_failed':
    case 'bootstrap_invalid': return t('cloud.err.bootstrap')
    case 'auth_cancelled': return t('cloud.err.authCancelled')
    case 'enrollment_rejected': return t('cloud.err.rejected')
    case 'invalid_code': return t('cloud.err.code')
    case 'agent_unavailable': return t('cloud.err.agent')
    case 'export_failed': return t('cloud.err.export')
    default: return t('cloud.err.default')
  }
}

/** "work.example.com" → "https://work.example.com"; personal mode uses WorkSuite Cloud. */
export function serverUrlFor(mode: 'personal' | 'enterprise', server: string): string {
  if (mode === 'personal') return 'https://worksuitecloud.com'
  const s = server.trim()
  return /^[a-z]+:\/\//i.test(s) ? s : `https://${s}`
}

export const os: WorkSuiteApi = (typeof window !== 'undefined' && window.worksuite) || stub

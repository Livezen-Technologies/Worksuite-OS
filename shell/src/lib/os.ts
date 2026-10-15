// Typed renderer API. In Electron the preload exposes `window.worksuite` with named functions only
// (WSOS-SEC-001, §10.3); in a plain browser (dev/design review) a local stub answers instead.
export interface WorkSuiteApi {
  authenticate(user: string, password: string): Promise<{ ok: boolean; message?: string }>
  lock(): Promise<void>
  logout(): Promise<void>
  power(action: 'suspend' | 'restart' | 'shutdown'): Promise<void>
  launchApp(appId: string): Promise<void>
  openLink(url: string): Promise<void>
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
  /** Package repair (§9.2): finishes interrupted dpkg/apt changes; result arrives through onPkgJob. */
  pkgRepair(): Promise<CloudResult<string>>
  /** Organization app catalog from the server via the package service (WSOS-APP-001). Never sample data. */
  pkgCatalog(): Promise<CloudResult<AppCatalog>>
  /** Native file dialog; returns an opaque handle the other calls accept (the renderer never names paths). */
  pickFile(kind: 'deb' | 'appimage' | 'wsupdate'): Promise<CloudResult<{ handle: string; name: string }>>
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
}

export type RecoveryFeature = 'unlock' | 'repair' | 'snapshots' | 'reinstall' | 'copy_usb' | 'terminal' | 'report_usb'
export interface RecoveryLuksDevice { device: string; name: string; label: string | null; version: string | null; size_bytes: number | null; unlocked: boolean }
export interface RecoveryInfo {
  os_version: string | null; disk: string | null; firmware: 'EFI' | 'BIOS'
  /** Shell restarts counted by systemd before recovery opened; null when unknown. */
  failures: number | null
  luks: RecoveryLuksDevice[]; features: Record<RecoveryFeature, boolean>
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
  const s = a >= 1e9 ? `${(a / 1e9).toFixed(1)} GB` : a >= 1e6 ? `${Math.round(a / 1e6)} MB` : `${Math.max(1, Math.round(a / 1e3))} kB`
  return n < 0 ? `${s} freed` : s
}

/** Package service error → text. Its own messages are already written for people. */
export function packageErrorText(code: string): string {
  switch (code) {
    case 'not_authorized': return 'An administrator password is needed for this. Nothing was changed.'
    case 'cancelled': return ''
    case 'service_unavailable': return 'The package service isn’t running. Try again in a moment.'
    case 'invalid_argument': return 'This app can’t be installed from here.'
    case 'failed': return 'That didn’t work. Nothing was changed.'
    default: return code.charAt(0).toUpperCase() + code.slice(1) + (/[.!]$/.test(code) ? '' : '.')
  }
}

import type { SyncStatus } from './syncNotices'
import type { CheckId, CheckResult, SnapshotInfo } from './recovery'

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
  return info.policies?.update_ring ? `Managed · ${info.policies.update_ring} ring` : 'Managed'
}

/** Policy → plain sentences for the management notice. Only what the policy actually sets. */
export function policyLines(p: DevicePolicies | null): string[] {
  if (!p) return []
  const out: string[] = []
  if (p.app_allowlist_size > 0) out.push(`Only approved apps can be installed (${p.app_allowlist_size} approved)`)
  if (p.update_ring || p.update_mode) out.push(`Updates: ${[p.update_ring && `${p.update_ring} ring`, p.update_mode && `${p.update_mode} mode`].filter(Boolean).join(', ')}${p.maintenance_window ? `, restarts ${p.maintenance_window}` : ''}`)
  if (p.lock_timeout_max_s) out.push(`Screen locks after at most ${Math.round(p.lock_timeout_max_s / 60)} min idle`)
  if (p.offline_access_days) out.push(`Offline sign-in allowed for ${p.offline_access_days} days`)
  if (p.usb_storage === 'block') out.push('USB storage is blocked')
  else if (p.usb_storage === 'read_only') out.push('USB storage is read-only')
  if (p.bluetooth === false) out.push('Bluetooth is turned off')
  return out
}

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
  async openLink() {},
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
}

// Preview only: `?sim=none` shows the recovery screens as on a host where none of the optional services exist.
const stubSim = typeof location !== 'undefined' ? new URLSearchParams(location.search).get('sim') ?? 'preview' : 'preview'
const stubWait = (ms: number) => new Promise((r) => setTimeout(r, ms))

let stubAccounts: CloudAccount[] = []
// Preview only: package jobs finish after a short delay.
const stubListeners = new Set<(e: PackageJobEvent) => void>()
let stubJobId = 0
// Preview: a mandatory security release waiting for the user.
let stubOs: OsUpdateStatus = { state: 'waiting', version: '1.0.3', installed: '1.0.2', release_id: 'os-1.0.3', mandatory: true,
  deadline: new Date(Date.now() + 2 * 86_400_000).toISOString(), deferrals_left: 2, reason: 'waiting_for_user', restart_at: null, last_check: Date.now() - 3_600_000 }
const stubOsListeners = new Set<(s: OsUpdateStatus) => void>()
let stubUpdates = { packages: ['firefox-esr', 'libreoffice', 'libc6', 'openssl'], flatpaks: ['org.gimp.GIMP'] }
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
    case 'discovery_failed': return 'That server didn’t answer as a WorkSuite server. Check the address.'
    case 'insecure_url': return 'The server must use https.'
    case 'sign_in_timeout': return 'Sign-in wasn’t finished in the browser. Try again.'
    case 'access_denied': return 'Sign-in was cancelled.'
    case 'broker_unavailable': return 'The sign-in service isn’t running. Try again in a moment.'
    case 'device_not_enrolled': return 'This computer isn’t enrolled with your organization yet. Ask IT to enroll it, then sign in again.'
    case 'bootstrap_failed':
    case 'bootstrap_invalid': return 'Signed in, but WorkSuite couldn’t load your organization’s settings. Try again.'
    case 'auth_cancelled': return 'Enrollment needs an administrator password. Nothing was changed.'
    case 'enrollment_rejected': return 'The server didn’t accept that enrollment code. Check it with your IT admin; codes expire quickly.'
    case 'invalid_code': return 'Enter the enrollment code exactly as your IT admin gave it.'
    case 'agent_unavailable': return 'The device agent isn’t running, so this computer can’t be enrolled right now.'
    case 'export_failed': return 'Couldn’t save the unsent changes. Nothing was signed out.'
    default: return 'Sign-in didn’t work. Check your connection and try again.'
  }
}

/** "work.example.com" → "https://work.example.com"; personal mode uses WorkSuite Cloud. */
export function serverUrlFor(mode: 'personal' | 'enterprise', server: string): string {
  if (mode === 'personal') return 'https://worksuitecloud.com'
  const s = server.trim()
  return /^[a-z]+:\/\//i.test(s) ? s : `https://${s}`
}

export const os: WorkSuiteApi = (typeof window !== 'undefined' && window.worksuite) || stub

// Typed renderer API. In Electron the preload exposes `window.worksuite` with named functions only
// (WSOS-SEC-001, §10.3); in a plain browser (dev/design review) a local stub answers instead.
export interface WorkSuiteApi {
  /** method 'pin' sends the PIN where the password goes; 'key' sends no secret (pam_u2f asks for a touch). */
  authenticate(user: string, password: string, method?: SignInMethod): Promise<{ ok: boolean; message?: string }>
  /** Locks through the system locker; true when it took the screen (the shell then shows no lock board of its own). */
  lock(): Promise<boolean>
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
  /** Desktop widgets' data (WorkSuite Desktop's Home), fetched and cached by the main process; never a token. */
  widgets(): Promise<WidgetsSnapshot>
  /** Open a search result (worksuite:// or file://), or its location. */
  openSearchResult(link: string, where?: 'open' | 'location'): Promise<{ ok: boolean; error?: string }>
  /** WorkSuite web apps the org has enabled (from bootstrap via the broker); an error when not signed in/offline. */
  webApps(): Promise<CloudResult<{ id: string; name: string; offline_level?: 'full_offline' | 'cached_read' | 'online_only' }[]> & { cached?: true }>
  /** The user's synced shell preferences (favourites, taskbar pins, order); null when none are saved. */
  shellPrefs(): Promise<CloudResult<unknown>>
  setShellPrefs(prefs: unknown): Promise<CloudResult<boolean>>
  /** Installed applications from XDG desktop entries, and the detected WorkSuite Office entry id (null if absent). */
  /** App icons for desktop entries' Icon= values at a size (CSS px) and scale: data: URLs, null when none exists. */
  appIcons?(names: string[], size: number, scale: number): Promise<Record<string, string | null>>
  installedApps(): Promise<{ apps: InstalledApp[]; office: string | null; desktop?: string | null }>
  /** WorkSuite Office: 'start' (start centre) or a new 'docs' | 'sheets' | 'slides' document. */
  launchOffice(kind: 'start' | 'docs' | 'sheets' | 'slides'): Promise<void>
  /** WorkSuite Desktop with --module=<id> (only when installed; the launcher checks). */
  launchWorkSuite(module: DesktopModule): Promise<void>
  // WorkSuite cloud identity through the credentials broker (SRS §8.1). Tokens never reach the renderer.
  cloudSignIn(serverUrl: string, mode: 'personal' | 'enterprise'): Promise<CloudResult<CloudAccount>>
  /** Stop a sign-in that is waiting for the browser; its cloudSignIn then fails with sign_in_cancelled. */
  cloudSignInCancel(): Promise<CloudResult<boolean>>
  /** choice: 'none' when nothing is unsent; 'export' or 'discard' otherwise ("wait" = syncNow, then 'none'). */
  cloudSignOut(accountId: string, choice: SignOutChoice): Promise<CloudResult<{ exported: string | null }>>
  syncUnsent(accountId: string): Promise<CloudResult<number>>
  syncNow(): Promise<CloudResult<unknown>>
  /** Sync service Status: state (idle|syncing|offline|auth_required|device_revoked|stopped), pending, failed, conflicts, last_sync. */
  syncStatus(): Promise<CloudResult<SyncStatus>>
  cloudAccounts(): Promise<CloudResult<CloudAccount[]>>
  /** Settings > About this device (WSOS-MDM-007, WSOS-WIPE-007): device agent status, or local facts when it isn't running. */
  deviceInfo(): Promise<DeviceInfo>
  /** WorkSuite Security (#20): the device agent's security status; null when it is not available. */
  securityStatus(): Promise<SecurityStatus | null>
  /** Scan now through the device agent (polkit lk.worksuite.security.scan). */
  securityScan(kind: 'quick' | 'full'): Promise<CloudResult<unknown>>
  /** #38 quarantine and suspended programs (polkit lk.worksuite.security.quarantine, an administrator):
   *  RestoreQuarantined(id) (re-scanned first) | DeleteQuarantined(id) | ResolveSuspendedProcess(eventId, resume|terminate). */
  securityAction(method: 'RestoreQuarantined' | 'DeleteQuarantined' | 'ResolveSuspendedProcess', ...args: string[]): Promise<CloudResult<unknown>>
  onSecurityChanged(cb: (s: SecurityStatus) => void): () => void
  /** Employee monitoring (#22): policy, disclosure state and this user's own recorded days. */
  activityStatus(): Promise<ActivityStatus>
  /** The user has read the monitoring disclosure. */
  activityAck(): Promise<ActivityStatus>
  /** What the organization's server holds about this user. */
  activityRemote(): Promise<CloudResult<ActivityRemote>>
  onActivityChanged(cb: (s: ActivityStatus) => void): () => void
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
  /** Sidebar: user name, XDG home folders that exist, removable media and the home disk's usage. */
  filesPlaces(): Promise<FilePlaces>
  /** Starred items (~/.config/worksuite/starred.json) as "root:rel" keys and as hits. */
  filesStarred(): Promise<{ keys: string[]; hits: FileHit[] }>
  filesStar(root: string, rel: string, on: boolean): Promise<CloudResult<string[]>>
  /** Recently used files under Home (XDG recently-used.xbel). */
  filesRecent(): Promise<FileHit[]>
  /** File-name search below root/rel; kind 'any' | 'documents' | 'spreadsheets'; days 0 = any time. */
  filesSearch(root: string, rel: string, q: string, kind: string, days: number): Promise<CloudResult<{ hits: FileHit[]; ms: number; truncated: boolean }>>
  filesMkdir(root: string, rel: string, name: string): Promise<CloudResult<string>>
  /** The XDG Desktop folder relative to home (created if missing). */
  desktopDir?(): Promise<CloudResult<string>>
  /** File names in ~/Templates, offered under the desktop menu's "New". */
  filesTemplates?(): Promise<string[]>
  /** A new empty file (template null) or a copy of a template; never overwrites. */
  filesNewFile?(root: string, rel: string, name: string, template: string | null): Promise<CloudResult<string>>
  filesRename(root: string, rel: string, name: string): Promise<CloudResult<string>>
  /** Move to the freedesktop.org Trash. */
  filesTrash(root: string, rels: string[]): Promise<CloudResult<{ count: number; ids: string[] }>>
  /** Shift+Delete: remove for good, skipping the Trash (FO3). */
  filesDelete(root: string, rels: string[]): Promise<CloudResult<number>>
  /** "Notify me when done" (FO1): a text notice in the shell's notification centre. */
  filesNotify(summary: string, body: string): Promise<unknown>
  /** worksuite-toasts runs: toasts go there (a layer-shell surface over the apps) instead of the shell's window. */
  toastsAvailable?(): Promise<boolean>
  toastShow?(t: { key: string; title: string; body?: string; tone?: 'ok' | 'warn' | 'error'; icon?: string | null }): Promise<boolean>
  filesTrashList(): Promise<TrashItem[]>
  filesTrashRestore(ids: string[]): Promise<CloudResult<{ restored: number; skipped: number }>>
  filesTrashDelete(ids: string[] | 'all'): Promise<CloudResult<number>>
  /** Start a copy/move/duplicate job; progress and conflicts arrive through onFilesJob. */
  /** Files dropped from another app: copied into root/rel; paths outside the user's places are rejected. */
  filesDrop(paths: string[], dstRoot: string, dstRel: string): Promise<CloudResult<{ jobs: number; rejected: number }>>
  /** Drag files out to another app (native drag with the real paths). */
  filesStartDrag(root: string, rels: string[]): Promise<CloudResult<number>>
  pathForFile(f: File): string
  filesPaste(op: 'copy' | 'move' | 'duplicate', srcRoot: string, rels: string[], dstRoot: string, dstRel: string): Promise<CloudResult<string>>
  /** Answer a job: conflict (replace/skip/keep), error (retry/skip), pause/resume (copy and move), or cancel. */
  filesResolve(id: string, r: 'replace' | 'skip' | 'keep' | 'cancel' | 'continue' | 'retry' | 'pause' | 'resume', all: boolean): Promise<CloudResult<true>>
  /** Start a compress job (zip / 7z / tar.gz / tar.xz; a password for zip and 7z only); progress arrives through onFilesJob. */
  filesCompress(root: string, rels: string[], opts: CompressOptions): Promise<CloudResult<string>>
  /** Start an extract job: "here" or into "<name>/", all entries or the given ones. */
  filesExtract(root: string, rel: string, mode: 'here' | 'folder', items: string[], password: string | null): Promise<CloudResult<string>>
  /** Answer a job's password prompt; null cancels the job. */
  filesArchivePassword(id: string, pw: string | null): Promise<CloudResult<true>>
  /** An archive's entries, read-only. Errors: password, wrong_password, tool_missing, password_unsupported, failed. */
  filesArchiveList(root: string, rel: string, password: string | null): Promise<CloudResult<ArchiveListing>>
  /** An archive opened with Files from elsewhere (default handler for archive types). */
  onOpenArchive(cb: (at: { root: string; rel: string }) => void): () => void
  filesEject(id: string): Promise<CloudResult<true>>
  onFilesJob(cb: (e: FileJob) => void): () => void
  // Settings › Devices: real devices from sysfs (electron/hardware.ts).
  hwDevices(): Promise<CloudResult<HwDevice[]>>
  /** Settings › Drivers: the package service's report (devices with their driver status, offers found online).
   *  check = look online now (waits for the result). */
  hwDriverReport(check?: boolean): Promise<CloudResult<DriverReport>>
  /** Install driver offers (administrator, polkit); progress arrives through onPkgJob with phase "<offer id>|<step>". */
  hwInstallDrivers(ids: string[]): Promise<CloudResult<string>>
  /** The one-time Secure Boot password for MokManager: administrators only (polkit prompt); '' when none. */
  hwMokPassword(): Promise<CloudResult<string>>
  /** The package service found drivers (after Wi-Fi or Ethernet connected, daily, or a check). */
  onDriversChanged(cb: (r: DriverReport) => void): () => void
  /** A notice in the notification centre; clicking it opens Settings › Drivers (onOpenSettings). */
  driversNotify(summary: string, body: string): Promise<unknown>
  onOpenSettings(cb: (section: string) => void): () => void
  /** NetworkManager, BlueZ or UPower signalled a change ('network' | 'bluetooth' | 'battery'; electron/sysWatch.ts). */
  onSysChanged?(cb: (kind: string) => void): () => void
  /** Settings › Users: accounts on this computer (electron/users.ts). */
  sysUsers(): Promise<Avail<{ current: string; users: LocalUser[] }>>
  /** Settings › Users › Sign-in options: this device's PIN and security keys (electron/signin.ts). Changes go
   *  through pkexec (the person types their password); the PIN travels on stdin only. */
  signinMethods(): Promise<Avail<SignInMethods>>
  signinPinSet(pin: string): Promise<SigninResult>
  signinPinRemove(): Promise<SigninResult>
  signinKeyAdd(name: string): Promise<SigninResult>
  signinKeyRemove(id: string): Promise<SigninResult>
  signinSetDefault(method: SignInMethod): Promise<SigninResult>
  /** Package repair (§9.2): finishes interrupted dpkg/apt changes; result arrives through onPkgJob. */
  pkgRepair(): Promise<CloudResult<string>>
  /** WSOS-APT-006: package service state; 'interrupted' means an interrupted dpkg run needs Repair. */
  pkgState(): Promise<CloudResult<'idle' | 'busy' | 'interrupted'>>
  /** §11.6-d Report a problem: collect (nothing leaves the computer), then save or send only the sections kept. */
  reportCollect(): Promise<CloudResult<ProblemReport>>
  reportSave(id: string, keep: string[], description: string): Promise<CloudResult<string>>
  reportSend(id: string, keep: string[], description: string): Promise<CloudResult<string>>
  /** Organization app catalog from the server via the package service (WSOS-APP-001). Never sample data. */
  pkgCatalog(): Promise<CloudResult<AppCatalog>>
  /** Software Management: ask the organization to approve installing a catalog app (policy software_install = request). */
  pkgRequestApp(catalogId: string, reason: string): Promise<CloudResult<AppRequest>>
  /** Update Manager: installed, failed and pending updates (OS, drivers, firmware, apps). */
  updateHistory(): Promise<CloudResult<UpdateHistory>>
  /** Flatpak apps with an update, and updating them (empty list = all); a job like pkgInstall. */
  appUpdates(): Promise<CloudResult<AppUpdate[]>>
  updateApps(ids: string[]): Promise<CloudResult<string>>
  /** Native file dialog; returns an opaque handle the other calls accept (the renderer never names paths). */
  pickFile(kind: 'deb' | 'appimage' | 'wsupdate' | 'wgconf' | 'ovpn'): Promise<CloudResult<{ handle: string; name: string }>>
  localDebPreview(handle: string): Promise<CloudResult<LocalDebPreview>>
  localDebInstall(token: string): Promise<CloudResult<string>>
  appPermissions(catalogId: string): Promise<CloudResult<AppPermissions>>
  appPermissionsReset(catalogId: string): Promise<CloudResult<string>>
  /** G09: declared permissions this user switched off, and one switch (flatpak override --user). Optional: older bridges lack them. */
  appPermsUserOff?(catalogId: string): Promise<CloudResult<string[]>>
  appPermSet?(catalogId: string, perm: string, on: boolean): Promise<CloudResult<true>>
  appDataRemove(catalogId: string): Promise<CloudResult<boolean>>
  pruneRuntimes(): Promise<CloudResult<string>>
  bundleInspect(handle: string): Promise<CloudResult<BundleInfo>>
  bundleInstall(handle: string): Promise<CloudResult<string>>
  /** G14: .wsupdate bundles at the top level of mounted USB drives, as pickFile-style handles. */
  findBundles(): Promise<CloudResult<FoundBundle[]>>
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
  recoveryReinstall(mode: 'keep' | 'erase', confirm?: string): Promise<CloudResult<true>>
  recoveryCopyToUsb(): Promise<CloudResult<true>>
  recoveryTerminal(): Promise<CloudResult<true>>
  recoverySaveReport(text: string): Promise<CloudResult<string>>
  // Settings → host services (WSOS-INT-001…006, DSK-006). `available: false` means the tool/service isn't there.
  sysNetwork(): Promise<Avail<NetworkState>>
  sysSetWifi(on: boolean): Promise<Avail<true>>
  /** The password reaches nmcli on stdin only. */
  sysWifiConnect(ssid: string, password: string): Promise<{ ok: true; pending?: boolean } | { ok: false; error: string }>
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
  /** Starts a Wi-Fi scan; results come with the next sysNetwork(). */
  sysWifiRescan(): Promise<Avail<true>>
  /** Disconnects from the Wi-Fi network in use ('not_connected' when there is none). */
  sysWifiDisconnect(): Promise<Avail<true>>
  /** #31: adapters, drivers, radio switches and services behind Wi-Fi or Bluetooth, with the problems found. */
  radioDiagnose(kind: RadioKind): Promise<CloudResult<RadioDiagnosis & { text: string }>>
  /** Unblocks the radio (rfkill) or restarts its service (an administrator confirms). */
  radioFix(kind: RadioKind, fix: Exclude<RadioFix, 'find_driver'>): Promise<CloudResult<true>>
  /** #16: GPU, drivers, graphics APIs and what renders the desktop and the apps. */
  graphics(): Promise<CloudResult<GraphicsState>>
  /** Renderer for the desktop from the next sign-in. */
  graphicsSetRenderer(choice: RendererChoice): Promise<CloudResult<true>>
  /** Forgets an automatic fallback to software rendering, so the next sign-in tries the GPU again. */
  graphicsReset(): Promise<CloudResult<true>>
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
export interface WifiNetwork { ssid: string; signal: number; security: string; in_use: boolean; saved?: boolean }
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
  /** Entered by hand from the boot menu (electron/recovery.ts). */
  manual?: boolean
  luks: RecoveryLuksDevice[]; features: Record<RecoveryFeature, boolean>
}

import { withAppCenterPreview } from './appcenterPreview'
import type { DesktopModule } from './launcher'
import type { HwDevice, HwKind } from '../../electron/hardware'
import type { RadioDiagnosis, RadioFix, RadioKind } from '../../electron/radios'
import type { GraphicsState, RendererChoice } from '../../electron/graphics'
import type { LocalUser } from '../../electron/users'
import type { SecurityKey, SignInMethod, SignInMethods, SigninResult } from '../../electron/signin'
import type { SearchHit, SearchResponse, SourceState } from '../../electron/search'
import { emptySnapshot, ymd, type WidgetsSnapshot } from '../../electron/widgets'
export type { HwDevice, HwKind, LocalUser, SecurityKey, SignInMethod, SignInMethods, SigninResult }
export interface DriverOffer {
  id: string; device_id: string | null; name: string
  /** A code the shell words (firmware_missing, nvidia_better, nvidia_secure_boot, dkms_optional, …) or fwupd's text. */
  summary: string
  from_version: string | null; to_version: string
  license: 'open' | 'proprietary'; category: 'security' | 'recommended' | 'optional'
  size_bytes: number | null; restart: boolean
  kind?: 'firmware' | 'dkms' | 'fwupd' | 'gpu'; packages?: string[]
}
export type DriverStatus = 'working' | 'missing_firmware' | 'update_available' | 'optional_driver' | 'no_driver'
export interface DriverReport {
  state: 'idle' | 'checking' | 'off' | 'error'; checked_at: number | null; online_search: boolean; metered: boolean; secure_boot: boolean
  devices: { id: string; kind: 'wifi' | 'ethernet' | 'display' | 'bluetooth' | 'other'; driver: string | null; status: DriverStatus; offers: string[] }[]
  offers: DriverOffer[]; auto_installed: string[]; gpu_fallback?: boolean; mok?: { pending: boolean }
  /** Installed through Settings, newest first, with the version now on the system (#45). */
  installed?: { id: string; name: string; version: string | null; restart: boolean; at: number }[]
  /** Something installed needs a restart (cleared by the service after the next boot). */
  restart_required?: boolean
  /** Offers whose last install failed: the step and the service's error (apt's E: line), per offer (#59). */
  failed?: { id: string; name: string; step: 'downloading' | 'installing'; error: string; at: number }[]
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
  /** Emergency security release; resumed: this install picks up an interrupted download (older services omit both). */
  critical?: boolean; resumed?: boolean
  /** Update Center (or the organisation's mirror) the coordinator checked, and the device's ring. */
  update_host?: string; ring?: 'development' | 'pilot' | 'stable'
  /** From the signed manifest: release notes (plain text), sizes, a version upgrade, a security release. */
  notes?: string | null; notes_url?: string | null; download_bytes?: number | null; installed_bytes?: number | null; upgrade?: boolean; security?: boolean
}
export interface AppRequest { id: string; state: 'pending' | 'approved' | 'rejected'; note: string | null; at: number }
export interface UpdateHistoryEntry {
  id: string; kind: 'os' | 'driver' | 'firmware' | 'app'; title: string; version: string | null
  result: 'success' | 'failed' | 'cancelled' | 'pending'; finished_at?: number; started_at: number | null; reboot_required?: boolean
  /** For administrators (diagnostics); people see a worded result. */
  error?: string | null
}
export interface UpdateHistory { pending: UpdateHistoryEntry[]; entries: UpdateHistoryEntry[] }
export interface AppUpdate { id: string; name: string; version: string | null; download_size: string | null }
export interface CatalogEntry {
  id: string; source: 'apt' | 'flatpak' | 'appimage'; name: string; arches: string[]
  required?: boolean; blocked?: boolean; sha256?: string; category?: string; summary?: string; publisher?: string
  installed: boolean; available: boolean; blocked_reason: string | null
  /** Software Management (older services omit both): the person may ask for approval; their latest request. */
  requestable?: boolean; request?: AppRequest | null
}
export type AppCatalog =
  | { state: 'ok'; arch: string; items: CatalogEntry[]; fetched_at: number }
  | { state: 'not_enrolled' | 'unreachable' | 'error'; arch: string; items: []; error: string }
export interface LocalDebPreview {
  package: string; version: string; architecture: string; publisher: string; publisher_verified: false; description: string
  plan: PackagePreview['plan']; disk_bytes: number | null; token: string
}
export interface AppPermissions { app: string; permissions: string[]; overrides: string[]; broad: string[] }
export interface FoundBundle { handle: string; name: string; drive: string }
export interface BundleInfo { release_id: string; version: string; packages: number; bytes: number; critical: boolean; verified: true }
export interface AppImageRecord {
  id: string; name: string; version: string | null; origin: string; sha256: string; arch: string; size: number
  signature: { status: 'signed'; fingerprint: string; trusted: boolean } | { status: 'unsigned' } | { status: 'invalid'; reason: string }
  approved: boolean; imported_at: string; approved_at: string | null; categories: string[]
}
export interface UpdateSummary { packages: string[]; flatpaks: string[]; reboot_required: boolean; state: string }
export interface FilePlaces { user: string; folders: string[]; media: { id: string; label: string }[]; disk: { device: string; label?: string; encrypted?: boolean; used: number; total: number } | null }
export interface FileHit { root: string; rel: string; name: string; dir: boolean; size: number | null; modified: number | null; where: string }
export interface TrashItem { id: string; name: string; dir: boolean; size: number; orig: string; where: string; deleted: number | null }
export interface FileStamp { size: number; modified: number }
export interface FileJob {
  id: string; op: 'copy' | 'move' | 'compress' | 'extract'; dest: string; state: 'running' | 'paused' | 'conflict' | 'error' | 'password' | 'confirm' | 'done' | 'failed' | 'cancelled'
  done: number; total: number; bytes_done: number; bytes_total: number
  conflict: { name: string; incoming: FileStamp; existing: FileStamp; remaining: number; index?: number; count?: number } | null
  /** Copy and move: source folder (display form), the file being copied now, the destination's free bytes, start time. */
  src?: string; current?: string | null; free?: number | null; started?: number
  /** state 'error': no_space | permission | io | busy | missing | failed, and the file it stopped at. */
  error_name?: string | null
  /** Archive jobs: the archive's name, the prompt's details and why it failed. */
  name?: string; ask?: { wrong?: boolean; bytes?: number | null; ratio?: number | null } | null; error?: string | null
}
export type ArchiveFormat = 'zip' | '7z' | 'tar.gz' | 'tar.xz'
export interface CompressOptions { format: ArchiveFormat; name: string; level: number; password?: string | null }
export interface ArchiveEntry { path: string; type: 'file' | 'dir' | 'symlink' | 'hardlink' | 'other'; size: number | null; link: string | null; modified: number | null; encrypted: boolean }
export interface ArchiveListing { kind: string; entries: ArchiveEntry[]; encrypted: boolean; total: number | null; packed: number }
/** state: Drive sync state (WSOS-DRV-002), "folder", "local" outside Drive, or "unknown" when sync isn't running. */
export interface FileEntry { name: string; dir: boolean; size: number | null; modified: number | null; state: string; local: boolean; items?: number | null }
export type ReportSectionId = 'system' | 'services' | 'session_services' | 'session_log' | 'system_log' | 'packages'
export interface ProblemReport { id: string; created_at: string; sections: { id: ReportSectionId; text: string; available: boolean }[] }
export interface PackageJobEvent { job: string; kind: 'progress' | 'finished'; percent?: number; phase?: string; result?: string; error?: string }

export function formatBytes(n: number | null): string {
  if (n == null) return '—'
  const a = Math.abs(n)
  const s = a >= 1e9 ? `${formatDecimal(a / 1e9, 1)} GB` : a >= 1e6 ? `${formatNumber(Math.round(a / 1e6))} MB` : `${formatNumber(Math.max(1, Math.round(a / 1e3)))} kB`
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
    // Anything else is PackageKit's/dpkg's own text: a sentence from lib/errors.ts instead (details for administrators).
    default: return errorMessage(code, 'package')
  }
}

import type { SyncStatus } from './syncNotices'
import type { CheckId, CheckResult, SnapshotInfo } from './recovery'
import { formatDecimal, formatNumber, t } from '../i18n'
import { errorMessage } from './errors'

export interface DevicePolicies {
  version: string; update_ring: string | null; update_mode: string | null; maintenance_window: string | null
  lock_timeout_max_s: number | null; offline_access_days: number | null; usb_storage: string | null; bluetooth: boolean | null
  app_allowlist_size: number
  /** Employee monitoring (#22) on in the signed policy. */
  activity_monitoring?: boolean
  /** On-device AI assistant (services/ai): false = off for everyone; ai_models = catalog ids allowed. */
  ai_assistant?: boolean | null; ai_models?: string[] | null
  /** Desktop widgets (WorkSuite Desktop's Home on the wallpaper): false = off for everyone. Kiosk: always off. */
  desktop_widgets?: boolean | null; kiosk?: boolean
  /** WhatsApp (WhatsApp Web window): false = off on this device. */
  whatsapp?: boolean | null
  /** Screenshots and the snipping tool; clipboard history (Super+V). 'disabled' = off; kiosks: always off. */
  screen_capture?: 'allowed' | 'disabled' | null; clipboard_history?: 'allowed' | 'disabled' | null
  /** Remote support without asking first (issue #19): disclosed to the user here and in the session indicator. */
  remote_support_unattended?: boolean
  /** Software Management and the Update Manager's download limit (KiB/s, 0 = none). */
  software_install?: 'any' | 'approved' | 'request' | 'block' | null; software_uninstall?: boolean | null; software_update?: boolean | null
  update_bandwidth_kbps?: number | null
}
export type KioskApp = { type: 'url'; url: string } | { type: 'module'; id: string } | { type: 'desktop'; id: string }
export interface KioskSummary { user: string; app: KioskApp; allowed_urls: string[]; idle_reset_minutes: number; show_on_screen_keyboard: boolean; exit_pin: boolean
  /** Policy kiosk.orientation and kiosk.screen_off (older agents send neither). */
  orientation?: 'landscape' | 'portrait' | 'landscape-flipped' | 'portrait-flipped'; screen_off?: { from: string; until: string } | null }
export interface DeviceInfo {
  agent: boolean
  device: { hostname: string; os_version: string; arch: string; kernel_version: string; encrypted: boolean | null } | null
  managed: boolean
  org_name: string | null
  server: string | null
  last_check_in: number | null
  policies: DevicePolicies | null
  /** Settings › Managed › Kiosk mode: this device's kiosk as the policy sets it (never the exit PIN); null = not a kiosk. */
  kiosk?: KioskSummary | null
  /** WSOS-IDN-004: provisioning requires enrollment (and so a connection) before first use. */
  provisioning?: { require_enrollment: boolean; server: string | null }
  /** Processor and memory (electron/device.ts hostSpecs). */
  specs?: { cpu_model: string | null; cpu_cores: number | null; memory_bytes: number | null }
}

/** /run/worksuite-device-agent/security.json (services/device-agent/src/security.ts securityStatus). */
export interface SecurityStatus {
  overall: 'protected' | 'attention' | 'at_risk' | 'unavailable'
  issues: string[]
  managed: boolean
  scanning?: boolean
  firewall: { active: boolean; policy_rules: number; log_blocked: boolean }
  isolation: { since: number; until: number } | null
  antivirus: { enabled: boolean; installed: boolean; engine: string | null; signatures: number | null; signatures_at: number | null; signatures_age_days: number | null; updates: string; schedule: string; exclusions: number
    last_scan: { kind: string; trigger: string; started: number; finished: number; files: number; detections: number; error?: string } | null; last_full_scan: number | null }
  threats: { active: number; quarantined: number }
  history: { id: string; at: number; path: string; signature: string; action: string }[]
  firewall_alerts: { at: number; dst: string; dport: number | null; proto: string }[]
  retention_days: number
  /** #38 protection layers; absent from older agents. */
  realtime?: { enabled: boolean; prevention: boolean; state: string; downloads: boolean }
  protected_folders?: { folders: string[]; mode: 'block' | 'audit'; state: string }
  app_control?: { denied: number }
  web?: { dns_blocked: number; dns_feeds: number; dns_filter: boolean; dns_feed_entries: number }
  threat_intel?: { feeds: number; entries: number; updated: number | null; errors: string[] }
  auto_patch?: 'immediate' | 'window' | 'off'
  events?: { id: string; at: number; kind: string; path: string; exe: string | null; signature: string | null; enforced: boolean; resolved: string | null }[]
  suspended?: { id: string; at: number; path: string; exe: string | null; pid: number | null }[]
  quarantine?: { id: string; at: number; path: string; signature: string }[]
}
/** One day of activity (electron/activity.ts DayReport): aggregates only. */
export interface ActivityDay { day: string; active_s: number; idle_s: number; locked_s: number; first_active: number | null; last_active: number | null
  apps: { app_id: string; name: string; active_s: number; switches: number }[]; events: { at: number; type: string }[]
  /** #39: only when the organization's policy turns website domains on. */
  domains?: { domain: string; active_s: number }[] }
/** #39: the current state the shell last sent for the organization's live view. */
export interface ActivityLive { state: 'active' | 'idle' | 'locked'; app_id: string | null; at: number }
export interface ActivityStatus { enabled: boolean; org_name: string | null; retention_days: number; idle_threshold_s: number; disclosure_needed: boolean; last_sent: number | null; days: ActivityDay[]
  web_domains?: boolean; live?: ActivityLive | null }
/** What the organization's server holds about the user (desktop/v1/activity). */
export interface ActivityRemote { items: (ActivityDay & { device_id: string })[]; device_events: { device_id: string; at: number; type: 'startup' | 'shutdown' }[]; live: { device_id: string; state: string; app_id: string | null; at: number }[] }

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
  if (p.desktop_widgets === false) out.push(t('mdm.widgetsOff'))
  if (p.whatsapp === false) out.push(t('mdm.whatsappOff'))
  if (p.screen_capture === 'disabled') out.push(t('mdm.captureOff'))
  if (p.clipboard_history === 'disabled') out.push(t('mdm.clipboardOff'))
  if (p.remote_support_unattended) out.push(t('mdm.remoteUnattended'))
  if (p.ai_assistant === false) out.push(t('mdm.aiOff'))
  if (p.activity_monitoring === true) out.push(t('mdm.monitoringOn'))
  else if (p.ai_models?.length) out.push(t('mdm.aiLimited', { count: p.ai_models.length }))
  return out
}

export interface LockSettings { timeout_s: number; max_s: number | null; choices: number[] }

export function lockChoiceLabel(s: number): string {
  if (s === 0) return t('time.never')
  if (s < 3600) return t('time.min', { n: Math.round(s / 60) })
  return s === 3600 ? t('time.hour') : t('time.hours', { n: formatNumber(Math.round(s / 360) / 10) })
}
export interface InstalledApp { id: string; name: string; generic_name: string | null; comment: string | null; icon: string | null; categories: string[]; keywords: string[]; wm_class?: string | null }

export type SignOutChoice = 'none' | 'export' | 'discard'

export interface CloudAccount { id: string; name: string | null; server_url: string; state?: string }
export type CloudResult<T> = { ok: true; value: T } | { ok: false; error: string }

declare global {
  interface Window { worksuite?: WorkSuiteApi }
}

// Preview only (no helper in a plain browser): a PIN set up and one security key, so every state can be reviewed.
const previewSignin: SignInMethods = {
  pin: true, keys: [{ id: 'a1b2c3d4e5f60718', name: 'YubiKey 5 NFC', added: Date.UTC(2026, 8, 2) }], default: 'pin',
  allow_pin: true, pin_min_length: 6, pin_max_length: 12, attempt_limit: 3,
}

const stub: WorkSuiteApi = {
  async authenticate(_user, password, method) {
    // Preview: the password "wrong" and the PIN 000000 are rejected so the error states can be reviewed.
    if (method === 'key') return { ok: true }
    if (method === 'pin') return password === '000000' || !/^[0-9]{4,12}$/.test(password) ? { ok: false, message: 'Incorrect PIN.' } : { ok: true }
    if (password === 'wrong') return { ok: false, message: 'Incorrect password. Try again.' }
    return password.length > 0 ? { ok: true } : { ok: false, message: 'Enter your password.' }
  },
  async lock() { return false },
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
  // Preview: signed out, so the widgets offer sign-in instead of inventing data.
  async widgets() { return emptySnapshot('not_signed_in', ymd(new Date())) },
  async openSearchResult() { return { ok: true } },
  async webApps() { return { ok: false, error: 'not_signed_in' } },
  async shellPrefs() { return { ok: false, error: 'not_signed_in' } },
  async setShellPrefs() { return { ok: false, error: 'not_signed_in' } },
  async installedApps() {
    return { apps: [
      { id: 'firefox-esr', name: 'Firefox ESR', generic_name: 'Web Browser', comment: null, icon: 'firefox-esr', categories: ['Network', 'WebBrowser'], keywords: ['internet', 'web'] },
      { id: 'foot', name: 'Foot', generic_name: 'Terminal', comment: null, icon: 'foot', categories: ['System', 'TerminalEmulator'], keywords: ['shell'] },
    ], office: null, desktop: null }
  },
  async launchOffice() {},
  async launchWorkSuite() {},
  async cloudSignIn(serverUrl, _mode) {
    stubAccounts = [{ id: 'preview:u-1', name: 'Preview User', server_url: serverUrl, state: 'signed_in' }]
    return { ok: true, value: stubAccounts[0] }
  },
  async cloudSignInCancel() { return { ok: true, value: false } },
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
  async securityStatus() {
    if (PV.get('security') === 'none') return null
    const risk = PV.get('security') === 'threat'
    return {
      overall: risk ? 'at_risk' : 'protected', issues: risk ? ['threats_need_action'] : [], managed: stubManaged, scanning: false,
      firewall: { active: true, policy_rules: stubManaged ? 3 : 0, log_blocked: stubManaged }, isolation: null,
      antivirus: { enabled: true, installed: true, engine: '1.0.7', signatures: 27431, signatures_at: Date.now() - 86_400_000, signatures_age_days: 1, updates: 'active', schedule: 'weekly', exclusions: 0,
        last_scan: { kind: 'quick', trigger: 'schedule', started: Date.now() - 7_300_000, finished: Date.now() - 7_200_000, files: 18_402, detections: risk ? 1 : 0 }, last_full_scan: Date.now() - 5 * 86_400_000 },
      threats: { active: risk ? 1 : 0, quarantined: 1 },
      history: [...(risk ? [{ id: 't2', at: Date.now() - 7_200_000, path: '/home/nimal/Downloads/invoice.pdf.exe', signature: 'Win.Trojan.Agent-1', action: 'detected' }] : []),
        { id: 't1', at: Date.now() - 9 * 86_400_000, path: '/home/nimal/Downloads/eicar.com', signature: 'Win.Test.EICAR_HDB-1', action: 'quarantined' }],
      firewall_alerts: [], retention_days: 90,
      realtime: { enabled: stubManaged, prevention: true, state: stubManaged ? 'active' : 'inactive', downloads: true },
      protected_folders: { folders: stubManaged ? ['~/Documents', '~/Pictures'] : [], mode: 'block', state: stubManaged ? 'active' : 'inactive' },
      app_control: { denied: stubManaged ? 2 : 0 }, web: { dns_blocked: stubManaged ? 12 : 0, dns_feeds: 0, dns_filter: stubManaged, dns_feed_entries: 0 },
      threat_intel: { feeds: stubManaged ? 1 : 0, entries: stubManaged ? 4210 : 0, updated: Date.now() - 3_600_000, errors: [] }, auto_patch: 'window',
      events: risk ? [{ id: 'e1', at: Date.now() - 600_000, kind: 'write_blocked', path: '/home/nimal/Documents/budget.ods', exe: '/home/nimal/.cache/x/run', signature: null, enforced: true, resolved: null }] : [],
      suspended: stubSuspended, quarantine: stubQuarantine,
    }
  },
  async securityScan() { return { ok: true, value: true } },
  async securityAction(method, ...args) {
    if (method === 'RestoreQuarantined' && PV.get('security') === 'threat') return { ok: false, error: 'still_detected' }
    stubQuarantine = stubQuarantine.filter((q) => q.id !== args[0]); stubSuspended = []
    return { ok: true, value: true }
  },
  onSecurityChanged() { return () => {} },
  async activityStatus() { return stubActivity() },
  async activityAck() { stubActivityAck = true; return stubActivity() },
  async activityRemote() { return { ok: true, value: { items: stubActivity().days.map((d) => ({ ...d, device_id: 'preview' })), device_events: [{ device_id: 'preview', at: Date.now() - 7 * 3_600_000, type: 'startup' as const }], live: [] } } },
  onActivityChanged() { return () => {} },
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
      f('TSHDA bid — pricing (conflict preview-laptop 2026-10-15).xlsx', 'conflict', 208_000),
      f('MBSL digital media tender.pdf', 'online-only', null, false), f('Care Me platform — clarifications.pdf', 'pending', 480_000),
      f('Site walk-through recording.mp4', 'error', 6_200_000_000) ] }
    if (!rel) return { ok: true, value: [f('Documents', 'local', null, true, true), f('Downloads', 'local', null, true, true), f('notes.txt', 'local', 2_000)] }
    if (rel === 'Documents') return { ok: true, value: STUB_DOCS() }
    return { ok: true, value: [f('Invoice INV-2026-0418.pdf', 'local', 182_000), f('worksuite-agent-2.4.1.zip', 'local', 38_200_000)] }
  },
  async filesOpen() { return { ok: true, value: true } },
  async filesPlaces() { return { user: 'alex', folders: ['Documents', 'Downloads', 'Pictures', 'Music', 'Videos'], media: [{ id: 'media:KINGSTON', label: 'KINGSTON' }], disk: { device: 'luks-3f1c', label: '', encrypted: true, used: 12.8e9, total: 39.5e9 } } },
  async filesStarred() { return { keys: [], hits: [] } },
  async filesStar() { return { ok: true, value: [] } },
  async filesRecent() { return [] },
  async filesSearch(_r, _rel, q) {
    const hits = STUB_DOCS().filter((e) => e.name.toLowerCase().includes(q.trim().toLowerCase())).map((e) => ({ root: 'home', rel: `Documents/${e.name}`, name: e.name, dir: e.dir, size: e.size, modified: e.modified, where: '~/Documents' }))
    return { ok: true, value: { hits, ms: 12, truncated: false } }
  },
  async filesMkdir(_r, rel, name) { return { ok: true, value: rel ? `${rel}/${name}` : name } },
  async filesRename(_r, rel, name) { return { ok: true, value: name || rel } },
  async filesTrash(_r, rels) { return { ok: true, value: { count: rels.length, ids: rels.map((r) => r.split('/').pop()!) } } },
  async filesDelete(_r, rels) { return { ok: true, value: rels.length } },
  async filesNotify() { return true },
  async toastsAvailable() { return false },
  async toastShow() { return false },
  async filesTrashList() {
    const d = (days: number) => Date.now() - days * 86_400_000
    return [['Old logo.png', '~/Pictures', 0, 640_000], ['Draft v1.docx', '~/Documents/Projects', 1, 312_000], ['Invoice copy.pdf', '~/Downloads', 9, 220_000]]
      .map(([name, where, days, size]) => ({ id: String(name), name: String(name), dir: false, size: Number(size), orig: '', where: String(where), deleted: d(Number(days)) }))
  },
  async filesTrashRestore(ids) { return { ok: true, value: { restored: ids.length, skipped: 0 } } },
  async filesTrashDelete(ids) { return { ok: true, value: ids === 'all' ? 0 : ids.length } },
  async filesDrop(paths) { return { ok: true, value: { jobs: 0, rejected: paths.length } } },
  async filesStartDrag() { return { ok: false, error: 'unavailable' } },
  pathForFile() { return '' },
  async filesPaste(op, _s, rels, dstRoot) {
    // Preview: a job that stops on one conflict, then runs to the end; Pause holds it, like the real job service.
    const id = `stubjob${++stubJobSeq}`
    const total = rels.length, bytes = rels.length * 2_400_000
    const base: FileJob = { id, op: op === 'move' ? 'move' : 'copy', dest: dstRoot.startsWith('media:') ? dstRoot.slice(6) : '~/Documents', state: 'running', done: 0, total, bytes_done: 0, bytes_total: bytes, conflict: null,
      src: '~/Documents', current: rels[0].split('/').pop()!, free: 21_400_000_000, started: Date.now(), error: null, error_name: null }
    stubJobs.set(id, { job: base, paused: false, step: 0 })
    setTimeout(() => stubEmit({ ...base, state: 'conflict', conflict: { name: rels[0].split('/').pop()!, incoming: { size: 2_400_000, modified: Date.now() - 600_000 }, existing: { size: 2_100_000, modified: Date.now() - 12 * 86_400_000 }, remaining: rels.length - 1, index: 1, count: rels.length } }), 50)
    return { ok: true, value: id }
  },
  async filesResolve(id, r) {
    const s = stubJobs.get(id)
    if (!s) return { ok: false, error: 'not_found' }
    if (r === 'cancel') { stubJobs.delete(id); stubEmit({ ...s.job, state: 'cancelled' }); return { ok: true, value: true } }
    if (r === 'pause') { s.paused = true; stubEmit({ ...s.job, state: 'paused' }); return { ok: true, value: true } }
    s.paused = false
    const tick = () => {
      const cur = stubJobs.get(id)
      if (!cur || cur.paused) return
      cur.step++
      const f = Math.min(1, cur.step / 20)
      cur.job = { ...cur.job, state: f >= 1 ? 'done' : 'running', conflict: null, done: Math.round(cur.job.total * f), bytes_done: Math.round(cur.job.bytes_total * f), current: f >= 1 ? null : cur.job.current }
      stubEmit(cur.job)
      if (f < 1) setTimeout(tick, 300); else stubJobs.delete(id)
    }
    setTimeout(tick, 100)
    return { ok: true, value: true }
  },
  async filesCompress(_root, rels, o) {
    // Preview: a job that runs to the end.
    const base: FileJob = { id: 'stubarc', op: 'compress', dest: '~/Documents', name: `${o.name}.${o.format}`, state: 'running', done: 0, total: rels.length, bytes_done: 0, bytes_total: 48_000_000, conflict: null, ask: null, error: null }
    for (let i = 1; i <= 10; i++) setTimeout(() => stubFileJobs.forEach((l) => l({ ...base, state: i === 10 ? 'done' : 'running', bytes_done: i * 4_800_000, done: i === 10 ? rels.length : 0 })), i * 400)
    return { ok: true, value: base.id }
  },
  async filesExtract(_root, rel, mode, items, password) {
    const name = rel.split('/').pop()!
    const base: FileJob = { id: 'stubx', op: 'extract', dest: mode === 'folder' ? `~/Downloads/${name.replace(/\.[^.]+$/, '')}` : '~/Downloads', name, state: 'running', done: 0, total: items.length || 14, bytes_done: 0, bytes_total: 96_400_000, conflict: null, ask: null, error: null }
    setTimeout(() => stubFileJobs.forEach((l) => l(name.includes('agent') && !password ? { ...base, state: 'password', ask: { wrong: false } } : { ...base, bytes_done: 41_000_000 })), 50)
    return { ok: true, value: base.id }
  },
  async filesArchivePassword(id, pw) {
    stubFileJobs.forEach((l) => l({ id, op: 'extract', dest: '~/Downloads/worksuite-agent-2.4.1', name: 'worksuite-agent-2.4.1.zip', state: pw === null ? 'cancelled' : 'running', done: 3, total: 14, bytes_done: 41_000_000, bytes_total: 96_400_000, conflict: null, ask: null, error: null }))
    return { ok: true, value: true }
  },
  async filesArchiveList(_root, rel) {
    const e = (path: string, size: number | null, type: 'file' | 'dir' = 'file'): ArchiveEntry => ({ path, type, size, link: null, modified: Date.now() - 86_400_000 * 3, encrypted: false })
    const entries = [e('worksuite-agent', 0, 'dir'), e('worksuite-agent/bin', 0, 'dir'), e('worksuite-agent/bin/worksuite-agent', 61_200_000), e('worksuite-agent/bin/agentctl', 8_400_000),
      e('worksuite-agent/config', 0, 'dir'), e('worksuite-agent/config/agent.toml', 4_100), e('worksuite-agent/config/policies.json', 12_800), e('worksuite-agent/README.md', 9_600), e('worksuite-agent/LICENSE', 11_300), e('worksuite-agent/CHANGELOG.md', 38_000)]
    return rel.endsWith('.zip') ? { ok: true, value: { kind: 'zip', entries, encrypted: false, total: 69_676_800, packed: 38_200_000 } } : { ok: false, error: 'failed' }
  },
  onOpenArchive() { return () => {} },
  async filesEject() { return { ok: false, error: 'unavailable' } },
  onFilesJob(cb) { stubFileJobs.add(cb); return () => { stubFileJobs.delete(cb) } },
  async filesStatus(root) { return { free_bytes: 212e9, drive: root === 'drive' ? { states: { synced: 2, syncing: 1, pending: 1, conflict: 1, 'online-only': 1, error: 1 }, last_sync: Date.now() - 60_000, service_state: 'idle' } : null } },
  async deviceInfo() {
    return {
      agent: true, managed: stubManaged, org_name: stubManaged ? 'Livezen Technologies' : null, server: stubManaged ? 'work.livezentech.com' : null, last_check_in: stubManaged ? Date.now() - 4 * 60_000 : null,
      device: { hostname: 'LZT-LAP-0142', os_version: 'WorkSuite OS 1.0 (preview)', arch: 'amd64', kernel_version: '6.12', encrypted: true },
      policies: !stubManaged ? null : { version: 'preview', update_ring: 'pilot', update_mode: 'automatic', maintenance_window: '02:00-04:00', lock_timeout_max_s: 300, offline_access_days: 7, usb_storage: 'read_only', bluetooth: null, app_allowlist_size: 42 },
      kiosk: stubManaged && typeof location !== 'undefined' && new URLSearchParams(location.search).get('kiosk') === '1' ? { user: 'kiosk', app: { type: 'url', url: 'https://work.livezentech.com/reception' }, allowed_urls: ['https://work.livezentech.com/'], idle_reset_minutes: 2, show_on_screen_keyboard: true, exit_pin: true } : null,
    }
  },
  async cloudAccounts() { return { ok: true, value: stubAccounts } },
  async hwDevices() {
    if (stubSim === 'none') return { ok: false, error: 'unavailable' }
    const extra = PV.get('hw') === 'new' && Date.now() - stubStart > 3000 ? [STUB_NEW] : PV.get('hw') === 'problem' && Date.now() - stubStart > 3000 ? [{ ...STUB_NEW, driver: null, driver_version: null }] : []
    const more = PV.get('hw') === 'drivers' || PV.get('hw') === 'nvidia' ? [dev('pci:0000:00:1f.6', 'Ethernet Connection I219-V', 'Intel Corporation', 'network', 'pci', 'e1000e')] : []
    if (PV.get('hw') === 'nvidia') more.push(dev('pci:0000:01:00.0', 'AD102 [GeForce RTX 4090]', 'NVIDIA Corporation', 'graphics', 'pci', 'nouveau'))
    return { ok: true, value: [...STUB_DEVICES, ...more, ...extra] }
  },
  async hwDriverReport(check) {
    const hw = PV.get('hw')
    if (hw !== 'catalog' && hw !== 'drivers' && hw !== 'nvidia') return { ok: false, error: 'unavailable' }
    if (check) { stubDriverReport = { ...stubDriverReport, state: 'checking' }; stubDriverListeners.forEach((l) => l(stubDriverReport)); await stubWait(PV.get('slow') ? 60_000 : 1500) }
    stubDriverReport = { ...stubReport(hw), checked_at: Date.now() }
    return { ok: true, value: stubDriverReport }
  },
  onDriversChanged(cb) {
    stubDriverListeners.add(cb)
    // ?hw=drivers&notify=1: the "drivers available" notification a few seconds in.
    const t = PV.get('notify') ? setTimeout(() => cb(stubReport(PV.get('hw'))), 2500) : null
    return () => { stubDriverListeners.delete(cb); if (t) clearTimeout(t) }
  },
  async driversNotify() { return 0 },
  async hwMokPassword() { return PV.get('mok') ? { ok: true, value: '48213907' } : { ok: true, value: '' } },
  onOpenSettings() { return () => {} },
  async hwInstallDrivers(ids) {
    if (!['catalog', 'drivers', 'nvidia'].includes(PV.get('hw') ?? '')) return { ok: false, error: 'unavailable' }
    const job = `/lk/worksuite/PackageService1/job/${++stubJobId}`
    ids.forEach((id, i) => {
      setTimeout(() => stubListeners.forEach((l) => l({ job, kind: 'progress', percent: 100, phase: id })), 400 + i * 100)
      if (i === 1) setTimeout(() => stubListeners.forEach((l) => l({ job, kind: 'progress', percent: 62, phase: ids[1] })), 500)
    })
    return { ok: true, value: job }
  },
  async signinMethods() { return stubAvail({ ...previewSignin, keys: [...previewSignin.keys] }) },
  async signinPinSet(pin) { if (!/^[0-9]{4,12}$/.test(pin)) return { ok: false, error: 'digits_only' }; previewSignin.pin = true; return { ok: true } },
  async signinPinRemove() { previewSignin.pin = false; if (previewSignin.default === 'pin') previewSignin.default = 'password'; return { ok: true } },
  async signinKeyAdd(name) {
    await new Promise((r) => setTimeout(r, 1200))
    const id = Math.random().toString(16).slice(2, 10).padEnd(16, '0')
    previewSignin.keys.push({ id, name: name || 'Security key', added: Date.now() }); return { ok: true, id }
  },
  async signinKeyRemove(id) { previewSignin.keys = previewSignin.keys.filter((k) => k.id !== id); if (!previewSignin.keys.length && previewSignin.default === 'key') previewSignin.default = 'password'; return { ok: true } },
  async signinSetDefault(method) { previewSignin.default = method; return { ok: true } },
  async sysUsers() { return stubAvail({ current: 'preview', users: [{ login: 'preview', name: 'Preview User', uid: 1000, admin: true }, { login: 'second', name: 'Second User', uid: 1001, admin: false }] }) },
  async pkgRepair() { return stubJob('repair', 'repair') },
  async pkgState() { return { ok: false, error: 'service_unavailable' } },
  // Browser preview: no system to read, so no report (never sample logs).
  async reportCollect() { return { ok: false, error: 'service_unavailable' } },
  async reportSave() { return { ok: false, error: 'service_unavailable' } },
  async reportSend() { return { ok: false, error: 'service_unavailable' } },
  // Browser preview: there is no package service or server here, so these answer honestly instead of inventing apps.
  async pkgCatalog() { return { ok: true, value: { state: 'not_enrolled', arch: 'amd64', items: [], error: 'Preview mode: no package service, so there is no app catalog.' } } },
  async pkgRequestApp() { return { ok: false, error: 'service_unavailable' } },
  async updateHistory() { return { ok: false, error: 'service_unavailable' } },
  async appUpdates() { return { ok: false, error: 'service_unavailable' } },
  async updateApps() { return { ok: false, error: 'service_unavailable' } },
  async pickFile() { return { ok: false, error: 'service_unavailable' } },
  async localDebPreview() { return { ok: false, error: 'service_unavailable' } },
  async localDebInstall() { return { ok: false, error: 'service_unavailable' } },
  async appPermissions() { return { ok: false, error: 'service_unavailable' } },
  async appPermissionsReset() { return { ok: false, error: 'service_unavailable' } },
  async appDataRemove() { return { ok: false, error: 'service_unavailable' } },
  async pruneRuntimes() { return { ok: false, error: 'service_unavailable' } },
  // ?upd=offline previews G14 with a bundle on a USB drive; otherwise there is no package service here.
  async bundleInspect(h) { return h === 'wsupdate:preview' ? { ok: true, value: { release_id: 'os-1.1.2', version: '1.1.2', packages: 214, bytes: 377_487_360, critical: true, verified: true } } : { ok: false, error: 'service_unavailable' } },
  async bundleInstall() { return { ok: false, error: 'service_unavailable' } },
  async findBundles() { return { ok: true, value: PV.get('upd') === 'offline' ? [{ handle: 'wsupdate:preview', name: 'worksuite-1.1.2-offline.wsupdate', drive: 'KINGSTON' }] : [] } },
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
  async sysWifiRescan() { return stubAvail(true as const) },
  async sysWifiDisconnect() { stubSys.net.networks = stubSys.net.networks.map((n) => ({ ...n, in_use: false })); return stubAvail(true as const) },
  async radioDiagnose(kind) {
    if (stubSim === 'none') return { ok: false, error: 'unavailable' }
    const d: RadioDiagnosis = kind === 'wifi'
      ? { kind, status: 'ok', service: 'active', problems: [], hardware: [{ name: 'Wi-Fi 6E AX211 160MHz', driver: 'iwlwifi', ids: '8086:51f0' }], adapters: [{ name: 'wlan0', device: 'Wi-Fi 6E AX211 160MHz', driver: 'iwlwifi', soft_blocked: false, hard_blocked: false }] }
      : { kind, status: stubSys.bt.powered ? 'ok' : 'off', service: 'active', problems: [], hardware: [], adapters: [{ name: 'hci0', device: null, driver: 'btusb', soft_blocked: false, hard_blocked: false }] }
    return { ok: true, value: { ...d, text: `${kind}: ${d.status}` } }
  },
  async radioFix() { return { ok: true, value: true } },
  async graphics() {
    if (stubSim === 'none') return { ok: false, error: 'unavailable' }
    return { ok: true, value: {
      gpus: [{ name: 'Alder Lake-P GT2 [Iris Xe Graphics]', vendor: 'Intel Corporation', ids: '8086:46a6', driver: 'i915', driver_version: null, proprietary: false, virtual: false }],
      compositor: { renderer: 'gpu', reason: null, choice: 'auto', fell_back: false },
      apps: { accelerated: true, disabled_reason: null, features: { gpu_compositing: 'enabled', rasterization: 'enabled', video_decode: 'enabled', webgl: 'enabled', webgpu: 'disabled_off' }, gl_renderer: 'Mesa Intel(R) Iris(R) Xe Graphics (ADL GT2)', gl_version: 'OpenGL ES 3.2 Mesa 25.0.7', driver_vendor: 'Mesa', driver_version: '25.0.7' },
      vaapi: { available: true, driver: 'Intel iHD driver for Intel(R) Gen Graphics - 25.2.3', decode: ['H264Main', 'HEVCMain', 'VP9Profile0', 'AV1Profile0'], encode: ['H264Main', 'HEVCMain'] },
      vulkan: { available: true, api_version: '1.4.305', devices: [{ name: 'Intel(R) Iris(R) Xe Graphics (ADL GT2)', type: 'integrated_gpu', driver: 'Intel open-source Mesa driver Mesa 25.0.7' }] },
    } }
  },
  async graphicsSetRenderer() { return { ok: true, value: true } },
  async graphicsReset() { return { ok: true, value: true } },
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
const stubDriverListeners = new Set<(r: DriverReport) => void>()
let stubDriverReport: DriverReport = { state: 'idle', checked_at: null, online_search: true, metered: false, secure_boot: false, devices: [], offers: [], auto_installed: [] }
/** ?hw=drivers: Wi-Fi missing firmware, Ethernet working, a firmware update; ?hw=nvidia adds an NVIDIA GPU on nouveau
 *  (&sb=1: Secure Boot on). */
function stubReport(hw: string | null): DriverReport {
  if (hw === 'catalog') return { state: 'idle', checked_at: Date.now(), online_search: true, metered: false, secure_boot: false, devices: [], offers: STUB_OFFERS, auto_installed: [] }
  const nv = hw === 'nvidia'
  const offers: DriverOffer[] = [
    { id: 'fw:firmware-iwlwifi', device_id: 'pci:0000:00:14.3', name: 'firmware-iwlwifi', summary: 'firmware_missing', from_version: null, to_version: 'debian', license: 'proprietary', category: 'recommended', size_bytes: 24e6, restart: false, kind: 'firmware', packages: ['firmware-iwlwifi'] },
    ...(nv ? [{ id: 'gpu:nvidia-driver', device_id: 'pci:0000:01:00.0', name: 'NVIDIA proprietary driver', summary: PV.get('sb') ? 'nvidia_secure_boot' : 'nvidia_better', from_version: null, to_version: '550', license: 'proprietary' as const, category: 'recommended' as const, size_bytes: 400e6, restart: true, kind: 'gpu' as const, packages: ['nvidia-driver', 'nvidia-kernel-dkms', 'linux-headers-amd64'] }] : []),
    { id: 'fwupd:0123456789abcdef0123456789abcdef01234567', device_id: null, name: 'System firmware', summary: 'Fixes a sleep issue', from_version: '1.12.0', to_version: '1.14.2', license: 'proprietary', category: 'security', size_bytes: 9e6, restart: true, kind: 'fwupd' },
  ]
  return {
    state: 'idle', checked_at: Date.now() - 3_600_000, online_search: true, metered: PV.get('metered') === '1', secure_boot: !!PV.get('sb'),
    devices: [
      { id: 'pci:0000:00:14.3', kind: 'wifi', driver: 'iwlwifi', status: 'missing_firmware', offers: ['fw:firmware-iwlwifi'] },
      { id: 'pci:0000:00:1f.6', kind: 'ethernet', driver: 'e1000e', status: 'working', offers: [] },
      { id: 'pci:0000:00:02.0', kind: 'display', driver: 'i915', status: 'working', offers: [] },
      ...(nv ? [{ id: 'pci:0000:01:00.0', kind: 'display' as const, driver: 'nouveau', status: 'optional_driver' as const, offers: ['gpu:nvidia-driver'] }] : []),
    ],
    offers, auto_installed: [], ...(PV.get('mok') ? { mok: { pending: true } } : {}),
  }
}
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
    case 'offline': {
      const two = new Date(); two.setDate(two.getDate() + 1); two.setHours(2, 0, 0, 0)
      return { ...base, version: '1.1.2', installed: '1.1.0', release_id: 'os-1.1.2', critical: true, resumed: true, state: 'installing', reason: null, deadline: two.toISOString() }
    }
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
  if (k === 'offline') setTimeout(() => emitJob(70, 'downloading'), 400)
  if (k === 'forced') { setTimeout(() => setOs({ state: 'installing', reason: null, restart_at: null }), 600); setTimeout(() => emitJob(50, 'applying'), 800) }
  if (k === 'failed') { setTimeout(() => emitJob(50, 'applying'), 400); setTimeout(() => setOs({ state: 'failed', reason: 'dpkg: error processing package linux-image-6.12 (--configure)' }), 700) }
}
const stubJobs = new Map<string, { job: FileJob; paused: boolean; step: number }>()
let stubJobSeq = 0
const stubEmit = (e: FileJob) => stubFileJobs.forEach((l) => l(e))
const stubFileJobs = new Set<(e: FileJob) => void>()
function STUB_DOCS(): FileEntry[] {
  const day = 86_400_000, now = Date.now()
  const e = (name: string, ago: number, size: number | null, items?: number): FileEntry => ({ name, dir: items != null, size, modified: now - ago * day, state: 'local', local: true, ...(items != null ? { items } : {}) })
  return [e('Archive', 13, null, 230), e('Contracts', 3, null, 7), e('Invoices', 1, null, 48), e('Projects', 0, null, 12),
    e('Budget 2027.xlsx', 0, 2_400_000), e('Brand guide.pdf', 14, 8_100_000), e('Logo export.png', 4, 640_000), e('Meeting notes.md', 5, 6_000),
    e('Proposal v3.docx', 6, 312_000), e('Q4 plan draft.docx', 0, 184_000), e('Roadmap.pptx', 17, 5_600_000), e('Signed NDA.pdf', 3, 220_000), e('Team offsite.pptx', 1, 12_000_000)]
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
let stubActivityAck = false
/** Preview: ?monitoring=1 shows employee monitoring on (with the first-run disclosure until it is acknowledged). */
function stubActivity(): ActivityStatus {
  const on = PV.get('monitoring') === '1'
  const day = new Date().toISOString().slice(0, 10)
  const web = on && PV.get('web') === '1'
  return { enabled: on, org_name: on ? 'Livezen Technologies' : null, retention_days: 90, idle_threshold_s: 300, disclosure_needed: on && !stubActivityAck, last_sent: on ? Date.now() - 600_000 : null,
    web_domains: web, live: on ? { state: 'active', app_id: 'org.worksuite.Office', at: Date.now() - 30_000 } : null,
    days: on ? [{ day, active_s: 13_320, idle_s: 1_800, locked_s: 2_700, first_active: Date.now() - 6 * 3_600_000, last_active: Date.now(), events: [{ at: Date.now() - 6 * 3_600_000, type: 'login' }],
      apps: [{ app_id: 'org.worksuite.Office', name: 'WorkSuite Office', active_s: 7_900, switches: 31 }, { app_id: 'org.mozilla.firefox', name: 'Firefox', active_s: 3_600, switches: 24 }, { app_id: 'foot', name: 'Terminal', active_s: 1_820, switches: 9 }],
      ...(web ? { domains: [{ domain: 'mail.worksuite.lk', active_s: 2_400 }, { domain: 'drive.worksuite.lk', active_s: 900 }] } : {}) }] : [] }
}
// Preview (#38): one quarantined file and, with ?security=threat, one suspended program.
let stubQuarantine = [{ id: '0f0e0d0c-0b0a-4908-8706-050403020100', at: Date.now() - 9 * 86_400_000, path: '/home/nimal/Downloads/eicar.com', signature: 'Win.Test.EICAR_HDB-1' }]
let stubSuspended = typeof location !== 'undefined' && new URLSearchParams(location.search).get('security') === 'threat'
  ? [{ id: '1f0e0d0c-0b0a-4908-8706-050403020100', at: Date.now() - 300_000, path: '/home/nimal/Documents/report.odt.locked', exe: '/usr/bin/python3', pid: 4242 }] : []
let stubManaged = typeof location !== 'undefined' && new URLSearchParams(location.search).get('managed') === '1'

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
    case 'sign_in_cancelled': return t('cloud.err.signInCancelled')
    case 'locked': return t('cloud.err.locked')
    case 'browser_failed': return t('cloud.err.browser')
    case 'enrollment_rejected': return t('cloud.err.rejected')
    case 'invalid_code': return t('cloud.err.code')
    case 'agent_unavailable': return t('cloud.err.agent')
    case 'export_failed': return t('cloud.err.export')
    default: return t('cloud.err.default')
  }
}

/**
 * Where "Sign in" goes without asking: the organization this device is enrolled with or provisioned for, else the
 * server of an earlier sign-in, else WorkSuite Cloud (same order as signInTarget() in electron/webapps.ts).
 */
export function defaultSignInTarget(info: Pick<DeviceInfo, 'server' | 'provisioning'> | null, accounts: Pick<CloudAccount, 'server_url'>[]): { mode: 'personal' | 'enterprise'; server: string } {
  const https = (u: string | null | undefined): u is string => { try { return !!u && new URL(u).protocol === 'https:' } catch { return false } }
  const org = [info?.server, info?.provisioning?.server].find(https)
  if (org) return { mode: 'enterprise', server: org }
  const prev = accounts.find((a) => https(a.server_url))
  if (prev && !new URL(prev.server_url).hostname.endsWith('worksuitecloud.com')) return { mode: 'enterprise', server: prev.server_url }
  return { mode: 'personal', server: '' }
}

/** "work.example.com" → "https://work.example.com"; personal mode uses WorkSuite Cloud. */
export function serverUrlFor(mode: 'personal' | 'enterprise', server: string): string {
  if (mode === 'personal') return 'https://worksuitecloud.com'
  const s = server.trim()
  return /^[a-z]+:\/\//i.test(s) ? s : `https://${s}`
}

export const os: WorkSuiteApi = (typeof window !== 'undefined' && window.worksuite) || withAppCenterPreview(stub)

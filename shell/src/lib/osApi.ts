// The typed renderer API the preload exposes as `window.worksuite` (from os.ts).
import type { DesktopModule } from './launcher'
import type { HwDevice } from '../../electron/hardware'
import type { RadioDiagnosis, RadioFix, RadioKind } from '../../electron/radios'
import type { GraphicsState, RendererChoice } from '../../electron/graphics'
import type { LocalUser } from '../../electron/users'
import type { SignInMethod, SignInMethods, SigninResult } from '../../electron/signin'
import type { SearchHit, SearchResponse, SourceState } from '../../electron/search'
import { type WidgetsSnapshot } from '../../electron/widgets'
import type { SyncStatus } from './syncNotices'
import type { CheckId, CheckResult, SnapshotInfo } from './recovery'
import { type Avail, type NetworkState, type VpnState, type BluetoothState, type SoundState, type BatteryState, type Printer, type Display, type Drive, type RecoveryInfo, type DriverReport, type PackagePreview, type OsUpdateStatus, type AppRequest, type UpdateHistory, type AppUpdate, type AppCatalog, type LocalDebPreview, type AppPermissions, type FoundBundle, type BundleInfo, type AppImageRecord, type UpdateSummary, type FilePlaces, type DiskVolume, type FileHit, type TrashItem, type FileJob, type CompressOptions, type ArchiveListing, type FileEntry, type ProblemReport, type PackageJobEvent } from './osTypes'
import { type DeviceInfo, type SecurityStatus, type ActivityStatus, type ActivityRemote, type LockSettings, type InstalledApp, type SignOutChoice, type CloudAccount, type SecurityMethod, type CloudResult } from './osDevice'

export interface WorkSuiteApi {
  /** method 'pin' sends the PIN where the password goes; 'key' sends no secret (pam_u2f asks for a touch). */
  /** reason (PIN): 'pin_locked' after too many wrong PINs, 'unavailable' when the PIN service can't be reached. */
  authenticate(user: string, password: string, method?: SignInMethod): Promise<{ ok: boolean; message?: string; reason?: string }>
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
  installedApps(): Promise<{ apps: InstalledApp[]; office: string | null; desktop?: string | null; frameflow?: string | null; pos?: string | null }>
  /** WorkSuite Office: 'start' (start centre) or a new 'docs' | 'sheets' | 'slides' document. */
  launchOffice(kind: 'start' | 'docs' | 'sheets' | 'slides'): Promise<void>
  /** WorkSuite Desktop with --module=<id> (only when installed; the launcher checks). */
  launchWorkSuite(module: DesktopModule): Promise<void>
  // WorkSuite cloud identity through the credentials broker (SRS §8.1). Tokens never reach the renderer.
  cloudSignIn(serverUrl: string, mode: 'personal' | 'enterprise'): Promise<CloudResult<CloudAccount>>
  /** #55: is this a reachable WorkSuite server over trusted https? Discovery only (nothing stored, no browser). */
  cloudCheckServer(serverUrl: string): Promise<CloudResult<{ server_url: string; issuer: string }>>
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
  securityAction(method: SecurityMethod, ...args: string[]): Promise<CloudResult<unknown>>
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
  /** This Computer (#63): disk partitions and volumes (udisks2). Errors: unavailable, failed. */
  filesVolumes(): Promise<CloudResult<DiskVolume[]>>
  /** Mount a volume (polkit may ask for an administrator); value: the Files root that opens it. */
  filesVolMount(device: string): Promise<CloudResult<string>>
  filesVolUnmount(device: string): Promise<CloudResult<true>>
  /** Safely remove the drive the volume lies on (unmount every volume on it, then power it off). */
  filesVolEject(device: string): Promise<CloudResult<true>>
  /** A drive was plugged in or removed, or a volume mounted or unmounted (udisks2). */
  onFilesVolumes(cb: () => void): () => void
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

declare global {
  interface Window { worksuite?: WorkSuiteApi }
}

// System, recovery, hardware, driver, package and file types of the renderer API (from os.ts).
import type { HwDevice, HwKind } from '../../electron/hardware'
import type { LocalUser } from '../../electron/users'
import type { SecurityKey, SignInMethod, SignInMethods, SigninResult } from '../../electron/signin'

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
  state: 'idle' | 'checking' | 'off' | 'error' | 'offline'; checked_at: number | null; online_search: boolean; metered: boolean; secure_boot: boolean
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
export interface DiskVolume {
  device: string; disk: string; label: string; model: string; fstype: string; kind: 'system' | 'internal' | 'removable' | 'optical'
  size: number; mountpoint: string | null; total: number | null; free: number | null; encrypted: boolean; locked: boolean; readOnly: boolean
  /** The Files root that opens it when mounted. */
  root: string | null
}
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

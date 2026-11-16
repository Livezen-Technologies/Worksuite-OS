// Browser preview only (never in Electron): fixed data and helpers behind the stub API (from os.ts).
import type { HwDevice, HwKind } from '../../electron/hardware'
import { type Avail, type NetworkState, type VpnConnection, type BluetoothState, type SoundState, type DriverOffer, type DriverReport, type OsUpdateStatus, type DiskVolume, type FileJob, type FileEntry, type PackageJobEvent } from './osTypes'

export function stubAvail<T>(value: T): Avail<T> {
  return stubSim === 'none' ? { available: false, reason: 'service_unavailable' } : { available: true, value: structuredClone(value) }
}
export const stubSys: { net: NetworkState; bt: BluetoothState; sound: SoundState; vpn: VpnConnection[] } = {
  vpn: [{ name: 'WorkSuite VPN', uuid: '6f1d9a52-3c47-4b8e-9a0d-57e2c1b4f0a3', type: 'wireguard', kind: 'wireguard', active: true, device: 'wsvpn0', managed: true, needs_credentials: false }],
  net: { wifi_enabled: true, devices: [{ device: 'wlan0', type: 'wifi', state: 'connected', connection: 'Preview-WiFi' }, { device: 'eth0', type: 'ethernet', state: 'unavailable', connection: null }],
    networks: [{ ssid: 'Preview-WiFi', signal: 82, security: 'WPA2', in_use: true }, { ssid: 'Guest', signal: 54, security: '', in_use: false }] },
  bt: { powered: false, name: 'preview-laptop', discoverable: false, paired: [{ address: 'AA:BB:CC:DD:EE:01', name: 'Preview keyboard', connected: false }] },
  sound: { volume: 60, muted: false, outputs: [{ id: 46, name: 'Built-in speakers', is_default: true }, { id: 51, name: 'HDMI output', is_default: false }], inputs: [{ id: 47, name: 'Built-in microphone', is_default: true }] },
}

// Preview only: `?sim=none` shows the recovery screens as on a host where none of the optional services exist.
export const stubSim = typeof location !== 'undefined' ? new URLSearchParams(location.search).get('sim') ?? 'preview' : 'preview'
export const stubWait = (ms: number) => new Promise((r) => setTimeout(r, ms))
// Browser preview only (never in Electron): ?upd=available|downloading|ready|forced|failed|whatsnew|uptodate,
// ?hw=catalog|new|problem, ?sim=none drive the stub into each board's state.
export const PV = new URLSearchParams(typeof location === 'undefined' ? '' : location.search)
export const stubStart = Date.now()
export const dev = (id: string, name: string, vendor: string | null, kind: HwKind, bus: 'usb' | 'pci', driver: string | null, extra: Partial<HwDevice> = {}): HwDevice =>
  ({ id, name, vendor, kind, bus, built_in: bus === 'pci', driver, driver_version: null, driver_proprietary: driver ? false : null, ids: '0000:0000', ...extra })
export const STUB_DEVICES: HwDevice[] = [
  dev('usb:1-1', 'USB Keyboard', 'Preview', 'keyboard', 'usb', 'usbhid'),
  dev('usb:1-3', 'USB Printer', 'Preview', 'printer', 'usb', 'usblp'),
  dev('pci:0000:00:14.3', 'Wireless adapter', 'Preview', 'wireless', 'pci', 'iwlwifi'),
  dev('pci:0000:00:02.0', 'Integrated graphics', 'Preview', 'graphics', 'pci', 'i915'),
  dev('pci:0000:00:1f.3', 'Audio controller', 'Preview', 'audio', 'pci', 'snd_hda_intel'),
]
export const STUB_NEW = dev('usb:1-2', 'USB Camera', 'Preview', 'camera', 'usb', 'uvcvideo', { driver_version: '1.1.1' })
export const stubDriverListeners = new Set<(r: DriverReport) => void>()
/** ?hw=drivers: Wi-Fi missing firmware, Ethernet working, a firmware update; ?hw=nvidia adds an NVIDIA GPU on nouveau
 *  (&sb=1: Secure Boot on). */
export function stubReport(hw: string | null): DriverReport {
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
export const STUB_OFFERS: DriverOffer[] = [
  { id: 'drv-gfx', device_id: 'pci:0000:00:02.0', name: 'Graphics driver (preview)', summary: 'Preview catalog entry', from_version: '1.0', to_version: '1.1', license: 'proprietary', category: 'optional', size_bytes: 140e6, restart: true },
  { id: 'drv-cam', device_id: 'usb:1-2', name: 'Camera driver (preview)', summary: 'Preview catalog entry', from_version: null, to_version: '2.0', license: 'open', category: 'recommended', size_bytes: 4e6, restart: false },
  { id: 'drv-wifi', device_id: 'pci:0000:00:14.3', name: 'Wi-Fi firmware (preview)', summary: 'Preview catalog entry', from_version: '83', to_version: '86', license: 'open', category: 'security', size_bytes: 2e6, restart: false },
]

// Preview only: package jobs finish after a short delay.
export const stubListeners = new Set<(e: PackageJobEvent) => void>()
export function stubUpdateState(k: string | null): OsUpdateStatus {
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
export const stubJobs = new Map<string, { job: FileJob; paused: boolean; step: number }>()
export const stubEmit = (e: FileJob) => stubFileJobs.forEach((l) => l(e))
export const stubVolumes: DiskVolume[] = [
  { device: '/dev/nvme0n1p2', disk: '/dev/nvme0n1', label: '', model: 'Samsung SSD 980', fstype: 'ext4', kind: 'system', size: 475e9, mountpoint: '/', total: 468e9, free: 301e9, encrypted: true, locked: false, readOnly: false, root: 'home' },
  { device: '/dev/sda1', disk: '/dev/sda', label: 'Data', model: 'WDC WD10EZEX', fstype: 'ntfs', kind: 'internal', size: 1e12, mountpoint: null, total: null, free: null, encrypted: false, locked: false, readOnly: false, root: null },
  { device: '/dev/sdb1', disk: '/dev/sdb', label: 'KINGSTON', model: 'DataTraveler 3.0', fstype: 'vfat', kind: 'removable', size: 31e9, mountpoint: '/media/alex/KINGSTON', total: 31e9, free: 18e9, encrypted: false, locked: false, readOnly: false, root: 'media:KINGSTON' },
]
export const stubFileJobs = new Set<(e: FileJob) => void>()
export function STUB_DOCS(): FileEntry[] {
  const day = 86_400_000, now = Date.now()
  const e = (name: string, ago: number, size: number | null, items?: number): FileEntry => ({ name, dir: items != null, size, modified: now - ago * day, state: 'local', local: true, ...(items != null ? { items } : {}) })
  return [e('Archive', 13, null, 230), e('Contracts', 3, null, 7), e('Invoices', 1, null, 48), e('Projects', 0, null, 12),
    e('Budget 2027.xlsx', 0, 2_400_000), e('Brand guide.pdf', 14, 8_100_000), e('Logo export.png', 4, 640_000), e('Meeting notes.md', 5, 6_000),
    e('Proposal v3.docx', 6, 312_000), e('Q4 plan draft.docx', 0, 184_000), e('Roadmap.pptx', 17, 5_600_000), e('Signed NDA.pdf', 3, 220_000), e('Team offsite.pptx', 1, 12_000_000)]
}
export const stubOsListeners = new Set<(s: OsUpdateStatus) => void>()

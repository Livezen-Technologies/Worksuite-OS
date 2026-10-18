// Driver and firmware search (Settings › Drivers): pure logic, no I/O. The scanner (driverscan.ts) feeds it sysfs
// devices, the kernel log, Debian's non-free-firmware Contents index, isenkram and fwupd, and acts on what it decides.

/** A device as sysfs shows it. id matches the shell's device ids ("pci:0000:00:14.3", "usb:1-2"). */
export interface ScannedDevice {
  id: string;
  bus: string;
  /** Every modalias of the device (USB: one per interface). */
  modaliases: string[];
  /** Bound kernel driver, null = none. */
  driver: string | null;
  /** A kernel module exists for one of the modaliases (modules.alias), even if nothing is bound. */
  module: string | null;
  /** PCI class ("0x030000") or USB interface classes; used for kind. */
  cls: string;
  vendor: string; // 4 hex digits, lower case
  product: string;
}

export type DeviceKind = 'wifi' | 'ethernet' | 'display' | 'bluetooth' | 'other';
export type DriverStatus = 'working' | 'missing_firmware' | 'update_available' | 'optional_driver' | 'no_driver';
export type OfferKind = 'firmware' | 'dkms' | 'fwupd' | 'gpu';

export interface DriverOffer {
  id: string;
  device_id: string | null;
  kind: OfferKind;
  /** Debian packages to install (firmware, dkms, gpu), or the fwupd device id (fwupd). */
  packages: string[];
  fwupd_device?: string;
  name: string;
  summary: string;
  from_version: string | null;
  to_version: string;
  license: 'open' | 'proprietary';
  category: 'security' | 'recommended' | 'optional';
  size_bytes: number | null;
  restart: boolean;
  /** Kernel module to reload after installing (firmware for a loaded driver). */
  reload?: string | null;
}

export interface DeviceReport { id: string; kind: DeviceKind; driver: string | null; status: DriverStatus; offers: string[] }

export interface DriverReport {
  state: 'idle' | 'checking' | 'off' | 'error';
  checked_at: number | null;
  online_search: boolean;
  metered: boolean;
  secure_boot: boolean;
  devices: DeviceReport[];
  offers: DriverOffer[];
  /** Offers installed automatically in the last check. */
  auto_installed: string[];
  /** Set after a GPU fallback (nvidia → nouveau) on the last boot. */
  gpu_fallback?: boolean;
  /** Secure Boot: a MOK enrolment is waiting for the next restart (one-time password for MokManager). */
  mok?: { password: string; pending: boolean };
}

// ---------- policy ----------

/** Device policy fields (server POLICY_FIELDS, device agent Policy). Unmanaged: the defaults. */
export interface DriverPolicyFields {
  drivers_online_search?: boolean;
  drivers_auto_install?: boolean;
  drivers_auto_install_gpu?: boolean;
  kiosk?: { enabled?: boolean } | null;
}
export interface DriverPolicy { online_search: boolean; auto_firmware: boolean; auto_gpu: boolean }

/** Defaults: search on, firmware installs itself, DKMS and GPU drivers never without a person (or the GPU policy).
 *  Kiosk: search on, firmware only, whatever else the policy says. */
export function driverPolicy(p: DriverPolicyFields | null | undefined): DriverPolicy {
  if (p?.kiosk && p.kiosk.enabled === true) return { online_search: true, auto_firmware: true, auto_gpu: false };
  return {
    online_search: p?.drivers_online_search !== false,
    auto_firmware: p?.drivers_auto_install !== false,
    auto_gpu: p?.drivers_auto_install_gpu === true,
  };
}

/** Big downloads wait on metered connections (the same rule as OS updates, AUP-008). */
export const METERED_AUTO_LIMIT = 25e6;

/** Which offers install themselves: firmware from the signed Debian archive (policy), the NVIDIA driver only with
 *  drivers_auto_install_gpu and never under Secure Boot (MOK enrolment needs a person at the screen), DKMS never.
 *  Nothing large on a metered connection. */
export function autoInstallable(o: DriverOffer, pol: DriverPolicy, ctx: { metered: boolean; secureBoot: boolean }): boolean {
  if (ctx.metered && (o.size_bytes == null || o.size_bytes > METERED_AUTO_LIMIT)) return false;
  if (o.kind === 'firmware') return pol.auto_firmware;
  if (o.kind === 'gpu') return pol.auto_gpu && !ctx.secureBoot;
  return false;
}

// ---------- trigger ----------

export const DAY = 86_400_000;
export type CheckReason = 'connectivity' | 'timer' | 'manual';
export interface TriggerState { last_check?: number; hw_fingerprint?: string; last_manual?: number }

/** Connectivity and the timer check at most once a day, sooner only when the hardware changed; a person may check
 *  any time (at most once a minute, so the button can't hammer the mirror). */
export function shouldCheck(st: TriggerState, reason: CheckReason, now: number, fingerprint: string, pol: DriverPolicy): boolean {
  if (!pol.online_search) return false;
  if (reason === 'manual') return !st.last_manual || now - st.last_manual >= 60_000;
  if (st.hw_fingerprint !== undefined && st.hw_fingerprint !== fingerprint) return true;
  return !st.last_check || now - st.last_check >= DAY || now < st.last_check;
}

export function fingerprint(devs: ScannedDevice[]): string {
  return devs.map((d) => `${d.id}=${d.vendor}:${d.product}`).sort().join(',');
}

// ---------- kernel log ----------

export interface FirmwareFailure { file: string; driver: string | null; device: string | null }

/** "iwlwifi 0000:00:14.3: Direct firmware load for iwlwifi-so-a0-gf-a0-89.ucode failed with error -2",
 *  "bluetooth hci0: Direct firmware load for …", "firmware: failed to load rtl_nic/rtl8168h-2.fw (-2)",
 *  "r8169 0000:02:00.0: Unable to load firmware rtl_nic/rtl8168h-2.fw (-2)". */
export function parseFirmwareFailures(log: string): FirmwareFailure[] {
  const out = new Map<string, FirmwareFailure>();
  for (const line of log.split('\n')) {
    const m = /(?:^|\]\s*|kernel:\s*)(?:([\w-]+) ([\w:.-]+): )?(?:Direct firmware load for (\S+) failed|firmware: failed to load (\S+)|[Uu]nable to load firmware (?:patch )?(\S+?)(?:\s|$))/.exec(line);
    if (!m) continue;
    const file = (m[3] ?? m[4] ?? m[5]).replace(/[(),]+$/, '');
    if (!/^[\w./+-]{1,200}$/.test(file) || file.includes('..')) continue;
    const prev = out.get(file);
    if (!prev || (!prev.driver && m[1])) out.set(file, { file, driver: m[1] ?? null, device: m[2] ?? null });
  }
  return [...out.values()];
}

/** The kernel tries several firmware versions and logs each miss; one that loaded later isn't missing. */
export function stillMissing(fails: FirmwareFailure[], present: (file: string) => boolean): FirmwareFailure[] {
  return fails.filter((f) => !present(f.file));
}

// ---------- Contents index (apt-file-like) ----------

const stripComp = (p: string) => p.replace(/\.(xz|zst)$/, '');

/** Debian Contents lines "usr/lib/firmware/iwlwifi-x.ucode   non-free-firmware/kernel/firmware-iwlwifi" → the packages
 *  holding each wanted firmware file (names relative to /lib/firmware, compressed variants match). */
export function contentsLookup(contents: string, files: string[]): Map<string, string> {
  const want = new Map(files.map((f) => [stripComp(f), f]));
  const out = new Map<string, string>();
  for (const line of contents.split('\n')) {
    const m = /^(?:usr\/)?lib\/firmware\/(\S+)\s+(\S+)$/.exec(line);
    if (!m) continue;
    const f = want.get(stripComp(m[1]));
    if (f && !out.has(f)) out.set(f, m[2].split(',')[0].split('/').pop()!);
  }
  return out;
}

// ---------- modalias matching (DKMS catalog, isenkram-style) ----------

/** fnmatch-style modalias pattern (modules.alias / Modaliases: "pci:v000014E4d00004311sv*sd*bc*sc*i*"). */
export function aliasMatches(pattern: string, alias: string): boolean {
  let re = '';
  for (let i = 0; i < pattern.length; i++) {
    const c = pattern[i];
    if (c === '*') re += '.*';
    else if (c === '?') re += '.';
    else if (c === '[') { const j = pattern.indexOf(']', i); if (j < 0) { re += '\\['; continue; } re += `[${pattern.slice(i + 1, j).replace(/\\/g, '\\\\')}]`; i = j; }
    else re += c.replace(/[.+^${}()|\\]/g, '\\$&');
  }
  return new RegExp(`^${re}$`, 'i').test(alias);
}

export interface CatalogEntry { package: string; arches: string[]; patterns: string[]; name: string; summary: string; license: 'open' | 'proprietary'; restart: boolean; size: number }

const pciAlias = (vendor: string, devs: string[]) => devs.map((d) => `pci:v0000${vendor.toUpperCase()}d0000${d.toUpperCase()}sv*sd*bc*sc*i*`);

/** Out-of-tree drivers Debian ships as DKMS (non-free). Only for devices the kernel has no driver for. */
export const DKMS_CATALOG: CatalogEntry[] = [
  { package: 'broadcom-sta-dkms', arches: ['amd64'], name: 'Broadcom Wi-Fi driver (wl)', summary: 'For Broadcom BCM43xx Wi-Fi cards the built-in drivers don’t support', license: 'proprietary', restart: true, size: 3e6,
    patterns: pciAlias('14e4', ['4311', '4312', '4313', '4315', '4328', '4329', '432a', '432b', '432c', '432d', '4353', '4357', '4358', '4359', '4365', '43a0', '43b1', '4727']) },
  { package: 'r8168-dkms', arches: ['amd64', 'arm64'], name: 'Realtek RTL8168 Ethernet driver', summary: 'Realtek’s own driver for RTL8111/8168 Ethernet', license: 'open', restart: false, size: 1e6, patterns: pciAlias('10ec', ['8168', '8161', '8136']) },
  { package: 'r8125-dkms', arches: ['amd64', 'arm64'], name: 'Realtek RTL8125 2.5G Ethernet driver', summary: 'Realtek’s own driver for RTL8125 2.5 Gb Ethernet', license: 'open', restart: false, size: 1e6, patterns: pciAlias('10ec', ['8125', '3000']) },
];

export function dkmsFor(d: ScannedDevice, arch: string): CatalogEntry | null {
  if (d.driver || d.module) return null;   // the kernel handles it: no optional out-of-tree driver
  return DKMS_CATALOG.find((e) => e.arches.includes(arch) && d.modaliases.some((a) => e.patterns.some((p) => aliasMatches(p, a)))) ?? null;
}

/** isenkram-lookup prints package names, one per line; keep driver and firmware packages only. */
export function parseIsenkram(out: string): string[] {
  return [...new Set(out.split('\n').map((l) => l.trim()).filter((l) => /^[a-z0-9][a-z0-9+.-]{1,99}$/.test(l) && /^(firmware-|.*-firmware$|.*-dkms$|wireless-regdb$)/.test(l)))];
}

// ---------- GPUs ----------

/** NVIDIA in trixie: nvidia-driver (550) for Maxwell and newer, nvidia-tesla-535-driver for data-centre cards, nothing
 *  for Kepler and older (470/390 left Debian) — those keep nouveau. Same split as Debian's nvidia-detect. */
export type NvidiaPick = { package: 'nvidia-driver' | 'nvidia-tesla-535-driver'; series: string } | { package: null; reason: 'too_old' };

export function nvidiaPick(deviceId: string, cls: string): NvidiaPick {
  const id = parseInt(deviceId, 16);
  if (!Number.isFinite(id)) return { package: null, reason: 'too_old' };
  // 3D controller class (0x0302) without display output = compute card (Tesla / data centre).
  if (/^(0x)?0302/.test(cls) && id >= 0x1340) return { package: 'nvidia-tesla-535-driver', series: '535' };
  // GM108 (0x134x) is the first Maxwell id; everything from there is in the 550 series' supported list.
  return id >= 0x1340 ? { package: 'nvidia-driver', series: '550' } : { package: null, reason: 'too_old' };
}

export function isDisplay(d: ScannedDevice) { return d.bus === 'pci' && /^(0x)?03/.test(d.cls); }
export function deviceKind(d: ScannedDevice): DeviceKind {
  if (d.bus === 'pci') {
    const c = d.cls.replace(/^0x/, '');
    if (c.startsWith('0280')) return 'wifi';
    if (c.startsWith('02')) return 'ethernet';
    if (c.startsWith('03')) return 'display';
    if (c.startsWith('0d11')) return 'bluetooth';
    return 'other';
  }
  if (/\bwlan|80211|wifi|^(rtw|rtl8|mt7|ath9k|carl|ar5523|zd1211|rt2|rt73|brcmfmac|mwifiex)/.test(d.driver ?? d.module ?? '')) return 'wifi';
  if (/^(r8152|ax88179|asix|cdc_ether|cdc_ncm|smsc95|lan78)/.test(d.driver ?? d.module ?? '')) return 'ethernet';
  if (d.cls.split(',').includes('e0')) return 'bluetooth';
  return 'other';
}

export interface GpuState { secureBoot: boolean; mokEnrolled: boolean; nvidiaInstalled: boolean }

/** The NVIDIA offer for an NVIDIA GPU still on nouveau (or nothing). Under Secure Boot the summary explains the MOK
 *  step; it stays an offer (the dialog walks through it) — automatic installs skip it (autoInstallable). */
export function gpuOffer(d: ScannedDevice, gs: GpuState, arch: string): DriverOffer | null {
  if (!isDisplay(d) || d.vendor !== '10de' || gs.nvidiaInstalled || d.driver === 'nvidia') return null;
  const pick = nvidiaPick(d.product, d.cls);
  if (!pick.package) return null;
  const headers = arch === 'arm64' ? 'linux-headers-arm64' : 'linux-headers-amd64';
  return {
    id: `gpu:${pick.package}`, device_id: d.id, kind: 'gpu', packages: [pick.package, 'nvidia-kernel-dkms', headers],
    name: 'NVIDIA proprietary driver', summary: gs.secureBoot ? 'nvidia_secure_boot' : 'nvidia_better',
    from_version: null, to_version: pick.series, license: 'proprietary', category: 'recommended', size_bytes: 400e6, restart: true,
  };
}

/** Rollback rule: the nvidia driver was installed and the graphical session didn't come up on the next boot
 *  (greeter health check failed, or the nvidia module isn't loaded) → go back to nouveau. */
export function needsGpuFallback(s: { nvidiaInstalled: boolean; pendingBoot: boolean; greeterOk: boolean; nvidiaLoaded: boolean }): boolean {
  return s.nvidiaInstalled && s.pendingBoot && (!s.greeterOk || !s.nvidiaLoaded);
}

/** The display driver in use, in words people know. */
export function displayDriverLabel(driver: string | null, nvidiaVersion: string | null): string | null {
  if (!driver) return null;
  if (driver === 'nvidia') return nvidiaVersion ? `NVIDIA ${nvidiaVersion.split('.')[0]}` : 'NVIDIA';
  if (driver === 'amdgpu' || driver === 'radeon') return `Mesa (${driver})`;
  if (driver === 'i915' || driver === 'xe') return `Mesa (${driver})`;
  if (driver === 'nouveau') return 'Mesa (nouveau)';
  return driver;
}

// ---------- report ----------

export function deviceStatuses(devs: ScannedDevice[], fails: FirmwareFailure[], offers: DriverOffer[]): DeviceReport[] {
  return devs.map((d) => {
    const mine = offers.filter((o) => o.device_id === d.id);
    const pciAddr = d.id.replace(/^pci:/, '');
    const fwMissing = fails.some((f) => (f.device && f.device === pciAddr) || (f.driver && (f.driver === d.driver || f.driver === d.module)));
    let status: DriverStatus = 'working';
    if (fwMissing || mine.some((o) => o.kind === 'firmware')) status = 'missing_firmware';
    else if (mine.some((o) => o.kind === 'fwupd')) status = 'update_available';
    else if (mine.some((o) => o.kind === 'dkms' || o.kind === 'gpu')) status = d.driver ? 'optional_driver' : 'no_driver';
    else if (!d.driver) status = 'no_driver';
    return { id: d.id, kind: deviceKind(d), driver: d.driver, status, offers: mine.map((o) => o.id) };
  });
}

/** fwupdmgr get-updates --json → offers. */
export function parseFwupd(json: string): DriverOffer[] {
  let data: { Devices?: { Name?: string; DeviceId?: string; Version?: string; Releases?: { Version?: string; Size?: number; Summary?: string; Urgency?: string }[] }[] };
  try { data = JSON.parse(json); } catch { return []; }
  const out: DriverOffer[] = [];
  for (const d of data.Devices ?? []) {
    const r = d.Releases?.[0];
    if (!d.DeviceId || !/^[0-9a-f]{40}$/.test(d.DeviceId) || !r?.Version) continue;
    out.push({
      id: `fwupd:${d.DeviceId}`, device_id: null, kind: 'fwupd', packages: [], fwupd_device: d.DeviceId,
      name: `${d.Name ?? 'Device'} firmware`, summary: r.Summary ?? '', from_version: d.Version ?? null, to_version: r.Version,
      license: 'proprietary', category: r.Urgency === 'critical' || r.Urgency === 'high' ? 'security' : 'recommended',
      size_bytes: typeof r.Size === 'number' ? r.Size : null, restart: true,
    });
  }
  return out;
}

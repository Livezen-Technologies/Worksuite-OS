// Hardware and update inventory read from sysfs and the package service's status file (WSOS-MDM-001). Pure reads under
// a root directory so tests can run against a fake tree. Only facts the kernel reports: nothing is guessed or filled in.
import { existsSync, readdirSync, readFileSync, readlinkSync } from 'node:fs';
import { join } from 'node:path';

export const UPDATE_STATUS_FILE = '/run/worksuite-package-service/update-status.json';

const read = (p: string) => { try { return readFileSync(p, 'utf8').trim(); } catch { return ''; } };
const list = (p: string) => { try { return readdirSync(p).sort(); } catch { return []; } };
const num = (s: string) => (s && /^\d+$/.test(s) ? Number(s) : null);

export interface Disk { name: string; model: string | null; size_bytes: number; rotational: boolean; removable: boolean; transport: string | null }
export interface NetAdapter { name: string; mac: string | null; kind: 'wifi' | 'ethernet' | 'other'; driver: string | null }
export interface Gpu { pci_vendor: string; pci_device: string; driver: string | null }
export interface Battery { name: string; design_wh: number | null; full_wh: number | null; health_percent: number | null; cycle_count: number | null }
export interface Hardware {
  vendor: string | null; model: string | null; serial: string | null; bios_version: string | null; board: string | null;
  firmware: 'uefi' | 'bios'; disks: Disk[]; network: NetAdapter[]; gpus: Gpu[]; batteries: Battery[];
}

/** Kernel driver bound to a device: the basename of its `driver` symlink. */
const driverOf = (dev: string) => { try { return readlinkSync(join(dev, 'driver')).split('/').pop() || null; } catch { return null; } };

export function collectHardware(root = '/'): Hardware {
  const sys = (p: string) => join(root, 'sys', p);
  const dmi = (k: string) => read(sys(`class/dmi/id/${k}`)) || null;

  const disks: Disk[] = [];
  for (const name of list(sys('block'))) {
    if (/^(loop|ram|zram|dm-|md|sr|fd)/.test(name)) continue;
    const b = sys(`block/${name}`);
    const sectors = num(read(join(b, 'size')));
    if (!sectors) continue;
    const transport = /^nvme/.test(name) ? 'nvme' : /^mmcblk/.test(name) ? 'mmc' : read(join(b, 'device/transport')) || null;
    disks.push({ name, model: read(join(b, 'device/model')) || null, size_bytes: sectors * 512, rotational: read(join(b, 'queue/rotational')) === '1', removable: read(join(b, 'removable')) === '1', transport });
  }

  const network: NetAdapter[] = [];
  for (const name of list(sys('class/net'))) {
    const n = sys(`class/net/${name}`);
    if (name === 'lo' || !existsSync(join(n, 'device'))) continue;   // virtual interfaces have no device
    const kind = existsSync(join(n, 'wireless')) || existsSync(join(n, 'phy80211')) ? 'wifi' : read(join(n, 'type')) === '1' ? 'ethernet' : 'other';
    network.push({ name, mac: read(join(n, 'address')) || null, kind, driver: driverOf(join(n, 'device')) });
  }

  const gpus: Gpu[] = [];
  for (const name of list(sys('class/drm'))) {
    if (!/^card\d+$/.test(name)) continue;
    const d = sys(`class/drm/${name}/device`);
    const vendor = read(join(d, 'vendor')), device = read(join(d, 'device'));
    if (vendor) gpus.push({ pci_vendor: vendor, pci_device: device, driver: driverOf(d) });
  }

  const batteries: Battery[] = [];
  for (const name of list(sys('class/power_supply'))) {
    const p = sys(`class/power_supply/${name}`);
    if (read(join(p, 'type')) !== 'Battery') continue;
    // energy_* in µWh, or charge_* in µAh with voltage_min_design in µV
    let design = num(read(join(p, 'energy_full_design'))), full = num(read(join(p, 'energy_full')));
    if (design === null) {
      const v = num(read(join(p, 'voltage_min_design'))), cd = num(read(join(p, 'charge_full_design'))), cf = num(read(join(p, 'charge_full')));
      if (v !== null && cd !== null) { design = (cd * v) / 1e6; full = cf !== null ? (cf * v) / 1e6 : null; }
    }
    const wh = (x: number | null) => (x === null ? null : Math.round(x / 1e4) / 100);
    batteries.push({ name, design_wh: wh(design), full_wh: wh(full), health_percent: design && full !== null ? Math.round((full / design) * 100) : null, cycle_count: num(read(join(p, 'cycle_count'))) });
  }

  return {
    vendor: dmi('sys_vendor'), model: dmi('product_name'), serial: dmi('product_serial'), bios_version: dmi('bios_version'),
    board: [dmi('board_vendor'), dmi('board_name')].filter(Boolean).join(' ') || null,
    firmware: existsSync(sys('firmware/efi')) ? 'uefi' : 'bios', disks, network, gpus, batteries,
  };
}

/** The package service's update coordinator status (WSOS-AUP-011), or null when it hasn't published one. */
export function readUpdateStatus(path = UPDATE_STATUS_FILE): { state: string; installed: string | null; version: string | null; last_check: number | null; reason: string | null } | null {
  try {
    const s = JSON.parse(readFileSync(path, 'utf8'));
    if (typeof s?.state !== 'string') return null;
    return { state: s.state, installed: s.installed ?? null, version: s.version ?? null, last_check: s.last_check ?? null, reason: s.reason ?? null };
  } catch { return null; }
}

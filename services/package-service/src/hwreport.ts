// Hardware report at installation (installer shellprocess, chrooted into the new system with the live /sys, /proc, /dev):
// every PCI and USB device of THIS computer, the kernel driver bound to it, firmware the kernel asked for and the
// installed system does not have, and drivers that need a person (NVIDIA, DKMS). Nothing is downloaded or installed
// here: firmware from the signed Debian archive installs itself at the first connected start (DriverManager,
// auto_firmware), proprietary/DKMS drivers wait for approval in WorkSuite Settings › Drivers.
//
//   worksuite-node hwreport.ts [--out FILE] [--root /]
//
// Writes JSON (default /var/lib/worksuite-package-service/install-hardware.json) and prints one line per device that
// is not simply working, so the installer log says exactly which device lacks what.
import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { deviceKind, deviceStatuses, dkmsFor, isDisplay, nvidiaPick, parseFirmwareFailures, stillMissing, type DeviceReport, type DriverOffer, type ScannedDevice } from './drivers.ts';
import { firmwarePresent, parseModulesAlias, scanSysfs } from './driverscan.ts';

export interface HardwareReport {
  generated_at: string; kernel: string; arch: string;
  devices: (DeviceReport & { vendor: string; product: string; name: string | null })[];
  missing_firmware: { file: string; driver: string | null; device: string | null }[];
  needs_approval: { id: string; device_id: string | null; packages: string[]; why: string }[];
  summary: { total: number; working: number; missing_firmware: number; no_driver: number; optional_driver: number };
}

/** Offline offers: drivers only a person can approve (never installed by the installer). */
export function approvalOffers(devs: ScannedDevice[], arch: string): DriverOffer[] {
  const out: DriverOffer[] = [];
  for (const d of devs) {
    if (isDisplay(d) && d.vendor === '10de') {
      const pick = nvidiaPick(d.product, d.cls);
      if (pick.package) out.push({ id: `gpu:${pick.package}`, device_id: d.id, kind: 'gpu', packages: [pick.package], name: pick.package, summary: 'nvidia_optional', from_version: null, to_version: pick.series,
        license: 'proprietary', category: 'optional', size_bytes: null, restart: true });
    }
    const dk = !d.driver ? dkmsFor(d, arch) : null;
    if (dk) out.push({ id: `dkms:${dk.package}`, device_id: d.id, kind: 'dkms', packages: [dk.package], name: dk.name, summary: dk.summary, from_version: null, to_version: 'debian',
      license: dk.license, category: 'optional', size_bytes: dk.size, restart: dk.restart });
  }
  return out;
}

export function buildReport(devs: ScannedDevice[], kernelLog: string, present: (f: string) => boolean, o: { kernel: string; arch: string; names?: Map<string, string>; now?: Date }): HardwareReport {
  const fails = stillMissing(parseFirmwareFailures(kernelLog), present);
  const offers = approvalOffers(devs, o.arch);
  const statuses = deviceStatuses(devs, fails, offers);
  const devices = statuses.map((s) => {
    const d = devs.find((x) => x.id === s.id)!;
    return { ...s, vendor: d.vendor, product: d.product, name: o.names?.get(`${d.vendor}:${d.product}`) ?? null };
  });
  const count = (st: string) => devices.filter((d) => d.status === st).length;
  return {
    generated_at: (o.now ?? new Date()).toISOString(), kernel: o.kernel, arch: o.arch, devices,
    missing_firmware: fails.map((f) => ({ file: f.file, driver: f.driver, device: f.device })),
    needs_approval: offers.map((x) => ({ id: x.id, device_id: x.device_id, packages: x.packages, why: x.kind === 'gpu' ? 'proprietary NVIDIA driver (optional; approve in WorkSuite Settings › Drivers)' : 'out-of-tree driver (DKMS; approve in WorkSuite Settings › Drivers)' })),
    summary: { total: devices.length, working: count('working'), missing_firmware: count('missing_firmware'), no_driver: count('no_driver'), optional_driver: count('optional_driver') },
  };
}

/** `lspci -nn -mm` / `lsusb` → "vendor:product" → readable name (best effort; missing tools give no names). */
export function parseDeviceNames(lspci: string, lsusb: string): Map<string, string> {
  const m = new Map<string, string>();
  for (const line of lspci.split('\n')) {
    const f = [...line.matchAll(/"([^"]*)"/g)].map((x) => x[1]);
    const v = /\[([0-9a-f]{4})\]$/.exec(f[1] ?? '')?.[1], p = /\[([0-9a-f]{4})\]$/.exec(f[2] ?? '')?.[1];
    if (v && p) m.set(`${v}:${p}`, `${f[1].replace(/\s*\[[0-9a-f]{4}\]$/, '')} ${f[2].replace(/\s*\[[0-9a-f]{4}\]$/, '')}`);
  }
  for (const line of lsusb.split('\n')) {
    const x = /ID ([0-9a-f]{4}):([0-9a-f]{4}) (.+)$/.exec(line);
    if (x) m.set(`${x[1]}:${x[2]}`, x[3].trim());
  }
  return m;
}

const out = (cmd: string, args: string[]) => { try { return execFileSync(cmd, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], maxBuffer: 16 << 20 }); } catch { return ''; } };

if (import.meta.url === `file://${process.argv[1]}`) {
  const arg = (k: string, d: string) => { const i = process.argv.indexOf(k); return i > 0 ? process.argv[i + 1] : d; };
  const file = arg('--out', '/var/lib/worksuite-package-service/install-hardware.json');
  const root = arg('--root', '/');
  const kernel = out('uname', ['-r']).trim();
  let aliases: ReturnType<typeof parseModulesAlias> = [];
  try { aliases = parseModulesAlias(readFileSync(`${root}/lib/modules/${kernel}/modules.alias`, 'utf8')); } catch { /* none */ }
  const devs = scanSysfs(root, aliases);
  const log = out('dmesg', []) || out('journalctl', ['-k', '-b', '-o', 'cat', '--no-pager', '-q']);
  const report = buildReport(devs, log, (f) => firmwarePresent(f, root), {
    kernel, arch: process.arch === 'arm64' ? 'arm64' : 'amd64', names: parseDeviceNames(out('lspci', ['-nn', '-mm']), out('lsusb', [])),
  });
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, JSON.stringify(report, null, 2) + '\n');
  const s = report.summary;
  console.log(`hardware: ${s.total} devices, ${s.working} working, ${s.missing_firmware} missing firmware, ${s.no_driver} without a driver, ${s.optional_driver} with an optional driver`);
  for (const d of report.devices.filter((x) => x.status !== 'working')) console.log(`  ${d.status}: ${d.id} [${d.vendor}:${d.product}] ${d.name ?? deviceKind({ ...d, bus: d.id.split(':')[0], modaliases: [], module: null, cls: '' } as ScannedDevice)} driver=${d.driver ?? 'none'}`);
  for (const f of report.missing_firmware) console.log(`  firmware missing: ${f.file} (driver ${f.driver ?? '?'}) — installs from Debian when connected`);
  for (const a of report.needs_approval) console.log(`  needs approval: ${a.packages.join(' ')} for ${a.device_id} — ${a.why}`);
}

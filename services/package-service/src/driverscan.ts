// Driver manager: scans the hardware, searches online (Debian's non-free-firmware Contents index, isenkram, the DKMS
// catalog, the NVIDIA mapping, fwupd/LVFS), installs what policy allows on its own and keeps the report the shell
// shows in Settings › Drivers. Installs go through the package service's job queue (one APT change at a time).
import { EventEmitter } from 'node:events';
import { randomInt } from 'node:crypto';
import { existsSync, readdirSync, readFileSync, readlinkSync } from 'node:fs';
import { basename, join } from 'node:path';
import type { RunResult } from './service.ts';
import {
  aliasMatches, autoInstallable, contentsLookup, deviceStatuses, dkmsFor, driverPolicy, fingerprint, gpuOffer, needsGpuFallback, parseFirmwareFailures,
  parseFwupd, parseIsenkram, shouldCheck, stillMissing, type CheckReason, type DriverOffer, type DriverPolicyFields, type DriverReport,
  type ScannedDevice, type TriggerState,
} from './drivers.ts';

export interface DriverEnv {
  run(cmd: string, args: string[]): Promise<RunResult>;
  /** Like run, with each stdout line as it comes (apt's Status-Fd progress). Absent: run, without progress. */
  runLines?(cmd: string, args: string[], onLine: (line: string) => void): Promise<RunResult>;
  /** Installed version of a Debian package, null when not installed. */
  version?(pkg: string): string | null;
  devices(): ScannedDevice[];
  /** Kernel log of this boot (journalctl -k -b). */
  kernelLog(): Promise<string>;
  firmwarePresent(file: string): boolean;
  /** Debian non-free-firmware Contents (all + arch), uncompressed; throws when offline. */
  contents(): Promise<string>;
  installed(pkg: string): boolean;
  policy(): DriverPolicyFields | null;
  metered(): Promise<boolean>;
  secureBoot(): boolean;
  arch: string;
  now(): number;
  load(): DriverState;
  save(s: DriverState): void;
  audit(event: string, fields: Record<string, unknown>): void;
  /** This boot's id (/proc/sys/kernel/random/boot_id): the MOK password is dropped after the next boot. */
  bootId(): string;
  writeFile(path: string, text: string): void;
  /** Install packages / firmware through the package service's queue; progress per offer id. */
  /** `subject` names the job in the Update Manager's history. */
  enqueue(caller: number, body: (progress: (phase: string, pct: number) => void) => Promise<void>, subject?: { kind: 'driver' | 'firmware'; title: string; version?: string | null }): number;
}

/** Root-only state (0600): the one-time MOK password lives here, never in the report. */
export type DriverState = TriggerState & { report?: DriverReport; gpu?: { pending_boot?: boolean }; mok?: { password: string; boot: string }; restart_boot?: string };

export class DriverManager extends EventEmitter {
  private report: DriverReport;
  private running: Promise<DriverReport> | null = null;
  private lastKernelLog = '';
  private env: DriverEnv;
  constructor(env: DriverEnv) {
    super();
    this.env = env;
    const pol = driverPolicy(env.policy());
    const st = env.load();
    // The enrolment happens (or is skipped) at the next boot: after that the password is useless, so drop it.
    if (st.mok && st.mok.boot !== env.bootId()) { delete st.mok; if (st.report) delete st.report.mok; env.save(st); env.audit('mok_password_cleared', {}); }
    // A restart asked for by an install is done once the boot id changed.
    if (st.restart_boot && st.restart_boot !== env.bootId()) { delete st.restart_boot; if (st.report) st.report.restart_required = false; env.save(st); }
    this.report = st.report ?? { state: pol.online_search ? 'idle' : 'off', checked_at: null, online_search: pol.online_search, metered: false, secure_boot: env.secureBoot(), devices: [], offers: [], auto_installed: [] };
  }

  status(): DriverReport { return this.report; }

  /** A check: connectivity/timer ones are rate-limited (once a day, or when the hardware changed). */
  check(reason: CheckReason): Promise<DriverReport> {
    if (this.running) return this.running;
    const pol = driverPolicy(this.env.policy());
    const st = this.env.load();
    const devs = this.env.devices();
    const fp = fingerprint(devs);
    if (!shouldCheck(st, reason, this.env.now(), fp, pol)) {
      if (!pol.online_search) this.publish({ ...this.report, state: 'off', online_search: false });
      return Promise.resolve(this.report);
    }
    this.publish({ ...this.report, state: 'checking', online_search: true });
    this.running = this.scan(reason, devs, fp).finally(() => { this.running = null; });
    return this.running;
  }

  private async scan(reason: CheckReason, devs: ScannedDevice[], fp: string): Promise<DriverReport> {
    const e = this.env;
    const pol = driverPolicy(e.policy());
    const metered = await e.metered().catch(() => false);
    const secureBoot = e.secureBoot();
    const offers: DriverOffer[] = [];
    let state: DriverReport['state'] = 'idle';
    this.lastKernelLog = await e.kernelLog().catch(() => '');
    const fails = stillMissing(parseFirmwareFailures(this.lastKernelLog), (f) => e.firmwarePresent(f));
    // (a) firmware files the kernel asked for: Debian's Contents index names the package.
    if (fails.length) {
      try {
        const where = contentsLookup(await e.contents(), fails.map((f) => f.file));
        const byPkg = new Map<string, typeof fails>();
        for (const f of fails) { const p = where.get(f.file); if (p && !e.installed(p)) byPkg.set(p, [...(byPkg.get(p) ?? []), f]); }
        for (const [pkg, fs] of byPkg) {
          const f = fs[0];
          const dev = devs.find((d) => (f.device && d.id === `pci:${f.device}`) || (f.driver && (d.driver === f.driver || d.module === f.driver)));
          offers.push({ id: `fw:${pkg}`, device_id: dev?.id ?? null, kind: 'firmware', packages: [pkg], name: pkg, summary: 'firmware_missing', from_version: null, to_version: 'debian',
            license: 'proprietary', category: 'recommended', size_bytes: null, restart: false, reload: f.driver });
        }
      } catch (err) { state = 'error'; e.audit('drivers_contents_failed', { error: String(err) }); }
    }
    // isenkram (modalias → package, from AppStream): firmware and drivers for this hardware not installed yet.
    const isk = await e.run('isenkram-lookup', []).catch(() => ({ code: 127, stdout: '', stderr: '' }));
    if (isk.code === 0) for (const pkg of parseIsenkram(isk.stdout)) {
      if (e.installed(pkg) || offers.some((o) => o.packages.includes(pkg))) continue;
      offers.push({ id: `fw:${pkg}`, device_id: null, kind: pkg.endsWith('-dkms') ? 'dkms' : 'firmware', packages: [pkg], name: pkg, summary: 'firmware_suggested', from_version: null, to_version: 'debian',
        license: 'proprietary', category: 'optional', size_bytes: null, restart: pkg.endsWith('-dkms') });
    }
    // (b) DKMS drivers for devices the kernel has no driver for; NVIDIA GPUs still on nouveau.
    const headers = e.arch === 'arm64' ? 'linux-headers-arm64' : 'linux-headers-amd64';
    for (const d of devs) {
      const k = dkmsFor(d, e.arch);
      if (k && !e.installed(k.package) && !offers.some((o) => o.packages.includes(k.package))) {
        offers.push({ id: `dkms:${k.package}`, device_id: d.id, kind: 'dkms', packages: [k.package, headers], name: k.name, summary: secureBoot ? 'dkms_secure_boot' : 'dkms_optional',
          from_version: null, to_version: 'debian', license: k.license, category: 'optional', size_bytes: k.size, restart: k.restart });
      }
      const g = gpuOffer(d, { secureBoot, mokEnrolled: false, nvidiaInstalled: e.installed('nvidia-driver') || e.installed('nvidia-tesla-535-driver') }, e.arch);
      if (g && !offers.some((o) => o.id === g.id)) offers.push(g);
    }
    // (c) fwupd/LVFS: refresh metadata (skipped on metered connections), then the updates it knows.
    if (!metered) await e.run('fwupdmgr', ['refresh', '--force', '--assume-yes']).catch(() => null);
    const fw = await e.run('fwupdmgr', ['get-updates', '--json', '--no-unreported-check']).catch(() => ({ code: 127, stdout: '', stderr: '' }));
    if (fw.code === 0) offers.push(...parseFwupd(fw.stdout));

    const report: DriverReport = { state, checked_at: e.now(), online_search: pol.online_search, metered, secure_boot: secureBoot, devices: deviceStatuses(devs, fails, offers), offers, auto_installed: [],
      ...(this.report.installed ? { installed: this.report.installed } : {}), ...(this.report.restart_required ? { restart_required: true } : {}) };
    const auto = offers.filter((o) => autoInstallable(o, pol, { metered, secureBoot }));
    e.audit('drivers_checked', { reason, devices: devs.length, missing_firmware: fails.map((f) => f.file), offers: offers.map((o) => o.id), auto: auto.map((o) => o.id), metered });
    const st = e.load();
    e.save({ ...st, last_check: e.now(), hw_fingerprint: fp, ...(reason === 'manual' ? { last_manual: e.now() } : {}), report });
    this.publish(report);
    if (auto.length) {
      report.auto_installed = auto.map((o) => o.id);
      this.install(0, auto.map((o) => o.id), true);
    }
    return report;
  }

  /** The one-time MOK password, for the administrator who installs (D-Bus GetMokPassword, polkit). null when no
   *  enrolment is pending, or once the key is enrolled. */
  async mokPassword(): Promise<string | null> {
    const st = this.env.load();
    if (!st.mok) return null;
    const t = await this.env.run('mokutil', ['--test-key', '/var/lib/dkms/mok.pub']);
    if (/already enrolled/i.test(t.stdout + t.stderr)) {
      delete st.mok; if (st.report) delete st.report.mok; this.env.save(st);
      this.publish({ ...this.report, mok: undefined });
      return null;
    }
    return st.mok.password;
  }

  /** Install offers (polkit lk.worksuite.drivers.install for people; root for automatic installs). Progress phases are
   *  "<offer id>|<step>": refreshing (apt-get update: a fresh install has no package lists, and the offer may be newer
   *  than them), downloading (APT checks each file against the signed Release file), installing. An error names the
   *  step and carries apt's own "E:" line, not the first warning. What finished stays installed when a later offer
   *  fails; the rest stays offered, so trying again picks up where it stopped. */
  install(caller: number, ids: string[], automatic = false): number {
    const chosen = ids.map((id) => this.report.offers.find((o) => o.id === id)).filter((o): o is DriverOffer => !!o);
    if (!chosen.length) throw Object.assign(new Error('nothing to install'), { code: 'InvalidArgs' });
    return this.env.enqueue(caller, async (progress) => {
      const done: InstalledOffer[] = [];
      try {
        const debs = chosen.filter((o) => o.kind !== 'fwupd');
        if (debs.length) {
          progress(`${debs[0].id}|refreshing`, 2);
          const u = await this.env.run('apt-get', ['-q', 'update']);
          if (u.code !== 0) this.env.audit('drivers_apt_update_failed', { error: aptError(u.stderr) });
        }
        for (const o of chosen) {
          if (o.kind === 'fwupd') {
            // fwupd downloads the cabinet, checks its signature and checksum against the LVFS metadata, then flashes.
            progress(`${o.id}|installing`, 10);
            await this.must('fwupdmgr', ['update', o.fwupd_device!, '--assume-yes', '--no-reboot-check']);
          } else {
            for (const p of o.packages) if (!/^[a-z0-9][a-z0-9+.-]{1,99}$/.test(p)) throw new Error('bad package name');
            const base = ['-y', '-q', '-o', 'APT::Status-Fd=1', '-o', 'Dpkg::Options::=--force-confdef', '-o', 'Dpkg::Options::=--force-confold'];
            progress(`${o.id}|downloading`, 5);
            await this.apt([...base, '--download-only', 'install', '--', ...o.packages], (st) => { if (st.stage === 'download') progress(`${o.id}|downloading`, 5 + Math.round(st.pct * 0.55)); });
            progress(`${o.id}|installing`, 60);
            await this.apt([...base, '--no-download', 'install', '--', ...o.packages], (st) => { if (st.stage === 'install') progress(`${o.id}|installing`, 60 + Math.round(st.pct * 0.35)); });
            // Firmware for a loaded driver: reload it so the device starts now; if it can't be unloaded, a restart finishes it.
            if (o.kind === 'firmware' && o.reload && /^[\w-]{1,64}$/.test(o.reload)) {
              const r = await this.env.run('modprobe', ['-r', o.reload]);
              const ok = r.code === 0 && (await this.env.run('modprobe', [o.reload])).code === 0;
              if (!ok) o.restart = true;
            }
            if (o.kind === 'gpu') { const s = this.env.load(); this.env.save({ ...s, gpu: { pending_boot: true } }); }
            if ((o.kind === 'gpu' || o.kind === 'dkms') && this.env.secureBoot()) await this.enrollMok();
          }
          progress(`${o.id}|done`, 100);
          const version = o.kind === 'fwupd' ? o.to_version : (this.env.version?.(o.packages[0]) ?? o.to_version);
          done.push({ id: o.id, name: o.name, version, restart: o.restart, at: this.env.now() });
          this.env.audit('driver_installed', { caller, offer: o.id, packages: o.packages, version, automatic });
        }
      } finally {
        if (done.length) this.afterInstall(done);
      }
    }, { kind: chosen.every((o) => o.kind === 'fwupd' || o.kind === 'firmware') ? 'firmware' : 'driver', title: chosen.map((o) => o.name).join(', ').slice(0, 200),
      version: chosen.length === 1 ? chosen[0].to_version ?? null : null });
  }

  /** Installed offers leave the list; device statuses are worked out again (firmware now present, driver bound) and the
   *  installed versions and the restart notice go into the report. */
  private afterInstall(done: InstalledOffer[]) {
    const ids = new Set(done.map((d) => d.id));
    const offers = this.report.offers.filter((o) => !ids.has(o.id));
    let devices = this.report.devices.map((d) => ({ ...d, offers: d.offers.filter((id) => !ids.has(id)) }));
    try {
      const devs = this.env.devices();
      const fails = stillMissing(parseFirmwareFailures(this.lastKernelLog), (f) => this.env.firmwarePresent(f));
      devices = deviceStatuses(devs, fails, offers);
    } catch { /* keep the old statuses, minus the installed offers */ }
    const installed = [...done, ...(this.report.installed ?? []).filter((x) => !ids.has(x.id))].slice(0, 20);
    const restart = this.report.restart_required === true || done.some((d) => d.restart);
    const report = { ...this.report, offers, devices, installed, restart_required: restart };
    const st = this.env.load();
    this.env.save({ ...st, report, ...(restart ? { restart_boot: this.env.bootId() } : {}) });
    this.publish(report);
  }

  private async apt(args: string[], onStatus: (s: AptStatus) => void) {
    const r = this.env.runLines
      ? await this.env.runLines('apt-get', args, (l) => { const st = parseAptStatus(l); if (st) onStatus(st); })
      : await this.env.run('apt-get', args);
    if (r.code !== 0) throw new Error(`apt-get: ${aptError(r.stderr || r.stdout)}`);
  }

  /** At boot (after the greeter's health check): an nvidia install whose first boot failed goes back to nouveau. */
  async gpuBootCheck(greeterOk: boolean, nvidiaLoaded: boolean): Promise<boolean> {
    const s = this.env.load();
    const installed = this.env.installed('nvidia-driver') || this.env.installed('nvidia-tesla-535-driver');
    if (!needsGpuFallback({ nvidiaInstalled: installed, pendingBoot: s.gpu?.pending_boot === true, greeterOk, nvidiaLoaded })) {
      if (s.gpu?.pending_boot && greeterOk) this.env.save({ ...s, gpu: { pending_boot: false } });
      return false;
    }
    this.env.audit('gpu_fallback', { greeterOk, nvidiaLoaded });
    await this.env.run('apt-get', ['-y', '-q', 'purge', '--', 'nvidia-driver', 'nvidia-tesla-535-driver', 'nvidia-kernel-dkms', 'nvidia-kernel-support']);
    await this.env.run('update-initramfs', ['-u']);
    this.env.save({ ...s, gpu: { pending_boot: false } });
    this.publish({ ...this.report, gpu_fallback: true });
    return true;
  }

  /** Secure Boot: DKMS signs its modules with /var/lib/dkms/mok.key; the key must be enrolled once (MokManager at the
   *  next boot asks for this one-time password). The shell shows the steps and the password. */
  private async enrollMok() {
    const pub = '/var/lib/dkms/mok.pub';
    const t = await this.env.run('mokutil', ['--test-key', pub]);
    if (/already enrolled/i.test(t.stdout + t.stderr)) return;
    const pw = mokPassword();
    const hash = await this.env.run('mokutil', ['--generate-hash=' + pw]);
    if (hash.code !== 0) throw new Error('mokutil: cannot generate hash');
    const file = '/var/lib/worksuite-package-service/mok.hash';
    this.env.writeFile(file, hash.stdout.trim() + '\n');
    await this.must('mokutil', ['--import', pub, '--hash-file', file]);
    this.env.audit('mok_import_requested', {});
    const st = this.env.load();
    this.env.save({ ...st, mok: { password: pw, boot: this.env.bootId() } });
    this.publish({ ...this.report, mok: { pending: true } });
  }

  private async must(cmd: string, args: string[]) {
    const r = await this.env.run(cmd, args);
    if (r.code !== 0) throw new Error(`${cmd}: ${aptError(r.stderr || r.stdout) || `exit ${r.code}`}`);
  }

  private publish(r: DriverReport) { this.report = r; this.emit('changed', r); }
}

export interface InstalledOffer { id: string; name: string; version: string | null; restart: boolean; at: number }

export interface AptStatus { stage: 'download' | 'install'; pct: number }
/** apt-get -o APT::Status-Fd=1: "dlstatus:2:48.5:Retrieving file 2 of 3", "pmstatus:firmware-iwlwifi:66.7:Installed …". */
export function parseAptStatus(line: string): AptStatus | null {
  const m = /^(dlstatus|pmstatus):[^:]*:([\d.]+):/.exec(line.trim());
  if (!m) return null;
  const pct = Math.max(0, Math.min(100, Number(m[2])));
  return Number.isFinite(pct) ? { stage: m[1] === 'dlstatus' ? 'download' : 'install', pct } : null;
}

/** The line that says what went wrong: apt's first "E:" line (warnings such as "W: Target … is configured multiple
 *  times" come first), else dpkg's "dpkg: error", else the first non-empty line. */
export function aptError(text: string): string {
  const lines = text.split('\n').map((l) => l.trim()).filter(Boolean);
  return lines.find((l) => /^E: /.test(l)) ?? lines.find((l) => /^dpkg: error/.test(l)) ?? lines.find((l) => !/^W: |^N: /.test(l)) ?? lines[0] ?? '';
}

/** Eight digits, shown as 1234-5678: MokManager's keyboard is basic, digits are typed reliably on any layout. */
export function mokPassword(): string { return String(randomInt(0, 1e8)).padStart(8, '0'); }

// ---------- sysfs ----------

const rd = (p: string) => { try { return readFileSync(p, 'utf8').trim(); } catch { return ''; } };
const ls = (p: string) => { try { return readdirSync(p); } catch { return []; } };
const drv = (p: string) => { try { return basename(readlinkSync(join(p, 'driver'))); } catch { return null; } };

/** modules.alias ("alias pci:v00008086d*sv*… iwlwifi") → patterns; only the bus prefixes we look at. */
export function parseModulesAlias(text: string): { pattern: string; module: string }[] {
  const out: { pattern: string; module: string }[] = [];
  for (const l of text.split('\n')) { const m = /^alias ((?:pci|usb|sdio):\S+) (\S+)$/.exec(l); if (m) out.push({ pattern: m[1], module: m[2] }); }
  return out;
}

/** PCI devices and top-level USB devices with their modaliases (USB: every interface's), bound driver and the module
 *  that would handle them. Same ids as the shell's device list. */
export function scanSysfs(root = '/', aliases: { pattern: string; module: string }[] = []): ScannedDevice[] {
  const sys = (...p: string[]) => join(root, 'sys', ...p);
  const moduleFor = (as: string[]) => { for (const a of as) { const hit = aliases.find((x) => aliasMatches(x.pattern, a)); if (hit) return hit.module; } return null; };
  const out: ScannedDevice[] = [];
  for (const addr of ls(sys('bus', 'pci', 'devices'))) {
    const d = sys('bus', 'pci', 'devices', addr);
    const mods = [rd(join(d, 'modalias'))].filter(Boolean);
    out.push({ id: `pci:${addr}`, bus: 'pci', modaliases: mods, driver: drv(d), module: moduleFor(mods), cls: rd(join(d, 'class')),
      vendor: rd(join(d, 'vendor')).replace(/^0x/, '').toLowerCase(), product: rd(join(d, 'device')).replace(/^0x/, '').toLowerCase() });
  }
  for (const name of ls(sys('bus', 'usb', 'devices'))) {
    if (!/^\d+-[\d.]+$/.test(name)) continue;
    const d = sys('bus', 'usb', 'devices', name);
    const ifs = ls(d).filter((n) => n.startsWith(`${name}:`));
    if (ifs.length && ifs.every((i) => rd(join(d, i, 'bInterfaceClass')) === '09')) continue; // hubs
    const mods = ifs.map((i) => rd(join(d, i, 'modalias'))).filter(Boolean);
    const driver = ifs.map((i) => drv(join(d, i))).find((x) => x && x !== 'usbfs') ?? null;
    out.push({ id: `usb:${name}`, bus: 'usb', modaliases: mods, driver, module: moduleFor(mods), cls: ifs.map((i) => rd(join(d, i, 'bInterfaceClass')).toLowerCase()).join(','),
      vendor: rd(join(d, 'idVendor')).toLowerCase(), product: rd(join(d, 'idProduct')).toLowerCase() });
  }
  return out;
}

export function firmwarePresent(file: string, root = '/'): boolean {
  return ['lib/firmware', 'usr/lib/firmware'].some((b) => ['', '.xz', '.zst'].some((ext) => existsSync(join(root, b, file + ext))));
}

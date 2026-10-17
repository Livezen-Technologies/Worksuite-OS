// Package service core: one serialized job queue in front of APT and Flatpak (WSOS-APT-004), policy and
// critical-set checks, previews before any change (WSOS-APP-002), update preconditions (WSOS-UPD-001), repair.
import { EventEmitter } from 'node:events';
import { randomUUID, type KeyObject } from 'node:crypto';
import { join } from 'node:path';
import { renameSync, rmSync } from 'node:fs';
import { extractBundle, inspectBundle, type BundleManifest } from './bundle.ts';
import { stageBundle, stageFile, stagedCopy } from './staging.ts';
import { checkSources, isCritical, parseCatalogId, parseDiskChange, parseSimulation, parseUpgradable, ServiceError, type Plan } from './apt.ts';
import { debFieldsUnprivileged, type Unprivileged } from './untrusted.ts';

export type Source = 'apt' | 'flatpak';
export interface RunResult { code: number; stdout: string; stderr: string }
export interface Runner { run(cmd: string, args: string[]): Promise<RunResult> }

export interface DevicePolicy { app_allowlist?: string[]; approved_remotes?: string[]; /** WSOS-FLP-001: remotes an administrator may add, name → https .flatpakrepo URL. */ flatpak_remotes?: Record<string, string>; allow_local_debs?: boolean; appimages?: 'allow' | 'block' }

export interface Env {
  runner: Runner;
  /** Effective device policy from the device agent; null on an unmanaged device. */
  policy(): DevicePolicy | null;
  /** APT source files to validate before every operation: [path, contents]. */
  sources(): [string, string][];
  /** Hosts of the configured Update Center / organisation mirror, approved as https APT sources besides ALLOWED_HOSTS. */
  updateHosts?(): string[];
  /** AC power, battery percent (null if no battery) and free bytes on / for WSOS-UPD-001. */
  power(): { ac: boolean; battery: number | null };
  freeBytes(): number;
  audit(event: string, fields: Record<string, unknown>): void;
  /** Root-owned spool for staged local .deb copies and extracted bundles (default /var/lib/worksuite-package-service/spool). */
  spool?: string;
  /** Where .wsupdate files may be read from (default: removable media and /home). */
  bundleRoots?: string[];
  /** Release keys, device arch and installed OS version for offline bundles (WSOS-AUP-010). */
  release?: { keys(id: string): KeyObject | undefined; arch: string; installed(): string };
  /** WSOS-SEC-005: account untrusted files are parsed as (default nobody/nogroup). */
  unprivileged?: Unprivileged;
  /** Backoff between download attempts (tests make it instant). */
  sleep?(ms: number): Promise<void>;
}

export interface Preview { source: Source; name: string; plan: Plan; disk_bytes: number | null; permissions: string[]; broad: string[] }
export type JobKind = 'install' | 'remove' | 'update' | 'repair' | 'permissions' | 'prune' | 'remote';

/** WSOS-APT-005: what the confirmation dialog shows for a local .deb. `token` must be passed back to install. */
export interface LocalDebPreview {
  package: string; version: string; architecture: string;
  /** From the package's own Maintainer field: shown as the publisher, never as a verified identity. */
  publisher: string; publisher_verified: false; description: string;
  plan: Plan; disk_bytes: number | null; token: string;
}
export interface Job { id: number; kind: JobKind; caller: number; state: 'queued' | 'running' | 'success' | 'failed' | 'cancelled'; phase: string; error?: string }

const APT_ENV_ARGS = ['-o', 'Dpkg::Options::=--force-confdef', '-o', 'Dpkg::Options::=--force-confold'];
/** WSOS-FLP-002: permissions that must be highlighted. */
const BROAD = [/^filesystems=.*\b(host|home)\b/, /^devices=all/, /^sockets=.*\bx11\b/, /^sockets=.*\bsession-bus\b/, /^shared=.*\bnetwork\b/];
const FLATPAK_DEFAULT_REMOTE = 'flathub';

export class PackageService extends EventEmitter {
  private jobs = new Map<number, Job>();
  private queue: Promise<void> = Promise.resolve();
  private nextId = 1;
  needsRepair = false;
  rebootRequired = false;

  private env: Env;
  constructor(env: Env) { super(); this.env = env; }

  state(): 'idle' | 'busy' | 'interrupted' {
    if (this.needsRepair) return 'interrupted';
    return [...this.jobs.values()].some((j) => j.state === 'queued' || j.state === 'running') ? 'busy' : 'idle';
  }

  /** WSOS-APT-006: an interrupted dpkg run shows up in `dpkg --audit`. */
  async detectInterrupted(): Promise<boolean> {
    const r = await this.env.runner.run('dpkg', ['--audit']);
    this.needsRepair = r.stdout.trim().length > 0;
    if (this.needsRepair) this.env.audit('dpkg_interrupted', {});
    return this.needsRepair;
  }

  /** Read-only preview shown before confirmation (WSOS-APP-002). Same checks as the real operation. */
  async preview(source: Source, catalogId: string, op: 'install' | 'remove'): Promise<Preview> {
    const name = this.authorizeItem(source, catalogId, op);
    if (source === 'apt') {
      this.checkSources();
      const verb = op === 'install' ? 'install' : 'remove';
      const sim = await this.env.runner.run('apt-get', ['-s', '-q', verb, '--', name]);
      if (sim.code !== 0) throw new ServiceError('Failed', firstLine(sim.stderr) || 'simulation failed');
      const plan = parseSimulation(sim.stdout);
      this.refuseCritical(plan);
      const dry = await this.env.runner.run('apt-get', ['--assume-no', '-q', verb, '--', name]);
      return { source, name, plan, disk_bytes: parseDiskChange(dry.stdout + dry.stderr), permissions: [], broad: [] };
    }
    if (op === 'remove') return { source, name, plan: { install: [], upgrade: [], remove: [{ name, version: '' }] }, disk_bytes: null, permissions: [], broad: [] };
    const remote = this.remoteFor(name);
    const info = await this.env.runner.run('flatpak', ['remote-info', '--system', '--show-metadata', remote, name]);
    if (info.code !== 0) throw new ServiceError('NotInCatalog', firstLine(info.stderr));
    const permissions = flatpakPermissions(info.stdout);
    return { source, name, plan: { install: [{ name, version: '' }], upgrade: [], remove: [] }, disk_bytes: null, permissions, broad: permissions.filter((p) => BROAD.some((b) => b.test(p))) };
  }

  install(caller: number, source: Source, catalogId: string): number {
    const name = this.authorizeItem(source, catalogId, 'install');
    return this.enqueue('install', caller, async (job) => {
      if (source === 'apt') {
        await this.preview('apt', catalogId, 'install');   // re-check plan and sources inside the lock
        job.phase = 'installing'; this.progress(job, 30);
        await this.mustRun('apt-get', ['-y', '-q', ...APT_ENV_ARGS, 'install', '--', name]);
      } else {
        job.phase = 'installing'; this.progress(job, 30);
        await this.mustRun('flatpak', ['install', '--system', '--noninteractive', '-y', this.remoteFor(name), name]);
      }
      this.env.audit('installed', { caller, source, name });
    });
  }

  remove(caller: number, source: Source, catalogId: string): number {
    const name = this.authorizeItem(source, catalogId, 'remove');
    return this.enqueue('remove', caller, async (job) => {
      if (source === 'apt') {
        await this.preview('apt', catalogId, 'remove');
        job.phase = 'removing'; this.progress(job, 30);
        await this.mustRun('apt-get', ['-y', '-q', 'remove', '--', name]);
      } else {
        job.phase = 'removing'; this.progress(job, 30);
        await this.mustRun('flatpak', ['uninstall', '--system', '--noninteractive', '-y', name]);
        // WSOS-FLP-004: prune only runtimes nothing uses any more.
        await this.env.runner.run('flatpak', ['uninstall', '--system', '--unused', '--noninteractive', '-y']);
      }
      this.env.audit('removed', { caller, source, name });
    });
  }

  async checkUpdates(): Promise<{ apt: number; flatpak: number; packages: string[]; flatpaks: string[]; reboot_required: boolean; state: string }> {
    const list = await this.env.runner.run('apt', ['list', '--upgradable', '-q']);
    const fp = await this.env.runner.run('flatpak', ['remote-ls', '--system', '--updates', '--columns=application']);
    const apt = parseUpgradable(list.stdout);
    const flatpaks = fp.code === 0 ? fp.stdout.split('\n').map((l) => l.trim()).filter((l) => l && l !== 'Application ID') : [];
    return { apt: apt.length, flatpak: flatpaks.length, packages: apt.map((c) => c.name), flatpaks, reboot_required: this.rebootRequired, state: this.state() };
  }

  /** WSOS-UPD-001 coordinator steps that belong on the device. release_id "" = newest the device's ring allows. */
  applyUpdate(caller: number, releaseId: string, opts: { allow_battery?: boolean } = {}): number {
    if (releaseId && !/^[A-Za-z0-9._+~-]{1,64}$/.test(releaseId)) throw new ServiceError('InvalidArgs', 'release id');
    return this.enqueue('update', caller, async (job) => {
      const p = this.env.power();
      if (!p.ac && (p.battery ?? 0) < 40 && !opts.allow_battery) throw new ServiceError('PreconditionFailed', 'connect power or charge to 40%');
      this.checkSources();
      job.phase = 'refreshing'; this.progress(job, 5);
      await this.mustRun('apt-get', ['update', '-q']);             // InRelease signatures are verified by apt (WSOS-AUP-002)
      const sim = await this.env.runner.run('apt-get', ['-s', '-q', ...APT_ENV_ARGS, 'full-upgrade']);
      const plan = parseSimulation(sim.stdout);
      this.refuseCritical(plan);
      const dry = await this.env.runner.run('apt-get', ['--assume-no', '-q', 'full-upgrade']);
      const need = Math.max(0, parseDiskChange(dry.stdout + dry.stderr) ?? 0);
      if (this.env.freeBytes() < need + 500e6) throw new ServiceError('PreconditionFailed', 'not enough disk space');
      job.phase = 'downloading'; this.progress(job, 20);
      await this.download(['full-upgrade']);
      job.phase = 'applying'; this.progress(job, 50);
      await this.mustRun('apt-get', ['-y', '-q', ...APT_ENV_ARGS, 'full-upgrade']);
      job.phase = 'flatpak'; this.progress(job, 85);
      await this.env.runner.run('flatpak', ['update', '--system', '--noninteractive', '-y']);
      // Health check: nothing half-configured, and note whether a reboot is needed.
      job.phase = 'checking'; this.progress(job, 95);
      if (await this.detectInterrupted()) throw new ServiceError('Failed', 'packages left unconfigured; repair needed');
      const reboot = await this.env.runner.run('test', ['-e', '/run/reboot-required']);
      this.rebootRequired = reboot.code === 0;
      this.env.audit('updated', { caller, release_id: releaseId || 'latest', upgraded: plan.upgrade.length, installed: plan.install.length, reboot_required: this.rebootRequired });
    });
  }

  // ---- local .deb files (WSOS-APT-005) ----

  private spool(...p: string[]) { return join(this.env.spool ?? '/var/lib/worksuite-package-service/spool', ...p); }

  /** Stage the caller's file, read its control fields, and let apt validate dependencies; nothing is installed. */
  async previewLocalDeb(caller: number, path: string): Promise<LocalDebPreview> {
    const staged = stageFile(path, caller, this.spool('debs'), '.deb');
    return this.inspectLocalDeb(staged.path, staged.sha256);
  }

  private async inspectLocalDeb(path: string, token: string): Promise<LocalDebPreview> {
    // WSOS-SEC-005: parsed as nobody first; apt only sees a file that is a well-formed package.
    const f = await debFieldsUnprivileged(this.env.runner, path, ['Package', 'Version', 'Architecture', 'Maintainer', 'Description'], this.env.unprivileged);
    if (f.code !== 0) throw new ServiceError('InvalidArgs', 'not a valid Debian package');
    const field = (k: string) => new RegExp(`^${k}: (.*)$`, 'm').exec(f.stdout)?.[1]?.trim() ?? '';
    const pkg = field('Package');
    if (!/^[a-z0-9][a-z0-9+.-]{0,99}$/.test(pkg)) throw new ServiceError('InvalidArgs', 'package name is not valid');
    if (isCritical(pkg)) throw new ServiceError('Protected', `${pkg} is part of the system and can't be replaced from a file`);
    const policy = this.env.policy();
    if (policy && policy.allow_local_debs === false) throw new ServiceError('NotInCatalog', 'your organization does not allow installing package files');
    const allow = policy?.app_allowlist;
    if (allow && allow.length && !allow.includes(`apt:${pkg}`)) throw new ServiceError('NotInCatalog', 'not approved by your organization');
    const arch = field('Architecture');
    const native = (await this.env.runner.run('dpkg', ['--print-architecture'])).stdout.trim();
    if (arch !== 'all' && native && arch !== native) throw new ServiceError('ArchMismatch', `built for ${arch}; this device is ${native}`);
    this.checkSources();
    // apt resolves dependencies against the configured (signed) sources; a .deb whose dependencies can't be met fails here.
    const sim = await this.env.runner.run('apt-get', ['-s', '-q', 'install', '--', path]);
    if (sim.code !== 0) throw new ServiceError('Failed', firstLine(sim.stderr) || 'apt could not resolve this package');
    const plan = parseSimulation(sim.stdout);
    this.refuseCritical(plan);
    const dry = await this.env.runner.run('apt-get', ['--assume-no', '-q', 'install', '--', path]);
    return { package: pkg, version: field('Version'), architecture: arch, publisher: field('Maintainer') || 'Unknown', publisher_verified: false,
      description: field('Description'), plan, disk_bytes: parseDiskChange(dry.stdout + dry.stderr), token };
  }

  /** Install the exact staged copy the user confirmed (`token` = its SHA-256 from the preview). */
  installLocalDeb(caller: number, token: string): number {
    if (!/^[0-9a-f]{64}$/.test(token)) throw new ServiceError('InvalidArgs', 'confirm the package first');
    return this.enqueue('install', caller, async (job) => {
      const path = stagedCopy(this.spool('debs'), token, '.deb');
      if (!path) throw new ServiceError('PreconditionFailed', 'the previewed package is gone; preview it again');
      try {
        const p = await this.inspectLocalDeb(path, token);   // same checks again, inside the lock
        job.phase = 'installing'; this.progress(job, 30);
        await this.mustRun('apt-get', ['-y', '-q', ...APT_ENV_ARGS, 'install', '--', path]);
        this.env.audit('installed_local_deb', { caller, name: p.package, version: p.version, sha256: token, publisher: p.publisher });
      } finally { rmSync(path, { force: true }); }
    });
  }

  // ---- Flatpak permissions and runtimes (WSOS-FLP-003, WSOS-FLP-004) ----

  /** Read-only: what the app declares and which system-wide overrides an administrator added. */
  async appPermissions(catalogId: string): Promise<{ app: string; permissions: string[]; overrides: string[]; broad: string[] }> {
    const app = parseCatalogId('flatpak', catalogId);
    const info = await this.env.runner.run('flatpak', ['info', '--system', '--show-permissions', app]);
    if (info.code !== 0) throw new ServiceError('NotInCatalog', 'not installed');
    const ov = await this.env.runner.run('flatpak', ['override', '--system', '--show', app]);
    const permissions = contextLines(info.stdout);
    return { app, permissions, overrides: ov.code === 0 ? contextLines(ov.stdout) : [], broad: permissions.filter((p) => BROAD.some((b) => b.test(p))) };
  }

  /** Drop system-wide overrides so the app is back to what it declared. Per-user overrides, the portal permission
   *  store and ~/.var/app data belong to the user and are reset by the shell in the user's session. */
  resetAppPermissions(caller: number, catalogId: string): number {
    const app = parseCatalogId('flatpak', catalogId);
    return this.enqueue('permissions', caller, async (job) => {
      job.phase = 'resetting'; this.progress(job, 30);
      await this.mustRun('flatpak', ['override', '--system', '--reset', app]);
      this.env.audit('flatpak_permissions_reset', { caller, app });
    });
  }

  /** WSOS-FLP-004: flatpak's own --unused analysis removes only runtimes and extensions no installed app (system or
   *  per-user) needs, and keeps pinned ones. Runs in the queue so it never races an install. */
  pruneRuntimes(caller: number): number {
    return this.enqueue('prune', caller, async (job) => {
      job.phase = 'pruning'; this.progress(job, 30);
      const r = await this.mustRun('flatpak', ['uninstall', '--system', '--unused', '--noninteractive', '-y']);
      const removed = r.stdout.split('\n').map((l) => /^\s*\d+\.\s+(\S+)\s+(\S+)/.exec(l)).filter((m) => m !== null).map((m) => `${m[1]}//${m[2]}`);
      this.env.audit('flatpak_runtimes_pruned', { caller, removed });
    });
  }

  /** WSOS-FLP-001: add a Flatpak remote. The D-Bus layer requires an administrator (lk.worksuite.package.add-remote,
   *  auth_admin); here the remote must also be permitted by device policy: on a managed device its name must be in
   *  approved_remotes and its URL must equal the policy's flatpak_remotes entry. Unmanaged (personal) devices have no
   *  policy to grant the permission, so only the default remote is available there. */
  addRemote(caller: number, name: string, url: string): number {
    if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(name)) throw new ServiceError('InvalidArgs', 'remote name');
    let u: URL;
    try { u = new URL(url); } catch { throw new ServiceError('InvalidArgs', 'remote url'); }
    if (u.protocol !== 'https:' || !u.pathname.endsWith('.flatpakrepo') || u.username || u.password) throw new ServiceError('InvalidArgs', 'remote url must be an https .flatpakrepo file');
    const policy = this.env.policy();
    if (!policy?.approved_remotes?.includes(name) || policy.flatpak_remotes?.[name] !== url) {
      this.env.audit('flatpak_remote_refused', { caller, name, url });
      throw new ServiceError('NotAuthorized', 'device policy does not permit this remote');
    }
    return this.enqueue('remote', caller, async (job) => {
      job.phase = 'adding'; this.progress(job, 30);
      await this.mustRun('flatpak', ['remote-add', '--system', '--if-not-exists', '--from', name, url]);
      this.env.audit('flatpak_remote_added', { caller, name, url });
    });
  }

  // ---- offline .wsupdate bundles (WSOS-AUP-010) ----

  private bundleOptions() {
    const r = this.env.release;
    if (!r) throw new ServiceError('Failed', 'release keys are not available');
    return { keys: r.keys, arch: r.arch, installed: r.installed() };
  }

  /** Read-only check shown in Settings > Updates before installing. */
  inspectBundle(caller: number, path: string): { release_id: string; version: string; packages: number; bytes: number; critical: boolean; verified: true } {
    const staged = stageBundle(path, caller, this.spool('bundles'), this.env.bundleRoots);
    let manifest: BundleManifest;
    try { ({ manifest } = inspectBundle(staged.path, this.bundleOptions())); } finally { rmSync(staged.path, { force: true }); }
    return { release_id: manifest.release_id, version: manifest.version, packages: manifest.bundle.files.length,
      bytes: manifest.bundle.files.reduce((n, f) => n + f.size, 0), critical: !!manifest.critical, verified: true };
  }

  installBundle(caller: number, path: string): number {
    // Staged now, while the caller is known: the job works on the root-owned copy, never on the caller's file.
    // Renamed per job: an inspection of the same bundle meanwhile stages (and removes) its own copy.
    const staged = stageBundle(path, caller, this.spool('bundles'), this.env.bundleRoots);
    const real = join(this.spool('bundles'), `job-${randomUUID()}.wsupdate`);
    renameSync(staged.path, real);
    const installStaged = async (job: Job) => {
      const p = this.env.power();
      if (!p.ac && (p.battery ?? 0) < 40) throw new ServiceError('PreconditionFailed', 'connect power or charge to 40%');
      job.phase = 'verifying'; this.progress(job, 5);
      const dir = this.spool('bundle');
      let manifest: BundleManifest, debs: string[];
      try { ({ manifest, debs } = extractBundle(real, dir, this.bundleOptions())); }
      catch (e) { this.env.audit('bundle_rejected', { caller, error: (e as Error).message }); throw e; }
      try {
        // Offline: everything must come from the bundle (--no-download); apt still checks dependencies and conflicts.
        const sim = await this.env.runner.run('apt-get', ['-s', '-q', '--no-download', 'install', '--', ...debs]);
        if (sim.code !== 0) throw new ServiceError('Failed', firstLine(sim.stderr) || 'the bundle does not install cleanly on this device');
        this.refuseCritical(parseSimulation(sim.stdout));
        job.phase = 'applying'; this.progress(job, 40);
        await this.mustRun('apt-get', ['-y', '-q', '--no-download', ...APT_ENV_ARGS, 'install', '--', ...debs]);
        job.phase = 'checking'; this.progress(job, 90);
        if (await this.detectInterrupted()) throw new ServiceError('Failed', 'packages left unconfigured; repair needed');
        this.rebootRequired = (await this.env.runner.run('test', ['-e', '/run/reboot-required'])).code === 0;
        this.env.audit('bundle_installed', { caller, release_id: manifest.release_id, version: manifest.version, packages: debs.length, reboot_required: this.rebootRequired });
      } finally { rmSync(dir, { recursive: true, force: true }); }
    };
    try {
      return this.enqueue('update', caller, async (job) => {
        try { await installStaged(job); } finally { rmSync(real, { force: true }); }
      });
    } catch (e) { rmSync(real, { force: true }); throw e; }
  }

  /** WSOS-AUP-008: download first, retrying with backoff. apt keeps partial files in /var/cache/apt/archives/partial
   *  and resumes them with HTTP Range requests, so each attempt (and the next check cycle) continues where the last
   *  stopped. The cache is never cleaned here. */
  private async download(verb: string[]) {
    const attempts = 3;
    for (let i = 1; ; i++) {
      const r = await this.env.runner.run('apt-get', ['-y', '-q', '-o', 'Acquire::Retries=3', '--download-only', ...verb]);
      if (r.code === 0) return;
      if (/NO_PUBKEY|not signed|EXPKEYSIG|BADSIG|Hash Sum mismatch/.test(r.stderr)) throw new ServiceError('SignatureInvalid', firstLine(r.stderr));
      this.env.audit('download_interrupted', { attempt: i, error: firstLine(r.stderr) });
      if (i >= attempts) throw new ServiceError('Failed', `download interrupted; it resumes from where it stopped next time (${firstLine(r.stderr) || `exit ${r.code}`})`);
      await (this.env.sleep ?? ((ms) => new Promise((res) => setTimeout(res, ms))))(i * 10_000);
    }
  }

  /** WSOS-APT-006: fixed commands only. */
  repair(caller: number): number {
    return this.enqueue('repair', caller, async (job) => {
      job.phase = 'configuring'; this.progress(job, 20);
      await this.mustRun('dpkg', ['--configure', '-a']);
      job.phase = 'fixing'; this.progress(job, 60);
      await this.mustRun('apt-get', ['-y', '-q', ...APT_ENV_ARGS, '-f', 'install']);
      await this.detectInterrupted();
      this.env.audit('repaired', { caller, ok: !this.needsRepair });
      if (this.needsRepair) throw new ServiceError('Failed', 'repair incomplete');
    });
  }

  /** Only the caller who started a job (or root) may cancel it, and only while it is still queued. */
  cancel(caller: number, id: number) {
    const job = this.jobs.get(id);
    if (!job) throw new ServiceError('NoSuchJob');
    if (caller !== 0 && caller !== job.caller) throw new ServiceError('NotAuthorized');
    if (job.state !== 'queued') throw new ServiceError('Busy', 'job already started');
    job.state = 'cancelled';
    this.emit('finished', job);
  }

  job(id: number) { return this.jobs.get(id); }

  private enqueue(kind: JobKind, caller: number, body: (job: Job) => Promise<void>): number {
    if (this.needsRepair && kind !== 'repair') throw new ServiceError('PreconditionFailed', 'repair packages first');
    const job: Job = { id: this.nextId++, kind, caller, state: 'queued', phase: 'queued' };
    this.jobs.set(job.id, job);
    this.queue = this.queue.then(async () => {
      if (job.state === 'cancelled') return;
      job.state = 'running';
      try {
        await body(job);
        job.state = 'success'; job.phase = 'done'; this.progress(job, 100);
      } catch (e) {
        job.state = 'failed'; job.error = e instanceof Error ? e.message : String(e);
        this.env.audit('job_failed', { job: job.id, kind, caller, error: job.error });
      }
      this.emit('finished', job);
    });
    return job.id;
  }

  private progress(job: Job, percent: number) { this.emit('progress', job, percent); }

  private async mustRun(cmd: string, args: string[]) {
    const r = await this.env.runner.run(cmd, args);
    if (r.code !== 0) {
      if (cmd === 'apt-get' && /NO_PUBKEY|not signed|InRelease.*(invalid|is not valid)|EXPKEYSIG|BADSIG/.test(r.stderr)) throw new ServiceError('SignatureInvalid', firstLine(r.stderr));
      if (/Could not get lock|dpkg was interrupted/.test(r.stderr)) throw new ServiceError('Busy', firstLine(r.stderr));
      throw new ServiceError('Failed', `${cmd}: ${firstLine(r.stderr) || `exit ${r.code}`}`);
    }
    return r;
  }

  /** Policy allowlist on managed devices (WSOS-APP-003); flatpak only from approved remotes (WSOS-FLP-001). */
  private authorizeItem(source: Source, catalogId: string, op: 'install' | 'remove'): string {
    if (source !== 'apt' && source !== 'flatpak') throw new ServiceError('InvalidArgs', 'source');
    const name = parseCatalogId(source, catalogId);
    if (op === 'remove' && source === 'apt' && isCritical(name)) throw new ServiceError('Protected', `${name} is part of the system`);
    const policy = this.env.policy();
    const allow = policy?.app_allowlist;
    if (op === 'install' && allow && allow.length && !allow.includes(`${source}:${name}`)) throw new ServiceError('NotInCatalog', 'not approved by your organization');
    return name;
  }

  private remoteFor(_app: string): string {
    const approved = this.env.policy()?.approved_remotes;
    const remote = approved?.length ? approved[0] : FLATPAK_DEFAULT_REMOTE;
    if (!/^[A-Za-z0-9._-]{1,64}$/.test(remote)) throw new ServiceError('InvalidArgs', 'remote');
    return remote;
  }

  private checkSources() {
    const extra = this.env.updateHosts?.() ?? [];
    const issues = this.env.sources().flatMap(([f, t]) => checkSources(t, f, extra));
    if (issues.length) { this.env.audit('sources_rejected', { issues }); throw new ServiceError('SourcesInvalid', issues[0]); }
  }

  /** WSOS-APT-003: a plan that would remove anything critical is refused, whatever asked for it. */
  private refuseCritical(plan: Plan) {
    const hit = plan.remove.find((c) => isCritical(c.name));
    if (hit) throw new ServiceError('Protected', `would remove ${hit.name}`);
  }
}

/** `flatpak info --show-permissions` / `override --show` print a keyfile; keep the [Context] style key=value lines. */
function contextLines(text: string): string[] {
  return text.split('\n').map((l) => l.trim()).filter((l) => /^[a-z-]+=/.test(l));
}

function firstLine(s: string) { return s.split('\n').find((l) => l.trim())?.trim() ?? ''; }

/** `flatpak remote-info --show-metadata` [Context] keys → "key=value" strings. */
export function flatpakPermissions(meta: string): string[] {
  const ctx = /\[Context\]\n([\s\S]*?)(\n\[|$)/.exec(meta)?.[1] ?? '';
  return ctx.split('\n').map((l) => l.trim()).filter((l) => /^[a-z-]+=/.test(l));
}

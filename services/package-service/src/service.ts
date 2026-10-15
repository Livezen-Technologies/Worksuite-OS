// Package service core: one serialized job queue in front of APT and Flatpak (WSOS-APT-004), policy and
// critical-set checks, previews before any change (WSOS-APP-002), update preconditions (WSOS-UPD-001), repair.
import { EventEmitter } from 'node:events';
import { checkSources, isCritical, parseCatalogId, parseDiskChange, parseSimulation, parseUpgradable, ServiceError, type Plan } from './apt.ts';

export type Source = 'apt' | 'flatpak';
export interface RunResult { code: number; stdout: string; stderr: string }
export interface Runner { run(cmd: string, args: string[]): Promise<RunResult> }

export interface DevicePolicy { app_allowlist?: string[]; approved_remotes?: string[] }

export interface Env {
  runner: Runner;
  /** Effective device policy from the device agent; null on an unmanaged device. */
  policy(): DevicePolicy | null;
  /** APT source files to validate before every operation: [path, contents]. */
  sources(): [string, string][];
  /** AC power, battery percent (null if no battery) and free bytes on / for WSOS-UPD-001. */
  power(): { ac: boolean; battery: number | null };
  freeBytes(): number;
  audit(event: string, fields: Record<string, unknown>): void;
}

export interface Preview { source: Source; name: string; plan: Plan; disk_bytes: number | null; permissions: string[]; broad: string[] }
export type JobKind = 'install' | 'remove' | 'update' | 'repair';
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

  async checkUpdates(): Promise<{ apt: number; flatpak: number; packages: string[]; reboot_required: boolean; state: string }> {
    const list = await this.env.runner.run('apt', ['list', '--upgradable', '-q']);
    const fp = await this.env.runner.run('flatpak', ['remote-ls', '--system', '--updates', '--columns=application']);
    const apt = parseUpgradable(list.stdout);
    const flatpaks = fp.code === 0 ? fp.stdout.split('\n').map((l) => l.trim()).filter((l) => l && l !== 'Application ID') : [];
    return { apt: apt.length, flatpak: flatpaks.length, packages: apt.map((c) => c.name), reboot_required: this.rebootRequired, state: this.state() };
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
      await this.mustRun('apt-get', ['-y', '-q', '--download-only', 'full-upgrade']);
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
    const issues = this.env.sources().flatMap(([f, t]) => checkSources(t, f));
    if (issues.length) { this.env.audit('sources_rejected', { issues }); throw new ServiceError('SourcesInvalid', issues[0]); }
  }

  /** WSOS-APT-003: a plan that would remove anything critical is refused, whatever asked for it. */
  private refuseCritical(plan: Plan) {
    const hit = plan.remove.find((c) => isCritical(c.name));
    if (hit) throw new ServiceError('Protected', `would remove ${hit.name}`);
  }
}

function firstLine(s: string) { return s.split('\n').find((l) => l.trim())?.trim() ?? ''; }

/** `flatpak remote-info --show-metadata` [Context] keys → "key=value" strings. */
export function flatpakPermissions(meta: string): string[] {
  const ctx = /\[Context\]\n([\s\S]*?)(\n\[|$)/.exec(meta)?.[1] ?? '';
  return ctx.split('\n').map((l) => l.trim()).filter((l) => /^[a-z-]+=/.test(l));
}

// Update coordinator (SRS §9.1, §14.1): checks download.worksuitecloud.com 15 min after boot and every 6 h for the
// device's ring and arch, verifies the signed manifest, decides with updates.ts, and runs installs through the
// package service's job queue. Results go to desktop/v1/os/update-results.
import { EventEmitter } from 'node:events';
import type { KeyObject } from 'node:crypto';
import { canDefer, decide, verifyManifest, type Decision, type Manifest, type Mode, type Ring } from './updates.ts';
import type { Job, PackageService } from './service.ts';

export const DEFAULT_HOST = 'https://download.worksuitecloud.com';
export const FIRST_CHECK_MS = 15 * 60_000;
export const CHECK_EVERY_MS = 6 * 60 * 60_000;
export const WARNING_MS = 15 * 60_000;

export type UpdateState = 'up_to_date' | 'checking' | 'available' | 'waiting' | 'installing' | 'ready_to_restart' | 'restart_pending' | 'failed';

export interface UpdateStatus {
  state: UpdateState;
  version: string | null;            // offered version
  installed: string;
  release_id: string | null;
  mandatory: boolean;
  deadline: string | null;
  deferrals_left: number | null;
  reason: string | null;             // waiting reason, refusal or error
  restart_at: number | null;
  last_check: number | null;
}

export interface CoordinatorEnv {
  fetchJson(url: string): Promise<unknown>;
  keys(id: string): KeyObject | undefined;
  policy(): { update_ring?: Ring; update_mode?: Mode; maintenance_window?: string; update_mirror?: string } | null;
  arch: 'amd64' | 'arm64';
  installedVersion(): string;
  deviceKey(): string;
  idle(): Promise<boolean>;
  metered(): Promise<boolean>;
  /** Point the WorkSuite APT source at the ring's suite (trixie-dev | trixie-pilot | trixie-stable). */
  setSuite(suite: string): void;
  load(): { deferrals: Record<string, number> };
  save(s: { deferrals: Record<string, number> }): void;
  report(result: Record<string, unknown>): Promise<void>;
  reboot(): Promise<void>;
  now(): number;
  audit(event: string, fields: Record<string, unknown>): void;
}

const SUITE: Record<Ring, string> = { development: 'trixie-dev', pilot: 'trixie-pilot', stable: 'trixie-stable' };

export function manifestUrl(host: string, ring: Ring, arch: string) {
  const u = new URL(host);
  if (u.protocol !== 'https:') throw new Error('update host must use https');
  return new URL(`/os/manifests/${ring}/${arch}.json`, u).toString();
}

export class Coordinator extends EventEmitter {
  status: UpdateStatus;
  private manifest: Manifest | null = null;
  private timers: NodeJS.Timeout[] = [];
  private env: CoordinatorEnv;
  private svc: PackageService;

  constructor(env: CoordinatorEnv, svc: PackageService) {
    super();
    this.env = env; this.svc = svc;
    this.status = { state: 'up_to_date', version: null, installed: env.installedVersion(), release_id: null, mandatory: false, deadline: null, deferrals_left: null, reason: null, restart_at: null, last_check: null };
  }

  /** WSOS-AUP-001: first check 15 min after start, then every 6 h. */
  start() {
    const loop = () => { void this.check().catch(() => {}); this.timers.push(setTimeout(loop, CHECK_EVERY_MS)); };
    this.timers.push(setTimeout(loop, FIRST_CHECK_MS));
  }
  stop() { for (const t of this.timers) clearTimeout(t); }

  private set(patch: Partial<UpdateStatus>) {
    this.status = { ...this.status, ...patch };
    this.emit('status', this.status);
  }

  private ring(): Ring { return this.env.policy()?.update_ring ?? 'stable'; }
  private deferrals(id: string) { return this.env.load().deferrals[id] ?? 0; }

  async check(): Promise<Decision | null> {
    if (this.status.state === 'installing' || this.status.state === 'restart_pending') return null;
    const policy = this.env.policy();
    const ring = this.ring();
    this.set({ state: 'checking', installed: this.env.installedVersion() });
    this.env.setSuite(SUITE[ring]);
    let raw: unknown;
    try {
      // WSOS-AUP-009: an enterprise mirror from policy; WorkSuite signatures are still required.
      raw = await this.env.fetchJson(manifestUrl(policy?.update_mirror || DEFAULT_HOST, ring, this.env.arch));
    } catch (e) {
      this.set({ state: 'failed', reason: `can't reach the update server`, last_check: this.env.now() });
      return null;
    }
    if (!verifyManifest(raw, this.env.keys) || raw.ring !== ring || raw.arch !== this.env.arch) {
      this.env.audit('manifest_rejected', { ring, arch: this.env.arch });
      await this.reportSafe({ release_id: (raw as { release_id?: string })?.release_id ?? 'unknown', result: 'refused_signature' });
      this.set({ state: 'failed', reason: 'update information failed its signature check', last_check: this.env.now() });
      return null;
    }
    this.manifest = raw;
    const used = this.deferrals(raw.release_id);
    const d = decide({
      manifest: raw, installed: this.env.installedVersion(), managed: !!policy, mode: policy?.update_mode ?? 'automatic',
      window: policy?.maintenance_window, deviceKey: this.env.deviceKey(), now: new Date(this.env.now()),
      idle: await this.env.idle(), metered: await this.env.metered(), deferrals: used,
    });
    const offer = { version: raw.version, release_id: raw.release_id, mandatory: !!(raw.mandatory || raw.critical), deadline: raw.deadline ?? null,
      deferrals_left: raw.mandatory || raw.critical ? Math.max(0, 3 - used) : null, last_check: this.env.now() };
    switch (d.action) {
      case 'none': this.set({ ...offer, state: d.reason === 'up_to_date' ? 'up_to_date' : 'available', reason: d.reason === 'up_to_date' ? null : d.reason }); break;
      case 'refuse':
        await this.reportSafe({ release_id: raw.release_id, result: 'refused_downgrade' });
        this.set({ ...offer, state: 'failed', reason: 'refused a downgrade without a signed rollback directive' }); break;
      case 'wait': this.set({ ...offer, state: 'waiting', reason: d.reason }); break;
      case 'install': this.set({ ...offer, reason: d.reason }); await this.install(); break;
      case 'warn_restart': this.warnThenInstall(offer); break;
    }
    return d;
  }

  /** User "Install now" (polkit lk.worksuite.update.apply in the D-Bus layer). */
  async installNow() {
    if (!this.manifest) await this.check();
    if (this.manifest && this.status.state !== 'installing') await this.install();
  }

  /** User "Later": allowed for optional releases, and up to 3 times before a mandatory release's deadline. */
  defer(): boolean {
    const m = this.manifest;
    if (!m) return false;
    const used = this.deferrals(m.release_id);
    if (!canDefer(m, this.env.installedVersion(), used, new Date(this.env.now()))) return false;
    const s = this.env.load();
    s.deferrals[m.release_id] = used + 1;
    this.env.save(s);
    this.set({ state: 'waiting', reason: 'deferred', deferrals_left: m.mandatory || m.critical ? Math.max(0, 2 - used) : null });
    this.env.audit('update_deferred', { release_id: m.release_id, deferrals: used + 1 });
    return true;
  }

  private warnThenInstall(offer: Partial<UpdateStatus>) {
    const at = this.env.now() + WARNING_MS;
    this.set({ ...offer, state: 'restart_pending', restart_at: at, reason: 'deadline' });
    this.timers.push(setTimeout(() => { void this.install(true); }, WARNING_MS));
  }

  private install(rebootAfter = false): Promise<void> {
    const m = this.manifest!;
    this.set({ state: 'installing', reason: null });
    return new Promise((resolve) => {
      let id: number;
      try { id = this.svc.applyUpdate(0, m.release_id, { allow_battery: !!m.critical }); }
      catch (e) { void this.finish(m, { state: 'failed', error: (e as Error).message } as Job, rebootAfter).then(resolve); return; }
      const onDone = (job: Job) => {
        if (job.id !== id) return;
        this.svc.off('finished', onDone);
        void this.finish(m, job, rebootAfter).then(resolve);
      };
      this.svc.on('finished', onDone);
    });
  }

  private async finish(m: Manifest, job: Job, rebootAfter: boolean) {
    const ok = job.state === 'success';
    await this.reportSafe({
      release_id: m.release_id, result: ok ? 'success' : 'failed', reboot_required: this.svc.rebootRequired,
      health_check: ok ? 'pass' : 'fail', ...(ok ? {} : { error: job.error ?? 'failed' }),
    });
    if (!ok) { this.set({ state: 'failed', reason: job.error ?? 'update failed', restart_at: null }); return; }
    const s = this.env.load(); delete s.deferrals[m.release_id]; this.env.save(s);
    this.set({ state: this.svc.rebootRequired ? 'ready_to_restart' : 'up_to_date', installed: this.env.installedVersion(), reason: null, restart_at: null });
    if (rebootAfter && this.svc.rebootRequired) await this.env.reboot();
  }

  private async reportSafe(r: Record<string, unknown>) {
    try { await this.env.report({ ring: this.ring(), arch: this.env.arch, ...r }); } catch { /* reported again with the next result */ }
  }
}

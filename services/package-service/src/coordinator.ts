// Update coordinator (SRS §9.1, §14.1): checks download.worksuitecloud.com 15 min after boot and every 6 h for the
// device's ring and arch, verifies the signed manifest, decides with updates.ts, and runs installs through the
// package service's job queue. Results go to desktop/v1/os/update-results.
import { EventEmitter } from 'node:events';
import type { KeyObject } from 'node:crypto';
import { canDefer, decide, verifyLicence, verifyManifest, type Decision, type Licence, type Manifest, type Mode, type Ring } from './updates.ts';
import type { Job, PackageService } from './service.ts';

/** The WorkSuite Update Center (Livezen-Technologies/worksite-download), which serves manifests and the APT repo. */
export const DEFAULT_HOST = 'https://download.worksuitecloud.com';
/** Device-local defaults (root-owned); an enrolled organisation's policy overrides every field. */
export const LOCAL_CONFIG = '/etc/worksuite/updates.json';

/** /etc/worksuite/updates.json: host for unmanaged devices and images built for a private Update Center. */
export interface LocalUpdateConfig { update_host?: string; update_ring?: Ring; update_mode?: Mode }
export const FIRST_CHECK_MS = 15 * 60_000;
export const CHECK_EVERY_MS = 6 * 60 * 60_000;
export const WARNING_MS = 15 * 60_000;
/** On (re)connecting to the internet: check again only if the last check is older than this, unless one failed. */
export const RECHECK_ON_CONNECT_MS = 60 * 60_000;

export type UpdateState = 'up_to_date' | 'checking' | 'available' | 'waiting' | 'installing' | 'ready_to_restart' | 'restart_pending' | 'failed';

export interface UpdateStatus {
  state: UpdateState;
  version: string | null;            // offered version
  installed: string;
  release_id: string | null;
  mandatory: boolean;
  critical: boolean;                 // emergency security release: installs on battery and metered links
  deadline: string | null;
  deferrals_left: number | null;
  reason: string | null;             // waiting reason, refusal or error
  restart_at: number | null;
  last_check: number | null;
  resumed: boolean;
  /** Where manifests come from (Update Center or the organisation's mirror). */
  update_host?: string;
  ring?: Ring;                  // this install picks up a download that was interrupted (apt resumes partials)
  /** From the signed manifest, for the Update Manager: release notes, link, sizes, and whether it is a version upgrade. */
  notes?: string | null;
  notes_url?: string | null;
  download_bytes?: number | null;
  installed_bytes?: number | null;
  upgrade?: boolean;
  security?: boolean;
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
  /** Point the WorkSuite APT source at the ring's suite (trixie-dev | trixie-pilot | trixie-stable) on `repo`. */
  setSuite(suite: string, repo?: string): void;
  /** LOCAL_CONFIG, or null when absent/invalid. */
  config?(): LocalUpdateConfig | null;
  load(): { deferrals: Record<string, number> };
  save(s: { deferrals: Record<string, number> }): void;
  report(result: Record<string, unknown>): Promise<void>;
  reboot(): Promise<void>;
  now(): number;
  /** WSOS-AUP-012: raw signed licence from desktop/v1/os/licence and the enrolled device id; absent/null when unmanaged. */
  licence?(): Promise<unknown>;
  deviceId?(): string | null;
  audit(event: string, fields: Record<string, unknown>): void;
  /** WSOS-UPD-001: extra post-update checks (failed critical systemd units etc.); returns the names of failed checks. */
  healthCheck?(): Promise<string[]>;
}

const SUITE: Record<Ring, string> = { development: 'trixie-dev', pilot: 'trixie-pilot', stable: 'trixie-stable' };

const RINGS: Ring[] = ['development', 'pilot', 'stable'];
const MODES: Mode[] = ['automatic', 'notify', 'manual'];

/** Normalise an https origin (path ignored); anything else falls back. */
export function updateHost(...candidates: (string | undefined | null)[]): string {
  for (const c of candidates) {
    if (!c) continue;
    try { const u = new URL(c); if (u.protocol === 'https:' && !u.username && !u.password) return u.origin; } catch { /* next */ }
  }
  return DEFAULT_HOST;
}

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
  private interrupted: string | null = null;   // release id whose download was cut off

  constructor(env: CoordinatorEnv, svc: PackageService) {
    super();
    this.env = env; this.svc = svc;
    this.status = { state: 'up_to_date', version: null, installed: env.installedVersion(), release_id: null, mandatory: false, deadline: null, deferrals_left: null, reason: null, restart_at: null, last_check: null, critical: false, resumed: false };
  }

  /** WSOS-AUP-001: first check 15 min after start, then every 6 h. */
  start() {
    const loop = () => { void this.check().catch(() => {}); this.timers.push(setTimeout(loop, CHECK_EVERY_MS)); };
    this.timers.push(setTimeout(loop, FIRST_CHECK_MS));
  }
  stop() { for (const t of this.timers) clearTimeout(t); }

  /**
   * NetworkManager reached full connectivity (Wi-Fi or Ethernet came up; the dispatcher calls this as root). Checks
   * right away when the last check is stale or failed for lack of network, and resumes an interrupted download;
   * otherwise does nothing, so flapping connections don't cause repeated checks. Returns whether it checked.
   */
  async connectivityChanged(): Promise<boolean> {
    const st = this.status;
    if (st.state === 'checking' || st.state === 'installing' || st.state === 'restart_pending') return false;
    const offline = st.state === 'failed' && st.reason === `can't reach the update server`;
    const interrupted = st.state === 'waiting' && (st.reason === 'download_interrupted' || st.reason === 'metered');
    const stale = !st.last_check || this.env.now() - st.last_check >= RECHECK_ON_CONNECT_MS;
    if (!offline && !interrupted && !stale) return false;
    this.env.audit('update_check_on_connect', { reason: offline ? 'was_offline' : interrupted ? st.reason : 'stale' });
    await this.check();
    return true;
  }

  private set(patch: Partial<UpdateStatus>) {
    this.status = { ...this.status, ...patch };
    this.emit('status', this.status);
  }

  private local(): LocalUpdateConfig { try { return this.env.config?.() ?? {}; } catch { return {}; } }
  /** Policy (enrolled organisation) wins over /etc/worksuite/updates.json, which wins over the defaults. */
  private ring(): Ring {
    const r = this.env.policy()?.update_ring ?? this.local().update_ring;
    return r && RINGS.includes(r) ? r : 'stable';
  }
  private mode(): Mode {
    const m = this.env.policy()?.update_mode ?? this.local().update_mode;
    return m && MODES.includes(m) ? m : 'automatic';
  }
  host(): string { return updateHost(this.env.policy()?.update_mirror, this.local().update_host); }
  private deferrals(id: string) { return this.env.load().deferrals[id] ?? 0; }

  async check(): Promise<Decision | null> {
    if (this.status.state === 'installing' || this.status.state === 'restart_pending') return null;
    const policy = this.env.policy();
    const ring = this.ring();
    const host = this.host();
    this.set({ state: 'checking', installed: this.env.installedVersion(), update_host: host, ring });
    this.env.setSuite(SUITE[ring], `${host}/os/apt`);
    let raw: unknown;
    try {
      // WSOS-AUP-009: an enterprise mirror from policy; WorkSuite signatures are still required.
      raw = await this.env.fetchJson(manifestUrl(host, ring, this.env.arch));
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
    const licence = await this.licence();
    const d = decide({ licence,
      manifest: raw, installed: this.env.installedVersion(), managed: !!policy, mode: this.mode(),
      window: policy?.maintenance_window, deviceKey: this.env.deviceKey(), now: new Date(this.env.now()),
      idle: await this.env.idle(), metered: await this.env.metered(), deferrals: used,
    });
    const offer = { notes: typeof raw.notes === 'string' ? raw.notes.slice(0, 8000) : null,
      notes_url: typeof raw.notes_url === 'string' && /^https:\/\//.test(raw.notes_url) ? raw.notes_url : null,
      download_bytes: Number.isFinite(raw.download_bytes) ? raw.download_bytes! : null, installed_bytes: Number.isFinite(raw.installed_bytes) ? raw.installed_bytes! : null,
      upgrade: raw.upgrade === true, security: raw.security === true,
      version: raw.version, release_id: raw.release_id, mandatory: !!(raw.mandatory || raw.critical), critical: !!raw.critical, deadline: raw.deadline ?? null,
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

  /** A licence that fails verification is treated as no licence: feature releases wait, nothing is removed. */
  private async licence(): Promise<Licence | null> {
    const id = this.env.deviceId?.();
    if (!this.env.licence || !id) return null;
    let raw: unknown;
    try { raw = await this.env.licence(); } catch { return null; }
    if (raw == null) return null;
    if (verifyLicence(raw, this.env.keys, id, new Date(this.env.now()))) return raw;
    this.env.audit('licence_rejected', {});
    return null;
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
    this.set({ state: 'installing', reason: null, resumed: this.interrupted === m.release_id });
    return new Promise((resolve) => {
      let id: number;
      try { id = this.svc.applyUpdate(0, m.release_id, { allow_battery: !!m.critical, version: m.version }); }
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
    let ok = job.state === 'success';
    // WSOS-AUP-008: an interrupted download is not a failed update. apt keeps the partial files and resumes them
    // (HTTP Range) on the next attempt, which the next check cycle or "Install now" starts.
    if (!ok && /^download interrupted/.test(job.error ?? '')) {
      this.interrupted = m.release_id;
      this.set({ state: 'waiting', reason: 'download_interrupted', restart_at: null, resumed: false });
      return;
    }
    // WSOS-UPD-001: health check after a successful apply. A failure keeps the device off the reboot path, runs
    // `dpkg --configure -a` if packages were left unconfigured, and is reported so the server can issue a signed
    // rollback directive (WSOS-AUP-003).
    this.interrupted = null;
    const failures = ok ? await this.health(m) : [];
    if (failures.length) {
      ok = false;
      job = { ...job, error: `health check failed: ${failures.join(', ')}` };
      this.env.audit('health_check_failed', { release_id: m.release_id, failures });
      if (failures.includes('dpkg_unconfigured')) { try { this.svc.repair(0); } catch { /* reported below */ } }
    }
    await this.reportSafe({
      release_id: m.release_id, result: ok ? 'success' : 'failed', reboot_required: this.svc.rebootRequired,
      health_check: ok ? 'pass' : 'fail', ...(failures.length ? { health_failures: failures } : {}), ...(ok ? {} : { error: job.error ?? 'failed' }),
    });
    if (!ok) { this.set({ state: 'failed', reason: job.error ?? 'update failed', restart_at: null, resumed: false }); return; }
    const s = this.env.load(); delete s.deferrals[m.release_id]; this.env.save(s);
    this.set({ state: this.svc.rebootRequired ? 'ready_to_restart' : 'up_to_date', installed: this.env.installedVersion(), reason: null, restart_at: null, resumed: false });
    if (rebootAfter && this.svc.rebootRequired) await this.env.reboot();
  }

  private async health(m: Manifest): Promise<string[]> {
    const failures: string[] = [];
    try { if (await this.svc.detectInterrupted()) failures.push('dpkg_unconfigured'); } catch { failures.push('dpkg_audit_failed'); }
    if (this.env.installedVersion() !== m.version) failures.push('version_mismatch');
    if (this.env.healthCheck) { try { failures.push(...await this.env.healthCheck()); } catch { failures.push('health_check_error'); } }
    return failures;
  }

  private async reportSafe(r: Record<string, unknown>) {
    try { await this.env.report({ ring: this.ring(), arch: this.env.arch, ...r }); } catch { /* reported again with the next result */ }
  }
}

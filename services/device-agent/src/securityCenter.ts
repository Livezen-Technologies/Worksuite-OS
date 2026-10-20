// WorkSuite Security on the device (issue #20): applies the firewall policy and isolation, keeps ClamAV's signature
// updates and engine healthy, runs scans (scheduled when the device is idle, or on a signed remote command),
// quarantines detections and publishes the status Settings and the admin console show. Effects go through
// SecurityHost (src/securityHost.ts) so this logic is testable without root.
import { randomUUID } from 'node:crypto';
import type { Policy, StateFile } from './state.ts';
import {
  emptySecurity, freshclamEnv, isolationActive, isolationPlan, pruneSecurity, renderPolicyFirewall, scanDue, securitySettings,
  securityStatus, type Detection, type EngineFacts, type SecuritySettings, type SecurityState, type SecurityStatus,
} from './security.ts';

export interface SecurityHost {
  /** Writes the policy table file and loads it; null deletes the table and the file. */
  applyFirewall(rules: string | null): Promise<void>;
  /** Returns true when the file changed (freshclam is then restarted). */
  writeFreshclamEnv(content: string | null): boolean;
  facts(): Promise<EngineFacts>;
  restartUnit(unit: string): Promise<void>;
  /** Addresses of the management server (isolation keeps HTTPS to them open). */
  resolve(host: string): Promise<string[]>;
  /** Runs clamscan at low priority under the CPU quota over the given files (or roots for a full scan). */
  scan(kind: 'quick' | 'full', s: SecuritySettings, since: number | null): Promise<{ files: number; detections: Detection[] }>;
  /** Moves the file into the root-only quarantine; returns its quarantine id. */
  quarantine(path: string, signature: string): Promise<string>;
  load(): Promise<{ idle: boolean; loadPerCore: number; onBattery: boolean; hour: number }>;
  /** New firewall drops since the cursor (kernel log). */
  firewallAlerts(cursor: string | undefined): Promise<{ alerts: { at: number; dst: string; dport: number | null; proto: string }[]; cursor?: string }>;
  publish(status: SecurityStatus): void;
  audit(event: string, fields?: Record<string, unknown>): void;
}

export class SecurityCenter {
  private running: Promise<unknown> | null = null;
  private o: { state: StateFile; host: SecurityHost; now?: () => number; managed: () => { enrolled: boolean; policy: Policy | null; server: string | null } };
  constructor(o: SecurityCenter['o']) { this.o = o; }
  private now() { return (this.o.now ?? Date.now)(); }
  get st(): SecurityState { return (this.o.state.state.security as SecurityState | undefined) ?? emptySecurity(); }
  private save(fn: (s: SecurityState) => void) { this.o.state.update((a) => { const s = (a.security as SecurityState | undefined) ?? emptySecurity(); fn(s); a.security = s; }); }
  settings(): SecuritySettings { const m = this.o.managed(); return securitySettings(m.enrolled ? m.policy : null); }

  /** Policy → firewall table and freshclam schedule. Expired isolation is lifted here (lockout safeguard). */
  async enforce(): Promise<void> {
    const s = this.settings(), now = this.now();
    if (this.st.isolation && !isolationActive(this.st.isolation, now)) {
      this.save((x) => { delete x.isolation; });
      this.o.host.audit('isolation_expired', {});
    }
    if (!this.o.managed().enrolled && this.st.isolation) this.save((x) => { delete x.isolation; });
    const iso = isolationActive(this.st.isolation, now) ? this.st.isolation! : null;
    try {
      await this.o.host.applyFirewall(renderPolicyFirewall(s, iso));
      if (this.o.host.writeFreshclamEnv(this.o.managed().enrolled ? freshclamEnv(s) : null)) await this.o.host.restartUnit('clamav-freshclam.service').catch(() => {});
    } catch (e) {
      this.o.host.audit('security_enforce_failed', { error: e instanceof Error ? e.message : String(e) });
    }
    await this.publish();
  }

  /** Engine health (#20 §11): a failed signature updater is restarted, at most once an hour. */
  async health(): Promise<EngineFacts> {
    const f = await this.o.host.facts();
    const s = this.settings();
    if (s.antivirus && f.clamav && f.freshclam === 'failed') {
      const last = this.st.restarts['clamav-freshclam'] ?? 0;
      if (this.now() - last > 3_600_000) {
        this.save((x) => { x.restarts['clamav-freshclam'] = this.now(); });
        await this.o.host.restartUnit('clamav-freshclam.service').then(() => this.o.host.audit('security_service_restarted', { unit: 'clamav-freshclam' }), () => {});
        return this.o.host.facts();
      }
    }
    return f;
  }

  async status(): Promise<SecurityStatus> {
    const s = this.settings();
    const f = await this.o.host.facts();
    return securityStatus(s, this.st, f, this.now(), this.o.managed().enrolled, this.running !== null);
  }

  async publish(): Promise<SecurityStatus> {
    const st = await this.status();
    this.o.host.publish(st);
    return st;
  }

  /** Periodic: retention, firewall alerts, health, and a scheduled scan when one is due and the device is idle. */
  async tick(): Promise<void> {
    const s = this.settings(), now = this.now();
    this.save((x) => Object.assign(x, pruneSecurity(x, s.security_log_retention_days, now)));
    if (this.st.isolation && !isolationActive(this.st.isolation, now)) await this.enforce();
    if (s.firewall_log_blocked) {
      const r = await this.o.host.firewallAlerts(this.st.firewall_log_cursor).catch(() => null);
      if (r?.alerts.length) this.o.host.audit('firewall_blocked', { count: r.alerts.length });
      if (r) this.save((x) => { x.firewall_alerts.push(...r.alerts.map((a) => ({ ...a, at: a.at || now }))); x.firewall_log_cursor = r.cursor; });
    }
    await this.health().catch(() => {});
    const kind = scanDue(s, this.st, now, await this.o.host.load());
    if (kind) await this.scan(kind, 'schedule');
    await this.publish();
  }

  /** One scan at a time; a second request while one runs joins it (no duplicate scans). */
  scan(kind: 'quick' | 'full', trigger: 'schedule' | 'remote' | 'user'): Promise<unknown> {
    if (this.running) return this.running;
    this.running = this.runScan(kind, trigger).finally(() => { this.running = null; void this.publish().catch(() => {}); });
    void this.publish().catch(() => {});
    return this.running;
  }

  private async runScan(kind: 'quick' | 'full', trigger: 'schedule' | 'remote' | 'user') {
    const s = this.settings();
    if (!s.antivirus) throw new Error('ANTIVIRUS_DISABLED');
    const id = randomUUID(), started = this.now();
    // Quick scans only look at files changed since the last scan (incremental); the first scan is always full.
    const since = kind === 'quick' && this.st.last_scan ? this.st.last_scan : null;
    const eff = since === null ? 'full' : kind;
    this.o.host.audit('scan_started', { id, kind: eff, trigger });
    try {
      const r = await this.o.host.scan(eff, s, since);
      for (const d of r.detections) {
        let quarantine_id: string | undefined;
        try { quarantine_id = await this.o.host.quarantine(d.path, d.signature); } catch { /* left in place, shown as needing action */ }
        this.save((x) => { x.threats.push({ id: randomUUID(), at: this.now(), path: d.path, signature: d.signature, action: quarantine_id ? 'quarantined' : 'detected', quarantine_id, scan_id: id }); });
        this.o.host.audit(quarantine_id ? 'threat_quarantined' : 'threat_detected', { scan_id: id, signature: d.signature, path: d.path });
      }
      this.save((x) => {
        x.scans.push({ id, kind: eff, trigger, started, finished: this.now(), files: r.files, detections: r.detections.length });
        x.last_scan = started; if (eff === 'full') x.last_full_scan = started;
      });
      this.o.host.audit('scan_completed', { id, files: r.files, detections: r.detections.length });
    } catch (e) {
      const error = e instanceof Error ? e.message : String(e);
      this.save((x) => { x.scans.push({ id, kind: eff, trigger, started, finished: this.now(), files: 0, detections: 0, error }); });
      this.o.host.audit('scan_failed', { id, error });
      throw e;
    } finally {
      await this.publish().catch(() => {});
    }
  }

  /** Remote incident response: isolate (management path kept, time-limited) and release. */
  async isolate(hours: unknown): Promise<void> {
    const server = this.o.managed().enrolled ? this.o.managed().server : null;
    if (!server) throw new Error('NOT_MANAGED');
    const ips = await this.o.host.resolve(new URL(server).hostname).catch(() => []);
    const plan = isolationPlan(this.now(), hours, ips);
    this.save((x) => { x.isolation = plan; });
    this.o.host.audit('isolation_started', { until: new Date(plan.until).toISOString(), management: plan.management });
    await this.enforce();
  }

  async release(): Promise<void> {
    this.save((x) => { delete x.isolation; });
    this.o.host.audit('isolation_released', {});
    await this.enforce();
  }

  /** Heartbeat summary for the admin console (no file paths beyond detections, no contents). */
  async summary() {
    const st = await this.status();
    return { overall: st.overall, issues: st.issues, firewall: st.firewall, isolation: st.isolation, antivirus: { ...st.antivirus, last_scan: st.antivirus.last_scan }, threats: st.threats, recent: st.history.slice(0, 10) };
  }
}

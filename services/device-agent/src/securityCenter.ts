// WorkSuite Security on the device (issue #20): applies the firewall policy and isolation, keeps ClamAV's signature
// updates and engine healthy, runs scans (scheduled when the device is idle, or on a signed remote command),
// quarantines detections and publishes the status Settings and the admin console show. Effects go through
// SecurityHost (src/securityHost.ts) so this logic is testable without root.
//
// Issue #38 adds the protection layers (src/protection.ts): real-time scanning, protected folders, ransomware burst
// detection and the executable deny list (worksuite-guard), Downloads scanning, DNS blocklists, firewall threat-intel
// feeds, and quarantine restore/delete.
import { randomUUID } from 'node:crypto';
import type { Policy, StateFile } from './state.ts';
import {
  emptySecurity, freshclamEnv, isolationActive, isolationPlan, pruneSecurity, renderPolicyFirewall, scanDue, securitySettings,
  securityStatus, type Detection, type EngineFacts, type SecuritySettings, type SecurityState, type SecurityStatus,
} from './security.ts';
import {
  DNS_BLOCKLIST, DNS_MODE_CONF, downloadDirs, GUARD_CONF, GUARD_UNIT, ONACCESS_CONF, ONACCESS_UNIT, parseDomainFeed, parseGuardLine, parseIpFeed,
  parseOnAccessLine, protectionSettings, renderDnsBlocklist, renderDnsMode, renderGuardConf, renderOnAccessConf, verifyFeed, type Feed,
  type ProtectionEvent, type ProtectionSettings,
} from './protection.ts';

const FEED_EVERY = 6 * 3_600_000;
const FEED_MAX_BYTES = 8 * 1024 * 1024;

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

  // ---- #38 protection layers ----
  /** Home directories of the people who use this device (uid ≥ 1000). */
  homes(): Promise<string[]>;
  /** Writes (0644) or removes a configuration file; true when it changed. */
  writeConfig(path: string, content: string | null): boolean;
  /** Starts (restart) or stops a unit. */
  unit(name: string, action: 'restart' | 'stop'): Promise<void>;
  /** Follows a unit's journal from now on, line by line; returns a stop function. */
  follow(unit: string, onLine: (line: string) => void): () => void;
  /** https GET, at most maxBytes; with sig, also "<url>.sig" (null when absent). */
  fetchFeed(url: string, maxBytes: number, sig: boolean): Promise<{ body: Buffer; signature: Buffer | null }>;
  /** Last good feed result, kept in the state directory; data = write, null = remove, undefined = read. */
  feedCache(name: 'firewall' | 'dns', data?: string | null): string | null;
  /** NetworkManager re-reads its configuration and restarts its dnsmasq. */
  reloadDns(): Promise<void>;
  /** Calls onFile for each new, complete file in the given folders; returns a stop function. */
  watchFiles(dirs: string[], onFile: (path: string) => void): () => void;
  /** Scans the given files now (clamd when it runs, else clamscan). */
  scanFiles(paths: string[], s: SecuritySettings): Promise<Detection[]>;
  /** Re-scans a quarantined file; clean (or force) → back at its original path with its owner and mode. */
  restoreQuarantined(id: string, force: boolean): Promise<{ path: string }>;
  deleteQuarantined(id: string): Promise<void>;
  /** Signals a process if it is still the one that was suspended (pid + start time). */
  signal(pid: number, start: string, sig: 'SIGCONT' | 'SIGKILL'): Promise<'ok' | 'gone'>;
}

export class SecurityCenter {
  private running: Promise<unknown> | null = null;
  private o: { state: StateFile; host: SecurityHost; now?: () => number; managed: () => { enrolled: boolean; policy: Policy | null; server: string | null } };
  constructor(o: SecurityCenter['o']) { this.o = o; }
  private now() { return (this.o.now ?? Date.now)(); }
  get st(): SecurityState { return (this.o.state.state.security as SecurityState | undefined) ?? emptySecurity(); }
  private save(fn: (s: SecurityState) => void) { this.o.state.update((a) => { const s = (a.security as SecurityState | undefined) ?? emptySecurity(); fn(s); a.security = s; }); }
  settings(): SecuritySettings { const m = this.o.managed(); return securitySettings(m.enrolled ? m.policy : null); }
  protection(): ProtectionSettings { const m = this.o.managed(); return protectionSettings(m.enrolled ? m.policy : null, this.settings().antivirus); }
  private guarded = false;
  private followers: Record<string, () => void> = {};
  private downloads: { key: string; stop: () => void } | null = null;

  private threatEntries(): { v4: string[]; v6: string[] } {
    try { const j = JSON.parse(this.o.host.feedCache('firewall') ?? 'null'); if (j && Array.isArray(j.v4) && Array.isArray(j.v6)) return j; } catch { /* none */ }
    return { v4: [], v6: [] };
  }

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
      await this.o.host.applyFirewall(renderPolicyFirewall(s, iso, this.protection().firewall_threat_feeds.length ? this.threatEntries() : undefined));
      if (this.o.host.writeFreshclamEnv(this.o.managed().enrolled ? freshclamEnv(s) : null)) await this.o.host.restartUnit('clamav-freshclam.service').catch(() => {});
    } catch (e) {
      this.o.host.audit('security_enforce_failed', { error: e instanceof Error ? e.message : String(e) });
    }
    await this.applyProtection().catch((e) => this.o.host.audit('protection_enforce_failed', { error: e instanceof Error ? e.message : String(e) }));
    await this.publish();
  }

  /** #38: clamonacc, worksuite-guard, DNS blocklist and Downloads watching, from the policy. */
  async applyProtection(): Promise<void> {
    const p = this.protection(), h = this.o.host;
    const homes = await h.homes();
    const onaccess = renderOnAccessConf(p, homes);
    if (h.writeConfig(ONACCESS_CONF, onaccess)) await h.unit(ONACCESS_UNIT, onaccess ? 'restart' : 'stop').catch(() => {});
    const guard = renderGuardConf(p, homes);
    this.guarded = guard !== null;
    if (h.writeConfig(GUARD_CONF, guard)) await h.unit(GUARD_UNIT, guard ? 'restart' : 'stop').catch(() => {});
    // Journals are followed only while their helper runs, so a protection the policy turns off goes quiet.
    this.followUnit(ONACCESS_UNIT, onaccess !== null, (l) => void this.onAccessLine(l));
    this.followUnit(GUARD_UNIT, guard !== null, (l) => this.onGuardLine(l));
    let feedDomains: string[] = [];
    if (p.dns_threat_feeds.length) try { feedDomains = JSON.parse(h.feedCache('dns') ?? '[]'); } catch { /* none */ }
    const domains = [...new Set([...p.dns_blocklist, ...feedDomains])];
    const a = h.writeConfig(DNS_BLOCKLIST, renderDnsBlocklist(domains)), b = h.writeConfig(DNS_MODE_CONF, renderDnsMode(domains.length > 0));
    if (a || b) await h.reloadDns().catch((e) => h.audit('dns_reload_failed', { error: String(e?.message ?? e) }));
    const dirs = p.download_scan ? downloadDirs(homes) : [];
    const key = dirs.join('\n');
    if (this.downloads?.key !== key) {
      this.downloads?.stop();
      this.downloads = dirs.length ? { key, stop: h.watchFiles(dirs, (f) => void this.onDownload(f)) } : null;
    }
  }

  private followUnit(unit: string, on: boolean, fn: (line: string) => void) {
    if (on && !this.followers[unit]) this.followers[unit] = this.o.host.follow(unit, fn);
    if (!on && this.followers[unit]) { this.followers[unit](); delete this.followers[unit]; }
  }

  /** Stops followers and watchers (shutdown, tests). */
  close() { for (const k of Object.keys(this.followers)) this.followUnit(k, false, () => {}); this.downloads?.stop(); this.downloads = null; }

  private event(e: Omit<ProtectionEvent, 'id' | 'at'>): ProtectionEvent {
    const ev = { id: randomUUID(), at: this.now(), ...e };
    this.save((x) => { (x.events ??= []).push(ev); });
    this.o.host.audit(`protection_${e.kind}`, { path: e.path, exe: e.exe, signature: e.signature, enforced: e.enforced });
    return ev;
  }

  /** worksuite-guard output: a refused write or program, or a process suspended for a burst of changes. */
  onGuardLine(line: string) {
    const e = parseGuardLine(line);
    if (!e) return;
    this.event(e);
    void this.publish().catch(() => {});
  }

  /** clamonacc output: the open was refused (prevention) or reported; the file then goes to quarantine. */
  async onAccessLine(line: string) {
    const d = parseOnAccessLine(line);
    if (!d) return;
    const p = this.protection();
    this.event({ kind: p.realtime_prevention ? 'onaccess_blocked' : 'onaccess_detected', path: d.path, signature: d.signature, enforced: p.realtime_prevention });
    await this.quarantineDetection(d, 'realtime');
    await this.publish().catch(() => {});
  }

  /** A new file in a Downloads folder: scanned at once, quarantined when infected. */
  async onDownload(path: string) {
    const s = this.settings();
    if (!s.antivirus || s.av_exclusions.some((e) => path === e || path.startsWith(e.replace(/\/+$/, '') + '/'))) return;
    let found: Detection[];
    try { found = await this.o.host.scanFiles([path], s); } catch { return; }
    for (const d of found) {
      this.event({ kind: 'download_threat', path: d.path, signature: d.signature, enforced: true });
      await this.quarantineDetection(d, 'download');
    }
    if (found.length) await this.publish().catch(() => {});
  }

  private async quarantineDetection(d: Detection, scan_id: string) {
    let quarantine_id: string | undefined;
    try { quarantine_id = await this.o.host.quarantine(d.path, d.signature); } catch { /* left in place, shown as needing action */ }
    this.save((x) => { x.threats.push({ id: randomUUID(), at: this.now(), path: d.path, signature: d.signature, action: quarantine_id ? 'quarantined' : 'detected', quarantine_id, scan_id }); });
    this.o.host.audit(quarantine_id ? 'threat_quarantined' : 'threat_detected', { scan_id, signature: d.signature, path: d.path });
  }

  /** Threat-intel feeds (#38): fetched over https, used only when hash-pinned or signed, merged with size limits. */
  async refreshFeeds(force = false): Promise<void> {
    const p = this.protection(), h = this.o.host, now = this.now();
    if (!force && this.st.feeds && now - this.st.feeds.at < FEED_EVERY) return;
    if (!p.firewall_threat_feeds.length && !p.dns_threat_feeds.length) {
      if (this.st.feeds) { h.feedCache('firewall', null); h.feedCache('dns', null); this.save((x) => { delete x.feeds; }); await this.enforce(); }
      return;
    }
    const errors: string[] = [];
    const get = async (f: Feed) => {
      try {
        const r = await h.fetchFeed(f.url, FEED_MAX_BYTES, !!f.key);
        if (!verifyFeed(f, r.body, r.signature)) { errors.push(`${f.url}: verification failed`); return null; }
        return r.body.toString('utf8');
      } catch (e) { errors.push(`${f.url}: ${e instanceof Error ? e.message : String(e)}`.slice(0, 300)); return null; }
    };
    // The management server's addresses are never blocked, whatever a feed says.
    const server = this.o.managed().server;
    const keep = server ? await h.resolve(new URL(server).hostname).catch(() => []) : [];
    let fwChanged = false, dnsChanged = false;
    if (p.firewall_threat_feeds.length) {
      const bodies = await Promise.all(p.firewall_threat_feeds.map(get));
      if (bodies.some((b) => b !== null)) {
        const merged = parseIpFeed(bodies.filter((b): b is string => b !== null).join('\n'), p.firewall_threat_max_entries, keep);
        const next = JSON.stringify({ v4: merged.v4, v6: merged.v6 });
        fwChanged = h.feedCache('firewall') !== next;
        h.feedCache('firewall', next);
      }
    } else if (h.feedCache('firewall') !== null) { h.feedCache('firewall', null); fwChanged = true; }
    if (p.dns_threat_feeds.length) {
      const bodies = await Promise.all(p.dns_threat_feeds.map(get));
      if (bodies.some((b) => b !== null)) {
        const next = JSON.stringify(parseDomainFeed(bodies.filter((b): b is string => b !== null).join('\n'), 100_000));
        dnsChanged = h.feedCache('dns') !== next;
        h.feedCache('dns', next);
      }
    } else if (h.feedCache('dns') !== null) { h.feedCache('dns', null); dnsChanged = true; }
    const fw = this.threatEntries();
    let dnsN = 0; try { dnsN = (JSON.parse(h.feedCache('dns') ?? '[]') as unknown[]).length; } catch { /* none */ }
    this.save((x) => { x.feeds = { at: now, firewall_entries: fw.v4.length + fw.v6.length, dns_entries: dnsN, errors }; });
    if (errors.length) h.audit('threat_feed_errors', { errors });
    if (fwChanged || dnsChanged) { h.audit('threat_feeds_updated', { firewall_entries: fw.v4.length + fw.v6.length, dns_entries: dnsN }); await this.enforce(); }
  }

  /** Quarantine management (#38): restore re-scans first; a still-detected file needs force (administrator). */
  async restore(id: string, force: boolean, by: 'user' | 'remote'): Promise<void> {
    const t = this.st.threats.find((x) => x.quarantine_id === id && x.action === 'quarantined');
    if (!t) throw new Error('NOT_IN_QUARANTINE');
    const r = await this.o.host.restoreQuarantined(id, force);
    this.save((x) => { const y = x.threats.find((z) => z.quarantine_id === id && z.action === 'quarantined'); if (y) y.action = 'restored'; });
    this.o.host.audit('quarantine_restored', { id, path: r.path, signature: t.signature, by, force });
    await this.publish();
  }

  async deleteQuarantined(id: string, by: 'user' | 'remote'): Promise<void> {
    const t = this.st.threats.find((x) => x.quarantine_id === id && x.action === 'quarantined');
    if (!t) throw new Error('NOT_IN_QUARANTINE');
    await this.o.host.deleteQuarantined(id);
    this.save((x) => { const y = x.threats.find((z) => z.quarantine_id === id && z.action === 'quarantined'); if (y) y.action = 'deleted'; });
    this.o.host.audit('quarantine_deleted', { id, path: t.path, signature: t.signature, by });
    await this.publish();
  }

  /** A process the ransomware check suspended: let it continue, or end it. */
  async resolveSuspended(eventId: string, action: 'resume' | 'terminate', by: 'user' | 'remote'): Promise<void> {
    const e = (this.st.events ?? []).find((x) => x.id === eventId && x.kind === 'ransomware_suspended');
    if (!e || e.resolved) throw new Error('NOT_SUSPENDED');
    const r = e.pid && e.start ? await this.o.host.signal(e.pid, e.start, action === 'resume' ? 'SIGCONT' : 'SIGKILL') : 'gone';
    const resolved = r === 'gone' ? 'gone' : action === 'resume' ? 'resumed' : 'terminated';
    this.save((x) => { const y = (x.events ?? []).find((z) => z.id === eventId); if (y) y.resolved = resolved; });
    this.o.host.audit('suspended_process_resolved', { exe: e.exe, path: e.path, resolved, by });
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
    return securityStatus(s, this.st, f, this.now(), this.o.managed().enrolled, this.running !== null, this.protection(), this.guarded);
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
    await this.refreshFeeds().catch((e) => this.o.host.audit('threat_feed_errors', { errors: [String(e?.message ?? e)] }));
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
    return { overall: st.overall, issues: st.issues, firewall: st.firewall, isolation: st.isolation, antivirus: { ...st.antivirus, last_scan: st.antivirus.last_scan }, threats: st.threats, recent: st.history.slice(0, 10),
      // #38: protection layers, blocks, suspended processes and the quarantine the console manages.
      realtime: st.realtime, protected_folders: { count: st.protected_folders.folders.length, mode: st.protected_folders.mode, state: st.protected_folders.state },
      app_control: st.app_control, web: st.web, threat_intel: st.threat_intel, auto_patch: st.auto_patch,
      events: st.events.slice(0, 10), suspended: st.suspended, quarantine: st.quarantine.slice(0, 50) };
  }
}

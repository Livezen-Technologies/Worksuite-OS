// Device agent core (SRS §9.3, §14.3). All effects on the machine go through Host so the logic is testable.
import { verify, type KeyObject } from 'node:crypto';
import { ApiError, type DeviceApi } from './api.ts';
import { canonical, validateCommand, type CommandEnvelope, type CommandName } from './commands.ts';
import { offlineAccessExpired, offlineNotice, policyEnforcement, type Enforcement } from './enforce.ts';
import type { AgentState, Policy, StateFile } from './state.ts';

export interface Host {
  generateDeviceKey(): Promise<{ publicKeyPem: string; tpmBacked: boolean }>;
  facts(): Promise<{ arch: string; hostname: string; os_version: string; shell_version: string; kernel_version: string; update_status: string }>;
  inventory(): Promise<Record<string, unknown>>;
  /** Device credential for user services (/run/worksuite-device-agent/device-token); null removes it. */
  publishCredential(credential: string | null): void;
  /** Effective policy (0644, no secrets) and user-visible status for Settings > About this device (WSOS-MDM-007). */
  publishPolicy(policy: Policy | null): void;
  publishStatus(status: Record<string, unknown>): void;
  lockAllSessions(): Promise<void>;
  /** Writes/removes the policy files and flips USB storage and Bluetooth (WSOS-MDM-002). Idempotent. */
  applyEnforcement(e: Enforcement): Promise<void>;
  /** Notice text → local sign-in refused with it (pam_nologin); null → allowed again. */
  setOfflineAccessBlock(notice: string | null): void;
  installApproved(catalogId: string): Promise<void>;
  scheduleUpdate(): Promise<void>;
  scheduleReboot(window: string | undefined): Promise<void>;
  /** Approved profiles only; unknown profile → throws. No file contents beyond the profile's fixed list. */
  collectDiagnostics(profile: string): Promise<{ profile: string; sha256: string; content: string }>;
  isFullyEncrypted(): Promise<boolean>;
  wipeWorkSuiteData(): Promise<void>;
  /** Destroys every LUKS key slot and header backup, then reboots to the installer. Does not return on success. */
  cryptoErase(): Promise<void>;
  audit(event: string, fields?: Record<string, unknown>): void;
}

export interface AgentOptions {
  state: StateFile;
  api: DeviceApi;
  host: Host;
  /** Server signing keys for commands and policy, by key id (shipped in worksuite-archive-keyring). */
  keys: (keyId: string) => KeyObject | undefined;
  now?: () => number;
}

const DAY = 86_400_000;

class WipeDeferred extends Error {}

export interface DeviceFacts { hostname: string; os_version: string; arch: string; kernel_version: string; encrypted: boolean }

export class Agent {
  private o: AgentOptions & { now: () => number };
  private facts: DeviceFacts | null = null;

  /** Facts shown in Settings > About this device, managed or not. */
  async refreshFacts() {
    const f = await this.o.host.facts();
    this.facts = { hostname: f.hostname, os_version: f.os_version, arch: f.arch, kernel_version: f.kernel_version, encrypted: await this.o.host.isFullyEncrypted().catch(() => false) };
    this.publishStatus();
  }
  constructor(opts: AgentOptions) { this.o = { now: Date.now, ...opts }; }
  private get s(): AgentState { return this.o.state.state; }

  /** Enrollment (§9.3 steps 1–4). The token is short-lived and never stored. */
  async enroll(serverUrl: string, enrollmentToken: string): Promise<string> {
    if (this.s.enrolled) throw new Error('ALREADY_ENROLLED');
    const url = new URL(serverUrl);
    if (url.protocol !== 'https:') throw new Error('INSECURE_URL');
    const key = await this.o.host.generateDeviceKey();
    const facts = await this.o.host.facts();
    const r = await this.o.api.register(url.toString(), enrollmentToken, { public_key: key.publicKeyPem, tpm_backed: key.tpmBacked, arch: facts.arch, hostname: facts.hostname });
    this.o.state.update((s) => {
      Object.assign(s, { enrolled: true, wiped: false, device_id: r.device_id, credential: r.credential, server_url: url.toString(), org_name: r.org_name, enrolled_at: this.o.now() });
    });
    this.o.host.publishCredential(r.credential);
    this.o.host.audit('enrolled', { device_id: r.device_id, server: url.host, tpm_backed: key.tpmBacked });
    await this.refreshPolicy().catch(() => {});
    this.publishStatus();
    return r.device_id;
  }

  /** Fetch and verify the signed policy; an unsigned or tampered policy is rejected and the old one kept. */
  async refreshPolicy(): Promise<Policy | undefined> {
    if (!this.s.enrolled) return undefined;
    const p = await this.o.api.policy();
    if (!this.verifyPolicy(p)) { this.o.host.audit('policy_rejected', { version: p?.version }); throw new Error('POLICY_SIGNATURE'); }
    this.o.state.update((s) => { s.policy = p; s.last_check_in = this.o.now(); });
    this.o.host.publishPolicy(p);
    await this.enforce();
    this.publishStatus();
    return p;
  }

  /** Applies the current policy to the machine; an unmanaged device gets every restriction removed. */
  async enforce(): Promise<void> {
    const p = this.s.enrolled ? this.s.policy ?? null : null;
    try {
      await this.o.host.applyEnforcement(policyEnforcement(p));
      this.o.host.audit('policy_enforced', { version: p?.version ?? null, usb_storage: p?.usb_storage ?? 'allow', bluetooth: p?.bluetooth ?? true, lock_timeout_max_s: p?.lock_timeout_max_s ?? null });
    } catch (e) {
      this.o.host.audit('policy_enforce_failed', { version: p?.version ?? null, error: e instanceof Error ? e.message : String(e) });
    }
    if (!this.s.enrolled && this.s.offline_access_expired) this.setOfflineBlock(false);
  }

  private setOfflineBlock(expired: boolean) {
    const days = this.s.policy?.offline_access_days ?? 0;
    this.o.host.setOfflineAccessBlock(expired ? offlineNotice(this.s.org_name, days) : null);
    this.o.state.update((s) => { s.offline_access_expired = expired; });
    this.o.host.audit(expired ? 'offline_access_expired' : 'offline_access_restored', { days });
  }

  /** WSOS-AUTH-003 / WSOS-DIR-005: no check-in for the offline access period → lock now, refuse new sign-ins. */
  private async offlineAccessCheck() {
    if (this.s.offline_access_expired || !offlineAccessExpired(this.s.policy, this.s.last_check_in, this.o.now())) return;
    this.setOfflineBlock(true);
    await this.o.host.lockAllSessions().catch(() => {});
  }

  verifyPolicy(p: Policy): boolean {
    if (!p || typeof p.signature !== 'string' || typeof p.version !== 'string') return false;
    const [keyId, value] = p.signature.split(':', 2);
    const key = value ? this.o.keys(keyId) : undefined;
    if (!key) return false;
    const { signature: _sig, ...rest } = p;
    try { return verify(null, Buffer.from(canonical(rest)), key, Buffer.from(value, 'base64')); } catch { return false; }
  }

  /** One check-in: flush pending acks, heartbeat, then validate and run returned commands in order. */
  async checkIn(): Promise<void> {
    if (!this.s.enrolled) return;
    try {
      await this.flushAcks();
      const f = await this.o.host.facts();
      const res = await this.o.api.heartbeat({
        os_version: f.os_version, shell_version: f.shell_version, kernel_version: f.kernel_version,
        policy_version: this.s.policy?.version ?? '', update_status: f.update_status,
        // Unknown encryption (e.g. an overlay root on the live ISO) reports false; it must never block the check-in.
        observed: { policy_version: this.s.policy?.version ?? null, encrypted: await this.o.host.isFullyEncrypted().catch(() => false) },
      });
      await this.refreshFacts();
      this.o.state.update((s) => { s.last_check_in = this.o.now(); });
      if (this.s.offline_access_expired) this.setOfflineBlock(false);
      for (const c of res.commands ?? []) await this.handle(c);
    } catch (e) {
      if (e instanceof ApiError && e.code === 'DEVICE_REVOKED') return this.unenrollLocally('revoked');
      if (e instanceof ApiError && e.status === 0) { await this.offlineAccessCheck(); return this.offlineKillTimer(); }
      throw e;
    } finally {
      this.publishStatus();
    }
  }

  private async handle(input: unknown) {
    const v = validateCommand(input, { deviceId: this.s.device_id!, keys: this.o.keys, replay: this.o.state.replayStore(), now: this.o.now });
    const id = typeof (input as { id?: unknown })?.id === 'string' ? (input as { id: string }).id : null;
    if (!v.ok) {
      this.o.host.audit('command_rejected', { id, reason: v.reason });
      // REPLAY: already handled once; never ack twice for a different outcome.
      if (id && v.reason !== 'REPLAY' && v.reason !== 'MALFORMED') await this.ack(id, 'rejected', v.reason);
      return;
    }
    const c = v.envelope;
    this.o.host.audit('command_accepted', { id: c.id, command: c.command });
    await this.ack(c.id, 'received');
    try {
      const done = await this.run(c);
      if (done) await this.ack(c.id, 'completed');
    } catch (e) {
      if (e instanceof WipeDeferred) { this.o.host.audit('wipe_deferred', { id: c.id }); return; }
      const reason = e instanceof Error ? e.message : 'FAILED';
      this.o.host.audit('command_failed', { id: c.id, command: c.command, reason });
      await this.ack(c.id, 'failed', reason);
    }
  }

  /** Returns false when the command acks itself (wipe). */
  private async run(c: CommandEnvelope): Promise<boolean> {
    const h = this.o.host;
    const cmd: CommandName = c.command;
    switch (cmd) {
      case 'RefreshPolicy': await this.refreshPolicy(); return true;
      case 'RequestLock': await h.lockAllSessions(); return true;
      case 'InstallApprovedApplication': {
        const id = String(c.args.catalog_id);
        // Server-side approval is not enough: the device's own signed allowlist must contain it too.
        if (!(this.s.policy?.app_allowlist ?? []).includes(id)) throw new Error('NOT_IN_ALLOWLIST');
        await h.installApproved(id); return true;
      }
      case 'ScheduleUpdate': await h.scheduleUpdate(); return true;
      case 'RebootDuringWindow': await h.scheduleReboot(this.s.policy?.maintenance_window); return true;
      case 'CollectApprovedDiagnostics': {
        const bundle = await h.collectDiagnostics(String(c.args.bundle_profile));
        await this.o.api.diagnostics({ command_id: c.id, ...bundle });
        return true;
      }
      case 'RemoteWipe': await this.wipe(c); return false;
    }
  }

  /** §14.3. Ack "started" reaches the server before anything is destroyed (WSOS-WIPE-005). */
  private async wipe(c: CommandEnvelope) {
    const scope = c.args.scope as 'worksuite_data' | 'full_device';
    if (scope === 'full_device' && !(await this.o.host.isFullyEncrypted())) {
      await this.ack(c.id, 'rejected', 'NOT_ENCRYPTED');   // WSOS-WIPE-003
      return;
    }
    try {
      await this.o.api.ack(c.id, 'started');
    } catch {
      // Nothing destroyed yet. Forget the id so the server's next delivery of this same command is accepted.
      this.o.state.update((s) => { delete s.seen_commands[c.id]; });
      throw new WipeDeferred();
    }
    this.o.host.audit('wipe_started', { id: c.id, scope, approval_id: c.args.approval_id });
    await this.o.host.wipeWorkSuiteData();
    if (scope === 'worksuite_data') {
      await this.ack(c.id, 'completed');
      this.unenrollLocally('wiped');
      return;
    }
    this.unenrollLocally('wiped');
    await this.o.host.cryptoErase();                       // reboots; "completed" only on re-enrollment
  }

  /** WSOS-WIPE-006: no policy check-in for N days → local WorkSuite data wipe. */
  private async offlineKillTimer() {
    const days = this.s.policy?.offline_wipe_days;
    if (!days || !this.s.last_check_in || this.s.wiped) return;
    if (this.o.now() - this.s.last_check_in < days * DAY) return;
    this.o.host.audit('offline_kill_timer', { days });
    await this.o.host.wipeWorkSuiteData();
    this.o.state.update((s) => { s.wiped = true; });
  }

  private unenrollLocally(reason: 'revoked' | 'wiped') {
    this.o.state.update((s) => {
      Object.assign(s, { enrolled: false, credential: undefined, policy: undefined, wiped: reason === 'wiped' || s.wiped });
    });
    this.o.host.publishCredential(null);
    this.o.host.publishPolicy(null);
    this.o.host.audit('unenrolled', { reason });
    void this.enforce();
  }

  private async ack(id: string, state: string, reason?: string) {
    try { await this.o.api.ack(id, state, reason); }
    catch { this.o.state.update((s) => { s.pending_acks.push({ id, state, reason }); }); }
  }

  private async flushAcks() {
    while (this.s.pending_acks.length) {
      const a = this.s.pending_acks[0];
      await this.o.api.ack(a.id, a.state, a.reason);
      this.o.state.update((s) => { s.pending_acks.shift(); });
    }
  }

  /** WSOS-MDM-007, WSOS-WIPE-007: what the user sees in Settings > About this device. */
  status() {
    const p = this.s.policy;
    return {
      device: this.facts,
      managed: this.s.enrolled,
      org_name: this.s.org_name ?? null,
      server: this.s.server_url ? new URL(this.s.server_url).host : null,
      device_id: this.s.device_id ?? null,
      last_check_in: this.s.last_check_in ?? null,
      wiped: this.s.wiped ?? false,
      offline_access_expired: this.s.offline_access_expired ?? false,
      policies: p ? {
        version: p.version, update_ring: p.update_ring ?? null, update_mode: p.update_mode ?? null,
        maintenance_window: p.maintenance_window ?? null, lock_timeout_max_s: p.lock_timeout_max_s ?? null,
        offline_access_days: p.offline_access_days ?? null, usb_storage: p.usb_storage ?? null, bluetooth: p.bluetooth ?? null,
        login_failures_max: p.login_failures_max ?? null, login_lockout_s: p.login_lockout_s ?? null,
        app_allowlist_size: p.app_allowlist?.length ?? 0,
      } : null,
      can_wipe_data: this.s.enrolled,
      can_wipe_device: this.s.enrolled,
    };
  }

  publishStatus() { this.o.host.publishStatus(this.status()); }
}

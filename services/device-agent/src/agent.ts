// Device agent core (SRS §9.3, §14.3). All effects on the machine go through Host so the logic is testable.
import { rmSync } from 'node:fs';
import { dropSent, monitoringOn, readPowerEvents } from './power.ts';
import { verify, type KeyObject } from 'node:crypto';
import { ApiError, type DeviceApi } from './api.ts';
import { canonical, validateCommand, type CommandEnvelope, type CommandName } from './commands.ts';
import { offlineAccessExpired, offlineNotice, policyEnforcement, type Enforcement } from './enforce.ts';
import { activeKiosk, publicPolicy } from './kiosk.ts';

function kioskSummary(k: ReturnType<typeof activeKiosk>) {
  return k ? { user: k.user, app: k.app, allowed_urls: k.allowed_urls, idle_reset_minutes: k.idle_reset_minutes, show_on_screen_keyboard: k.show_on_screen_keyboard, exit_pin: k.verifier !== null, orientation: k.orientation, screen_off: k.screen_off } : null;
}
import type { AgentState, Policy, StateFile } from './state.ts';
import { parseRequest, type RemoteSupport } from './remoteSupport.ts';
import type { SecurityCenter } from './securityCenter.ts';
import { rotationDue, userVpnsToRemove, vpnPlan, type NmConnection, type VpnConfig, type VpnPlan } from './vpn.ts';

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
  /** Software Management remote uninstall; the package service refuses system packages (critical set). */
  removeApplication(catalogId: string): Promise<void>;
  scheduleUpdate(): Promise<void>;
  scheduleReboot(window: string | undefined): Promise<void>;
  /** Approved profiles only; unknown profile → throws. No file contents beyond the profile's fixed list. */
  collectDiagnostics(profile: string): Promise<{ profile: string; sha256: string; content: string }>;
  isFullyEncrypted(): Promise<boolean>;
  wipeWorkSuiteData(): Promise<void>;
  /** Destroys every LUKS key slot and header backup, then reboots to the installer. Does not return on success. */
  cryptoErase(): Promise<void>;
  audit(event: string, fields?: Record<string, unknown>): void;
  /** WireGuard keypair in the 0700 state dir; returns the public key, creating one if needed. rotate → new keypair. */
  wgPublicKey(rotate: boolean): Promise<string>;
  /** Deletes the WireGuard private key (unenrolment, wipe). */
  forgetWgKey(): void;
  /**
   * Managed VPN as a NetworkManager system connection (keyfile 0600, private key from the state dir), connected when
   * plan.autoconnect, plus the nftables kill switch. null removes the connection and the kill switch. Idempotent.
   */
  applyVpn(plan: VpnPlan | null): Promise<void>;
  /** VPN-type profiles NetworkManager knows (wireguard and plugin VPNs). */
  vpnConnections(): Promise<NmConnection[]>;
  removeConnection(uuid: string): Promise<void>;
}

export interface AgentOptions {
  state: StateFile;
  api: DeviceApi;
  host: Host;
  /** Server signing keys for commands and policy, by key id (shipped in worksuite-archive-keyring). */
  keys: (keyId: string) => KeyObject | undefined;
  now?: () => number;
  /** Remote support consent and sessions (issue #19); without it remote-support commands fail NOT_SUPPORTED. */
  remoteSupport?: RemoteSupport;
  /** WorkSuite Security (#20); absent = the device has no security module (tests, rescue). */
  security?: SecurityCenter;
  /** Device startup/shutdown file for activity monitoring (#39, src/power.ts); absent = not reported. */
  powerEventsFile?: string;
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
    // A fresh WireGuard keypair per enrolment; only its public half goes to the server (managed VPN).
    const wg = await this.o.host.wgPublicKey(true).catch(() => undefined);
    const r = await this.o.api.register(url.toString(), enrollmentToken, { public_key: key.publicKeyPem, tpm_backed: key.tpmBacked, arch: facts.arch, hostname: facts.hostname, ...(wg ? { wg_public_key: wg } : {}) });
    this.o.state.update((s) => {
      Object.assign(s, { enrolled: true, wiped: false, device_id: r.device_id, credential: r.credential, server_url: url.toString(), org_name: r.org_name, enrolled_at: this.o.now(), vpn: undefined, vpn_key_created_at: wg ? this.o.now() : undefined });
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
    this.o.host.publishPolicy(publicPolicy(p));
    // The VPN config travels with the policy refresh; a failure keeps the last verified config in force.
    await this.refreshVpn().catch((e) => this.o.host.audit('vpn_refresh_failed', { error: e instanceof Error ? e.message : String(e) }));
    await this.enforce();
    this.publishStatus();
    return p;
  }

  /** Applies the current policy to the machine; an unmanaged device gets every restriction removed. */
  async enforce(): Promise<void> {
    const p = this.s.enrolled ? this.s.policy ?? null : null;
    try {
      await this.o.host.applyEnforcement(policyEnforcement(p, this.s.device_id));
      this.o.host.audit('policy_enforced', { version: p?.version ?? null, usb_storage: p?.usb_storage ?? 'allow', bluetooth: p?.bluetooth ?? true, lock_timeout_max_s: p?.lock_timeout_max_s ?? null });
    } catch (e) {
      this.o.host.audit('policy_enforce_failed', { version: p?.version ?? null, error: e instanceof Error ? e.message : String(e) });
    }
    await this.enforceVpn(p);
    await this.o.security?.enforce().catch(() => {});
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

  /**
   * Fetch, verify and store the managed-VPN config. The device makes its own keypair: on VPN_PEER_KEY_REQUIRED (first
   * use, or an admin rotated the key) and when key_rotation_days has passed it generates a new one and registers only
   * the public key. A config that is unsigned, for another device, or for a key this device does not hold is rejected.
   */
  async refreshVpn(): Promise<VpnConfig | undefined> {
    if (!this.s.enrolled) return undefined;
    const register = async (rotate: boolean) => {
      const pub = await this.o.host.wgPublicKey(rotate);
      if (rotate || !this.s.vpn_key_created_at) {
        this.o.state.update((s) => { s.vpn_key_created_at = this.o.now(); });
        this.o.host.audit('vpn_key_generated', { public_key: pub });
      }
      return this.o.api.vpnPeer(pub);
    };
    let cfg: VpnConfig;
    try { cfg = await this.o.api.vpn(); } catch (e) {
      if (!(e instanceof ApiError && e.code === 'VPN_PEER_KEY_REQUIRED')) throw e;
      // New keypair only if the server had accepted our current key and then forgot it (admin rotation). Otherwise
      // (first use, or a server that ignored the key sent at registration) register the key we already hold.
      const held = this.s.vpn_key_created_at ? await this.o.host.wgPublicKey(false) : undefined;
      cfg = await register(!!held && this.s.vpn?.enabled === true && this.s.vpn.device_public_key === held);
    }
    if (this.verifyVpn(cfg) && cfg.enabled) {
      if (rotationDue(cfg, this.s.vpn_key_created_at, this.o.now())) cfg = await register(true);
      // The server has a different key than ours (e.g. the key file was lost): re-register the key we hold.
      else if (cfg.device_public_key !== await this.o.host.wgPublicKey(false)) cfg = await this.o.api.vpnPeer(await this.o.host.wgPublicKey(false));
    }
    if (!this.verifyVpn(cfg)) { this.o.host.audit('vpn_config_rejected', { version: cfg?.version }); throw new Error('VPN_SIGNATURE'); }
    if (cfg.enabled && cfg.device_public_key !== await this.o.host.wgPublicKey(false)) throw new Error('VPN_KEY_MISMATCH');
    this.o.state.update((s) => { s.vpn = cfg; });
    return cfg;
  }

  verifyVpn(c: VpnConfig): boolean {
    return !!c && typeof c.enabled === 'boolean' && c.device_id === this.s.device_id && this.verifyPolicy(c as unknown as Policy);
  }

  /** Managed connection, kill switch and the user-VPN rule. Unenrolled → everything WorkSuite added is removed. */
  private async enforceVpn(p: Policy | null) {
    const h = this.o.host;
    try {
      const plan = vpnPlan(this.s.enrolled ? this.s.vpn : null, p);
      await h.applyVpn(plan);
      h.audit('vpn_enforced', { managed: !!plan, version: plan?.config.version ?? null, autoconnect: plan?.autoconnect ?? false, kill_switch: plan?.kill_switch ?? false });
      if (p?.vpn_required && !plan) h.audit('vpn_required_without_config', {});
    } catch (e) {
      h.audit('vpn_enforce_failed', { error: e instanceof Error ? e.message : String(e) });
    }
    try {
      for (const c of userVpnsToRemove(await h.vpnConnections(), p)) {
        await h.removeConnection(c.uuid);
        h.audit('user_vpn_removed', { name: c.name, type: c.type });
      }
    } catch (e) {
      h.audit('user_vpn_enforce_failed', { error: e instanceof Error ? e.message : String(e) });
    }
  }

  verifyPolicy(p: Policy): boolean {
    if (!p || typeof p.signature !== 'string' || typeof p.version !== 'string') return false;
    const [keyId, value] = p.signature.split(':', 2);
    const key = value ? this.o.keys(keyId) : undefined;
    if (!key) return false;
    const { signature: _sig, ...rest } = p;
    try { return verify(null, Buffer.from(canonical(rest)), key, Buffer.from(value, 'base64')); } catch { return false; }
  }

  /** Remote-support requests are polled every few seconds (src/main.ts), not only at the 15-minute check-in. */
  async pollRemoteSupport(): Promise<void> {
    if (!this.s.enrolled || !this.o.remoteSupport) return;
    await this.o.remoteSupport.tick();
    const res = await this.o.api.remoteSupportCommands();
    for (const c of res.commands ?? []) await this.handle(c);
  }

  /** One check-in: flush pending acks, heartbeat, then validate and run returned commands in order. */
  async checkIn(): Promise<void> {
    if (!this.s.enrolled) return;
    try {
      await this.flushAcks();
      const f = await this.o.host.facts();
      // #39: startup/shutdown only while the signed policy has activity monitoring on; otherwise none are kept.
      const pf = this.o.powerEventsFile;
      const power = pf && monitoringOn(this.s) ? readPowerEvents(pf) : [];
      if (pf && !monitoringOn(this.s)) rmSync(pf, { force: true });
      const res = await this.o.api.heartbeat({
        os_version: f.os_version, shell_version: f.shell_version, kernel_version: f.kernel_version,
        policy_version: this.s.policy?.version ?? '', update_status: f.update_status,
        // Unknown encryption (e.g. an overlay root on the live ISO) reports false; it must never block the check-in.
        observed: { policy_version: this.s.policy?.version ?? null, encrypted: await this.o.host.isFullyEncrypted().catch(() => false) },
        // Admin Center › Security Center: firewall, antivirus, threats, isolation (no file contents).
        ...(this.o.security ? { security: await this.o.security.summary().catch(() => null) } : {}),
        ...(power.length ? { power_events: power } : {}),
      });
      if (pf && power.length) dropSent(pf, power);
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
        await h.installApproved(id);
        await this.reportInventory();
        return true;
      }
      case 'RemoveApplication': {
        await h.removeApplication(String(c.args.catalog_id));
        await this.reportInventory();
        return true;
      }
      case 'ScheduleUpdate': await h.scheduleUpdate(); return true;
      case 'RebootDuringWindow': await h.scheduleReboot(this.s.policy?.maintenance_window); return true;
      case 'CollectApprovedDiagnostics': {
        const bundle = await h.collectDiagnostics(String(c.args.bundle_profile));
        await this.o.api.diagnostics({ command_id: c.id, ...bundle });
        return true;
      }
      case 'RemoteWipe': await this.wipe(c); return false;
      case 'RemoteSupportRequest': {
        const rs = this.o.remoteSupport;
        if (!rs) throw new Error('NOT_SUPPORTED');
        if (this.s.policy?.remote_support?.enabled === false) throw new Error('REMOTE_SUPPORT_DISABLED');
        const req = parseRequest(c.args, Date.parse(c.expires_at));
        if (!req) throw new Error('BAD_ARGS');
        // "completed" means delivered to the device; consent and the session's life are reported on their own.
        await rs.request(req);
        return true;
      }
      case 'RemoteSupportEnd': {
        if (!this.o.remoteSupport) throw new Error('NOT_SUPPORTED');
        await this.o.remoteSupport.end('admin_ended', String(c.args.session_id));
        return true;
      }
      case 'StartMalwareScan': {
        if (!this.o.security) throw new Error('NOT_SUPPORTED');
        // Acked when it has started; the result reaches the server with the next check-in's security summary.
        void this.o.security.scan(c.args.kind === 'full' ? 'full' : 'quick', 'remote').catch(() => {});
        return true;
      }
      case 'IsolateEndpoint': if (!this.o.security) throw new Error('NOT_SUPPORTED'); await this.o.security.isolate(c.args.hours); return true;
      case 'ReleaseIsolation': if (!this.o.security) throw new Error('NOT_SUPPORTED'); await this.o.security.release(); return true;
    }
  }

  /** After a remote install or removal, so Software Management shows the new state without waiting for the daily inventory. */
  private async reportInventory() {
    try { await this.o.api.inventory(await this.o.host.inventory()); } catch { /* the periodic inventory catches up */ }
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
      Object.assign(s, { enrolled: false, credential: undefined, policy: undefined, vpn: undefined, vpn_key_created_at: undefined, wiped: reason === 'wiped' || s.wiped });
    });
    // Revoked or wiped: the VPN key is useless (the server dropped the peer) and must not outlive the enrolment.
    void this.o.host.applyVpn(null).catch(() => {}).finally(() => this.o.host.forgetWgKey());
    this.o.host.publishCredential(null);
    this.o.host.publishPolicy(null);
    // WSOS-IDN-007: revocation ends managed sync and policy, never the local accounts: an offline-period block from
    // the old policy no longer applies.
    if (this.s.offline_access_expired) this.setOfflineBlock(false);
    void this.o.remoteSupport?.end('unenrolled');
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
        allow_pin: p.allow_pin ?? null, pin_min_length: p.pin_min_length ?? null,
        app_allowlist_size: p.app_allowlist?.length ?? 0,
        vpn_required: p.vpn_required ?? null, user_vpn: p.user_vpn ?? null,
        ai_assistant: p.ai_assistant ?? null, ai_models: p.ai_models ?? null,
        desktop_widgets: p.desktop_widgets ?? null,
        whatsapp: p.whatsapp ?? null,
        screen_capture: p.screen_capture ?? null, clipboard_history: p.clipboard_history ?? null,
        drivers_online_search: p.drivers_online_search ?? null, drivers_auto_install: p.drivers_auto_install ?? null,
        drivers_auto_install_gpu: p.drivers_auto_install_gpu ?? null,
        software_install: p.software_install ?? null, software_uninstall: p.software_uninstall ?? null, software_update: p.software_update ?? null,
        update_bandwidth_kbps: p.update_bandwidth_kbps ?? null,
        kiosk: this.s.enrolled && activeKiosk(p, this.s.device_id) !== null,
        // Disclosure (issue #19): the organization may start remote support without asking on this device.
        remote_support_unattended: unattendedRemoteSupport(p),
        // Employee monitoring (#22): shown in the management notice so the employee knows.
        activity_monitoring: p.activity_monitoring === true, antivirus: p.antivirus ?? null,
      } : null,
      remote_support: this.o.remoteSupport?.snapshot() ?? null,
      // Settings › Managed › Kiosk mode (board KioskSettings): what this device's kiosk runs. Never the exit PIN or its verifier.
      kiosk: this.s.enrolled ? kioskSummary(activeKiosk(p, this.s.device_id)) : null,
      // Managed VPN as configured (connection state itself comes from NetworkManager in Settings).
      vpn: this.s.enrolled && this.s.vpn?.enabled ? {
        name: 'WorkSuite VPN', endpoint: this.s.vpn.peer?.endpoint ?? null, address: this.s.vpn.interface?.address ?? [],
        always_on: this.s.vpn.always_on === true || p?.vpn_required === true, kill_switch: this.s.vpn.kill_switch === true,
      } : null,
      user_vpn_allowed: p?.user_vpn !== 'block',
      can_wipe_data: this.s.enrolled,
      can_wipe_device: this.s.enrolled,
    };
  }

  publishStatus() { this.o.host.publishStatus(this.status()); }
}

/** Signed policy remote_support: {enabled?, unattended?}. Unattended access only on a managed device. */
export function unattendedRemoteSupport(p: Policy | undefined): boolean {
  const rs = p?.remote_support as { enabled?: unknown; unattended?: unknown } | undefined;
  return !!rs && typeof rs === 'object' && rs.enabled !== false && rs.unattended === true;
}

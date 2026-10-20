// Remote support sessions on the device (issue #19): the consent and session state machine. The administrator's
// request arrives as a signed command (RemoteSupportRequest / RemoteSupportEnd, src/commands.ts); nothing is shared
// until the person at the seat chooses "Allow screen sharing" or "Allow remote control" in the shell's consent dialog,
// unless the organization's signed policy turns on unattended access (remote_support.unattended) and the server marked
// this request as unattended-eligible (corporate-owned, managed device). Even then the indicator is shown, the user
// can end the session at any time, and every transition is audited locally and reported to the server.
//
// Consent is bound to the seat: the dialog's nonce is written 0400 for the active seat0 user only, and Decide must
// present it. Ending a session or dropping control needs no nonce: taking access away is always allowed.
import { randomBytes, timingSafeEqual } from 'node:crypto';

export type RsMode = 'view' | 'control';
export type RsState = 'pending' | 'active' | 'ended';
export type RsEndReason = 'denied' | 'consent_timeout' | 'user_ended' | 'admin_ended' | 'expired' | 'no_user' | 'unenrolled' | 'busy';

export interface RsRequest {
  session_id: string;
  mode: RsMode;
  reason: string;
  admin_name: string;
  org_name: string;
  /** Server: the org's policy allows unattended access and this device is corporate-owned. */
  unattended_eligible: boolean;
  /** Absolute end of the session token (ms); the session never outlives it. */
  expires_at: number;
}

export interface RsSession extends Omit<RsRequest, 'unattended_eligible'> {
  state: RsState;
  /** Who allowed it: the person at the seat, or the organization's disclosed unattended-access policy. */
  consent: 'user' | 'unattended_policy' | null;
  /** What is in force now: never more than requested; the user may drop control to view only. */
  granted_mode: RsMode | null;
  requested_at: number;
  started_at: number | null;
  ended_at: number | null;
  end_reason: RsEndReason | null;
  seat_user: string | null;
}

/** What the server is told on every transition (desktop/v1/os/remote-support/sessions/{id}/state). */
export interface RsReport { state: 'active' | 'ended'; granted_mode: RsMode | null; consent: RsSession['consent']; end_reason: RsEndReason | null }

export interface RsDeps {
  now: () => number;
  /** Active graphical seat0 session owner, or null (nobody signed in / screen at the greeter). */
  seatUser: () => Promise<{ uid: number; user: string } | null>;
  /** Signed policy: unattended access allowed by the organization (and disclosed to users in Settings). */
  unattendedPolicy: () => boolean;
  /** Writes the user-visible session file (no nonce) and the seat user's nonce file; null clears both. */
  publish: (session: RsSession | null, consent: { uid: number; nonce: string } | null) => void;
  report: (sessionId: string, r: RsReport) => Promise<void>;
  audit: (event: string, fields: Record<string, unknown>) => void;
  /** Ends every portal screencast/remote-desktop stream (worksuite-screencast-stop). */
  stopStreams: () => Promise<void>;
  consentTimeoutMs?: number;
}

const SESSION_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const clean = (v: unknown, max: number) => (typeof v === 'string' ? v.replace(/[\u0000-\u001f\u007f]/g, ' ').trim().slice(0, max) : '');

/** Command args → request, or null when anything is missing or out of range. */
export function parseRequest(args: Record<string, unknown>, expiresAt: number): RsRequest | null {
  if (typeof args.session_id !== 'string' || !SESSION_ID.test(args.session_id)) return null;
  if (args.mode !== 'view' && args.mode !== 'control') return null;
  const admin = clean(args.admin_name, 120), org = clean(args.org_name, 120), reason = clean(args.reason, 500);
  if (!admin || !reason) return null;
  return { session_id: args.session_id.toLowerCase(), mode: args.mode, reason, admin_name: admin, org_name: org, unattended_eligible: args.unattended === true, expires_at: expiresAt };
}

export class RemoteSupport {
  private cur: RsSession | null = null;
  private nonce: string | null = null;
  private seatUid: number | null = null;
  private d: RsDeps & { consentTimeoutMs: number };

  constructor(deps: RsDeps) { this.d = { consentTimeoutMs: 120_000, ...deps }; }

  snapshot(): RsSession | null { return this.cur ? { ...this.cur } : null; }

  /** A verified RemoteSupportRequest. Returns the state the session is in afterwards. */
  async request(req: RsRequest): Promise<RsState> {
    if (this.cur && this.cur.state !== 'ended') {
      if (this.cur.session_id === req.session_id) return this.cur.state;
      // One session at a time; the newcomer is refused and reported, the running one is untouched.
      this.d.audit('remote_support_refused', { session_id: req.session_id, reason: 'busy' });
      await this.send(req.session_id, { state: 'ended', granted_mode: null, consent: null, end_reason: 'busy' });
      return 'ended';
    }
    const now = this.d.now();
    const seat = await this.d.seatUser().catch(() => null);
    this.cur = { ...req, state: 'pending', consent: null, granted_mode: null, requested_at: now, started_at: null, ended_at: null, end_reason: null, seat_user: seat?.user ?? null };
    delete (this.cur as Partial<RsRequest>).unattended_eligible;
    this.d.audit('remote_support_requested', { session_id: req.session_id, mode: req.mode, admin: req.admin_name, reason: req.reason });

    // Unattended access needs both the server's eligibility (corporate device, org policy) and this device's own
    // signed policy. It is disclosed in Settings and the indicator still shows for the whole session.
    if (req.unattended_eligible && this.d.unattendedPolicy()) return this.start(req.mode, 'unattended_policy');
    if (!seat) { await this.finish('no_user'); return 'ended'; }

    this.nonce = randomBytes(24).toString('base64url');
    this.seatUid = seat.uid;
    this.publish();
    return 'pending';
  }

  /** The seat user's answer from the consent dialog. The grant never exceeds what was requested. */
  async decide(nonce: unknown, decision: unknown): Promise<RsSession> {
    const s = this.cur;
    if (!s || s.state !== 'pending' || !this.nonce) throw new Error('NO_PENDING_REQUEST');
    if (typeof nonce !== 'string' || !safeEqual(nonce, this.nonce)) throw new Error('BAD_NONCE');
    if (decision === 'deny') { await this.finish('denied'); return this.snapshot()!; }
    if (decision !== 'view' && decision !== 'control') throw new Error('BAD_DECISION');
    if (decision === 'control' && s.mode !== 'control') throw new Error('BAD_DECISION');
    await this.start(decision, 'user');
    return this.snapshot()!;
  }

  /** Stop sharing / revoke control, from the indicator. Taking access away needs no proof of who asks. */
  async revokeControl(): Promise<RsSession | null> {
    const s = this.cur;
    if (!s || s.state !== 'active' || s.granted_mode !== 'control') return this.snapshot();
    s.granted_mode = 'view';
    this.d.audit('remote_support_control_revoked', { session_id: s.session_id });
    this.publish();
    await this.send(s.session_id, { state: 'active', granted_mode: 'view', consent: s.consent, end_reason: null });
    return this.snapshot();
  }

  async end(by: 'user_ended' | 'admin_ended' | 'unenrolled', sessionId?: string): Promise<RsSession | null> {
    const s = this.cur;
    if (!s || s.state === 'ended' || (sessionId && sessionId !== s.session_id)) return this.snapshot();
    await this.finish(by);
    return this.snapshot();
  }

  /** Called every few seconds: unanswered requests time out (denied), sessions end at their token's expiry. */
  async tick(): Promise<void> {
    const s = this.cur;
    if (!s || s.state === 'ended') return;
    const now = this.d.now();
    if (s.state === 'pending' && now - s.requested_at >= this.d.consentTimeoutMs) await this.finish('consent_timeout');
    else if (now >= s.expires_at) await this.finish('expired');
  }

  private async start(mode: RsMode, consent: 'user' | 'unattended_policy'): Promise<RsState> {
    const s = this.cur!;
    Object.assign(s, { state: 'active', granted_mode: mode, consent, started_at: this.d.now() });
    this.nonce = null;
    this.d.audit('remote_support_started', { session_id: s.session_id, mode, consent, admin: s.admin_name, seat_user: s.seat_user });
    this.publish();
    await this.send(s.session_id, { state: 'active', granted_mode: mode, consent, end_reason: null });
    return 'active';
  }

  private async finish(reason: RsEndReason) {
    const s = this.cur!;
    const wasActive = s.state === 'active';
    Object.assign(s, { state: 'ended', ended_at: this.d.now(), end_reason: reason, granted_mode: null });
    this.nonce = null; this.seatUid = null;
    this.d.audit('remote_support_ended', { session_id: s.session_id, reason, was_active: wasActive });
    // Whatever was streaming stops with the session, also if the stream outlived the consent (defence in depth).
    if (wasActive) await this.d.stopStreams().catch((e) => this.d.audit('remote_support_stop_failed', { error: String((e as Error)?.message ?? e) }));
    this.d.publish(null, null);
    await this.send(s.session_id, { state: 'ended', granted_mode: null, consent: s.consent, end_reason: reason });
  }

  private publish() {
    const s = this.cur;
    this.d.publish(s ? { ...s } : null, s?.state === 'pending' && this.nonce && this.seatUid !== null ? { uid: this.seatUid, nonce: this.nonce } : null);
  }

  /** Server reports are best effort; the local audit log is the record when the server can't be reached. */
  private async send(id: string, r: RsReport) {
    try { await this.d.report(id, r); } catch (e) { this.d.audit('remote_support_report_failed', { session_id: id, state: r.state, error: String((e as Error)?.message ?? e) }); }
  }
}

function safeEqual(a: string, b: string) {
  const x = Buffer.from(a), y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}

/**
 * User-facing socket requests (serveSocket in src/control.ts, remote-support.sock 0666): validated here so the socket stays thin.
 * Methods: Status, Decide {nonce, decision}, RevokeControl, End.
 */
export async function consentDispatch(rs: RemoteSupport, line: string): Promise<{ result?: unknown; error?: string }> {
  let req: unknown;
  try { req = JSON.parse(line); } catch { return { error: 'bad_request' }; }
  if (!req || typeof req !== 'object' || Array.isArray(req)) return { error: 'bad_request' };
  const { method, params } = req as { method?: unknown; params?: unknown };
  const p = (params && typeof params === 'object' && !Array.isArray(params) ? params : {}) as Record<string, unknown>;
  try {
    switch (method) {
      case 'Status': return { result: rs.snapshot() };
      case 'Decide': return { result: await rs.decide(p.nonce, p.decision) };
      case 'RevokeControl': return { result: await rs.revokeControl() };
      case 'End': return { result: await rs.end('user_ended') };
      default: return { error: 'unknown_method' };
    }
  } catch (e) { return { error: String((e as Error)?.message ?? e) }; }
}

/** `loginctl list-sessions -o json` + `show-session` output → the active seat0 graphical user. */
export function parseSeatSessions(list: string, show: (id: string) => Record<string, string>): { uid: number; user: string } | null {
  let rows: { session: string; uid: number; user: string; seat?: string }[];
  try { rows = JSON.parse(list); } catch { return null; }
  if (!Array.isArray(rows)) return null;
  for (const r of rows) {
    if (r.seat !== 'seat0') continue;
    const p = show(String(r.session));
    if (p.Active === 'yes' && p.State === 'active' && (p.Type === 'wayland' || p.Type === 'x11') && p.Class === 'user' && Number(r.uid) >= 1000) return { uid: Number(r.uid), user: String(r.user) };
  }
  return null;
}

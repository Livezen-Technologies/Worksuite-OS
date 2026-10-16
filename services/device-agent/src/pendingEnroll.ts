// Enrollment chosen in the installer (WSOS-INS-006): the worksuiteenroll Calamares job leaves
// /var/lib/worksuite-device-agent/enroll-pending.json (0600 root, {server, enrollment_token}); the agent enrolls with
// it on first boot. A network failure keeps the file for the next try; a rejected or expired token, an already
// enrolled device or a malformed file removes it (the person can still enroll from Settings). The token is never
// logged or audited.
import { lstatSync, readFileSync, rmSync } from 'node:fs';
import { ApiError } from './api.ts';

export const PENDING_ENROLLMENT = '/var/lib/worksuite-device-agent/enroll-pending.json';
const TOKEN = /^[A-Za-z0-9_.~-]{8,512}$/;
const SERVER = /^https:\/\/[A-Za-z0-9.-]+(:\d{1,5})?\/[^\s?#]*$/;

export type PendingResult = 'none' | 'enrolled' | 'retry' | 'dropped';

export interface PendingDeps {
  path?: string;
  enrolled(): boolean;
  enroll(serverUrl: string, token: string): Promise<unknown>;
  audit(event: string, data: Record<string, unknown>): void;
  /** Owner the file must have (root in production). */
  uid?: number;
}

export async function applyPendingEnrollment(d: PendingDeps): Promise<PendingResult> {
  const path = d.path ?? PENDING_ENROLLMENT;
  let st;
  try { st = lstatSync(path); } catch { return 'none'; }
  const drop = (reason: string, extra: Record<string, unknown> = {}): PendingResult => {
    rmSync(path, { force: true });
    d.audit('installer_enrollment_dropped', { reason, ...extra });
    return 'dropped';
  };
  if (!st.isFile() || (st.mode & 0o077) !== 0 || st.uid !== (d.uid ?? 0)) return drop('unsafe_file');
  let p: { server?: unknown; enrollment_token?: unknown };
  try { p = JSON.parse(readFileSync(path, 'utf8')); } catch { return drop('malformed'); }
  if (!p || typeof p.server !== 'string' || !SERVER.test(p.server) || typeof p.enrollment_token !== 'string' || !TOKEN.test(p.enrollment_token)) return drop('malformed');
  const server = new URL(p.server).host;
  if (d.enrolled()) return drop('already_enrolled', { server });
  try {
    await d.enroll(p.server, p.enrollment_token);
  } catch (e) {
    if (e instanceof ApiError && e.status >= 400 && e.status < 500) return drop('rejected', { server, code: e.code });
    if (e instanceof Error && e.message === 'ALREADY_ENROLLED') return drop('already_enrolled', { server });
    d.audit('installer_enrollment_retry', { server });
    return 'retry';
  }
  rmSync(path, { force: true });
  d.audit('installer_enrollment_done', { server });
  return 'enrolled';
}

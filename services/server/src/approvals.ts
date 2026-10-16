// CoreApprovalEngine (WSOS-WIPE-001): decides who may request and approve a sensitive admin action.
//
// A rule names the permission an administrator must hold to request or approve the action, how many distinct
// approvers it needs, and when policy may waive the second approver. The engine is pure (no I/O) so the console
// routes stay thin and the rules are tested on their own; wipe_requests keeps the state.
import { HttpError } from './http.ts';

export const WIPE_PERMISSION = 'desktop.devices.wipe';

export interface ApprovalContext {
  /** Device ownership recorded by an administrator ('corporate' unless set). */
  ownership?: string;
  /** Organization device policy. */
  policy: Record<string, unknown>;
}

export interface ApprovalRule {
  /** Permission needed both to request and to approve. */
  permission: string;
  /** Distinct approvers (other than the requester) needed before the action runs. */
  approvers: number;
  /** Policy waiver: true when this request may run without a second approver. */
  waiver?: (ctx: ApprovalContext) => boolean;
}

export const RULES: Record<string, ApprovalRule> = {
  RemoteWipe: {
    permission: WIPE_PERMISSION,
    approvers: 1,
    // SRS: policy MAY waive the second approver for Personal-owned devices.
    waiver: (c) => c.ownership === 'personal' && c.policy.wipe_personal_single_approval === true,
  },
};

export function rule(action: string): ApprovalRule {
  const r = RULES[action];
  if (!r) throw new Error(`no approval rule for ${action}`);
  return r;
}

/** Throws 403 unless the administrator holds the action's permission. */
export function requirePermission(action: string, permissions: readonly string[]) {
  const r = rule(action);
  if (!permissions.includes(r.permission)) throw new HttpError(403, 'PERMISSION_DENIED', `requires ${r.permission}`);
}

/** Approvals still needed right after the request is made (0 = run now). */
export function approvalsNeeded(action: string, ctx: ApprovalContext): number {
  const r = rule(action);
  return r.waiver?.(ctx) ? 0 : r.approvers;
}

/** Checks one approval: permission held, request still pending, approver is not the requester. */
export function checkApproval(action: string, req: { requested_by: number; decided: boolean }, approver: { id: number; permissions: readonly string[] }) {
  requirePermission(action, approver.permissions);
  if (req.decided) throw new HttpError(409, 'CONFLICT', 'already decided');
  if (req.requested_by === approver.id) throw new HttpError(403, 'PERMISSION_DENIED', 'a different administrator must approve a wipe');
}

// Conflict policy by data type (SRS §8.4) and Drive conflict naming (WSOS-DRV-004).

export type DataType =
  | 'preference'     // last write wins
  | 'document'       // revision check; keep conflict copy
  | 'message'        // unique IDs; deduplicate
  | 'authoritative'; // approvals, payroll, permissions, finance: server decides, offline = request only

export type ConflictAction =
  | { kind: 'force' }                // resend with force (LWW)
  | { kind: 'accept_server' }        // drop local mutation, server version is truth (dedupe / authoritative)
  | { kind: 'keep_both'; reason: 'revision_mismatch' | 'delete_vs_edit' };

export function resolveConflict(type: DataType, localOp: 'create' | 'update' | 'delete', serverDeleted: boolean): ConflictAction {
  // Delete vs edit is always explicit unless a module rule overrides it (not modelled here).
  if (type !== 'message' && (localOp === 'delete') !== serverDeleted && (localOp === 'delete' || serverDeleted)) {
    if (type === 'authoritative') return { kind: 'accept_server' };
    return { kind: 'keep_both', reason: 'delete_vs_edit' };
  }
  switch (type) {
    case 'preference': return { kind: 'force' };
    case 'message': return { kind: 'accept_server' };
    case 'authoritative': return { kind: 'accept_server' };
    case 'document': return { kind: 'keep_both', reason: 'revision_mismatch' };
  }
}

/** Optimistic local apply is allowed for everything except server-authoritative data. */
export const appliesLocally = (t: DataType) => t !== 'authoritative';

/**
 * "<name> (conflict <device> <date>)", extension preserved:
 *   conflictCopyName('Budget.xlsx', 'lap-01', d) -> 'Budget (conflict lap-01 2026-10-15).xlsx'
 */
export function conflictCopyName(fileName: string, device: string, date: Date): string {
  const dot = fileName.lastIndexOf('.');
  const hasExt = dot > 0 && dot < fileName.length - 1;
  const stem = hasExt ? fileName.slice(0, dot) : fileName;
  const ext = hasExt ? fileName.slice(dot) : '';
  const dev = device.replace(/[\/\\:\0]/g, '-').trim() || 'device';
  const day = date.toISOString().slice(0, 10);
  return `${stem} (conflict ${dev} ${day})${ext}`;
}

// WSOS-SEC-008: package changes are audited locally by the package service (JSON lines in its 0600 audit log) and
// forwarded by the device agent, which holds the device credential, to desktop/v1/os/audit.
import { createHash } from 'node:crypto';
import { closeSync, fstatSync, openSync, readSync } from 'node:fs';

/** Package-service events that record a privileged change or a refused one. Service lifecycle noise stays local. */
export const FORWARDED = new Set([
  'installed', 'removed', 'updated', 'installed_local_deb', 'flatpak_permissions_reset', 'flatpak_runtimes_pruned',
  'flatpak_remote_added', 'flatpak_remote_refused', 'bundle_installed', 'bundle_rejected', 'repaired',
  'dpkg_interrupted', 'sources_rejected', 'job_failed',
]);

export interface AuditEvent { id: string; type: string; at: string; data: Record<string, unknown> }
export interface AuditCursor { offset: number; head?: string }

const MAX_READ = 1024 * 1024;
const MAX_BATCH = 500;

/**
 * Reads complete lines after the cursor. A file that shrank or whose first line changed was rotated: start again
 * from 0. Event ids are derived from the line and its offset, so a resend after a lost reply is ignored by the server.
 */
export function readAuditLog(path: string, cursor: AuditCursor): { events: AuditEvent[]; next: AuditCursor } {
  let fd: number;
  try { fd = openSync(path, 'r'); } catch { return { events: [], next: cursor }; }
  try {
    const size = fstatSync(fd).size;
    const headBuf = Buffer.alloc(Math.min(size, 256));
    readSync(fd, headBuf, 0, headBuf.length, 0);
    const head = createHash('sha256').update(headBuf).digest('hex').slice(0, 16);
    let offset = cursor.offset;
    if (offset > size || (cursor.head && cursor.head !== head && headBuf.length >= 256)) offset = 0;
    const buf = Buffer.alloc(Math.min(size - offset, MAX_READ));
    const n = buf.length ? readSync(fd, buf, 0, buf.length, offset) : 0;
    const text = buf.subarray(0, n).toString('utf8');
    const events: AuditEvent[] = [];
    let pos = 0;
    while (events.length < MAX_BATCH) {
      const nl = text.indexOf('\n', pos);
      if (nl < 0) break;
      const line = text.slice(pos, nl);
      const at = offset + Buffer.byteLength(text.slice(0, pos));
      pos = nl + 1;
      const ev = parse(line, at);
      if (ev) events.push(ev);
    }
    return { events, next: { offset: offset + Buffer.byteLength(text.slice(0, pos)), head } };
  } finally { closeSync(fd); }
}

function parse(line: string, offset: number): AuditEvent | null {
  let o: unknown;
  try { o = JSON.parse(line); } catch { return null; }
  if (!o || typeof o !== 'object' || Array.isArray(o)) return null;
  const { ts, service, event, ...data } = o as Record<string, unknown>;
  if (service !== 'worksuite-package-service' || typeof event !== 'string' || !FORWARDED.has(event)) return null;
  if (typeof ts !== 'string' || Number.isNaN(Date.parse(ts))) return null;
  const trimmed = JSON.stringify(data).length > 4000 ? { truncated: true, ...(typeof data.caller === 'number' ? { caller: data.caller } : {}) } : data;
  return { id: createHash('sha256').update(`${offset}:${line}`).digest('hex').slice(0, 32), type: `package.${event}`, at: ts, data: trimmed };
}

/** One forwarding pass: send what is new, then move the cursor. On a send failure the cursor stays put. */
export async function forwardPackageAudit(o: { path: string; cursor: AuditCursor; send: (events: AuditEvent[]) => Promise<void>; save: (c: AuditCursor) => void }): Promise<number> {
  let cursor = o.cursor, sent = 0;
  for (let i = 0; i < 20; i++) {
    const { events, next } = readAuditLog(o.path, cursor);
    if (events.length) await o.send(events);
    if (next.offset === cursor.offset && next.head === cursor.head) break;
    cursor = next;
    o.save(cursor);
    sent += events.length;
  }
  return sent;
}

// Software Management (Admin Center › Device Management › Software Management): who gets which catalog app, the
// installation requests users send from the App Center, required-app deployment and remote removal. Every change on a
// device still travels as a signed command (InstallApprovedApplication / RemoveApplication) and an install is only run
// by the device when the id is in the signed policy allowlist, so approving or assigning an app adds it there.
import type { DatabaseSync } from 'node:sqlite';
import { randomUUID } from 'node:crypto';
import { issueCommand, setPolicy } from './admin.ts';
import { invalid } from './http.ts';

export interface Assignment { devices?: string[]; users?: string[]; departments?: string[] }
export interface CatalogItem { id: string; source: string; name: string; arches: string[]; required?: boolean; blocked?: boolean; assign?: Assignment }

const json = <T>(s: string | null | undefined): T => (s ? JSON.parse(s) : null) as T;
const DEPT = /^[\p{L}\p{N} ._&/-]{1,60}$/u;
/** Re-issue a failed or expired deployment at most this often per device and app. */
export const RETRY_MS = 6 * 3_600_000;

/** Validates an assignment from the console; empty lists are dropped, no lists at all = everyone. */
export function validateAssignment(v: unknown): Assignment | undefined {
  if (v === undefined || v === null) return undefined;
  if (typeof v !== 'object' || Array.isArray(v)) throw invalid('assign', 'must be an object');
  const a = v as Record<string, unknown>;
  const out: Assignment = {};
  const list = (k: keyof Assignment, ok: (x: string) => boolean) => {
    if (a[k] === undefined) return;
    if (!Array.isArray(a[k]) || (a[k] as unknown[]).length > 500 || !(a[k] as unknown[]).every((x) => typeof x === 'string' && ok(x))) throw invalid(`assign.${k}`);
    const xs = [...new Set((a[k] as string[]).map((x) => (k === 'users' ? x.trim().toLowerCase() : x.trim())))];
    if (xs.length) out[k] = xs;
  };
  list('devices', (x) => /^[0-9a-f-]{36}$/i.test(x));
  list('users', (x) => /^[^\s@]+@[^\s@]+$/.test(x.trim()));
  list('departments', (x) => DEPT.test(x.trim()));
  return Object.keys(out).length ? out : undefined;
}

export function validDepartment(v: unknown): string | null {
  if (v === null || v === '') return null;
  if (typeof v !== 'string' || !DEPT.test(v.trim())) throw invalid('department');
  return v.trim();
}

interface DeviceRow { id: string; org_id: number; arch: string; department: string | null }

/** Whether an item is assigned to a device: no assignment = every device; else the device itself, its department, or
 *  a directory user (or a user's department) who has signed in on it. */
export function assignedTo(db: DatabaseSync, item: CatalogItem, d: DeviceRow): boolean {
  const a = item.assign;
  if (!a) return true;
  if (a.devices?.includes(d.id)) return true;
  if (d.department && a.departments?.includes(d.department)) return true;
  if (!a.users?.length && !a.departments?.length) return false;
  const users = db.prepare('SELECT u.email, u.department FROM device_users du JOIN users u ON u.id = du.user_id WHERE du.device_id = ? AND u.org_id = ?')
    .all(d.id, d.org_id) as { email: string; department: string | null }[];
  return users.some((u) => a.users?.includes(u.email) || (!!u.department && !!a.departments?.includes(u.department)));
}

export function catalogItems(db: DatabaseSync): CatalogItem[] {
  return (db.prepare('SELECT item FROM catalog ORDER BY id').all() as { item: string }[]).map((r) => json<CatalogItem>(r.item));
}

/** Installed catalog ids from a device's last inventory (apt packages and Flatpak apps). */
export function installedIds(db: DatabaseSync, deviceId: string): Set<string> | null {
  const row = db.prepare('SELECT body FROM inventory WHERE device_id = ?').get(deviceId) as { body: string } | undefined;
  if (!row) return null;
  const b = json<{ packages?: { name?: string }[]; flatpaks?: { name?: string }[]; software?: { source?: string; name?: string }[] }>(row.body);
  const out = new Set<string>();
  for (const p of b.packages ?? []) if (p?.name) out.add(`apt:${p.name}`);
  for (const f of b.flatpaks ?? []) if (f?.name) out.add(`flatpak:${f.name}`);
  for (const s of b.software ?? []) if (s?.source && s.name) out.add(`${s.source}:${s.name}`);
  return out;
}

/** Adds catalog ids to the organization's signed allowlist (a new policy version) when they are missing. */
export function ensureAllowlisted(db: DatabaseSync, orgId: number, ids: string[]) {
  const row = db.prepare('SELECT body FROM policies WHERE org_id = ?').get(orgId) as { body: string } | undefined;
  const body = row ? json<Record<string, unknown>>(row.body) : { update_ring: 'stable', update_mode: 'automatic', usb_storage: 'allow', bluetooth: true };
  const allow = Array.isArray(body.app_allowlist) ? (body.app_allowlist as string[]) : [];
  const missing = ids.filter((i) => !allow.includes(i) && !i.startsWith('appimage:'));
  if (!missing.length) return false;
  setPolicy(db, orgId, { ...body, app_allowlist: [...allow, ...missing] });
  return true;
}

/** The newest command of this kind for this device and app, if any. */
function lastCommand(db: DatabaseSync, deviceId: string, command: string, catalogId: string) {
  return db.prepare(`SELECT id, state, expires, updated FROM commands WHERE device_id = ? AND json_extract(envelope, '$.command') = ?
    AND json_extract(envelope, '$.args.catalog_id') = ? ORDER BY rowid DESC LIMIT 1`).get(deviceId, command, catalogId) as { id: string; state: string; expires: number; updated: number } | undefined;
}

/** Issues a deployment unless one for the same app is still open on the device (or failed less than RETRY_MS ago). */
export function deploy(db: DatabaseSync, orgId: number, deviceId: string, command: 'InstallApprovedApplication' | 'RemoveApplication', catalogId: string, now = Date.now(), auto = false): string | null {
  const last = lastCommand(db, deviceId, command, catalogId);
  const open = !!last && ['pending', 'received', 'started'].includes(last.state) && last.expires > now;
  if (open) return null;
  // Automatic deployment backs off after a failure; an administrator's explicit deploy always goes out.
  if (auto && last && last.state !== 'completed' && now - last.updated < RETRY_MS) return null;
  if (command === 'InstallApprovedApplication') ensureAllowlisted(db, orgId, [catalogId]);
  return issueCommand(db, deviceId, command, { catalog_id: catalogId }, 72);
}

/**
 * Required apps: every active device the app is assigned to (and built for) that doesn't report it installed gets an
 * install command. Runs after catalog changes, inventory reports and sign-ins. Returns the commands issued.
 */
export function reconcileRequired(db: DatabaseSync, orgId: number, now = Date.now(), onlyDevice?: string): { device_id: string; catalog_id: string; command_id: string }[] {
  const required = catalogItems(db).filter((i) => i.required && !i.blocked && i.source !== 'appimage');
  if (!required.length) return [];
  const devices = db.prepare(`SELECT id, org_id, arch, department FROM devices WHERE org_id = ? AND revoked = 0 ${onlyDevice ? 'AND id = ?' : ''}`)
    .all(...(onlyDevice ? [orgId, onlyDevice] : [orgId])) as unknown as DeviceRow[];
  const out: { device_id: string; catalog_id: string; command_id: string }[] = [];
  for (const d of devices) {
    const inst = installedIds(db, d.id);
    for (const item of required) {
      if (!item.arches.includes(d.arch) || !assignedTo(db, item, d)) continue;
      if (inst?.has(item.id)) continue;
      const last = lastCommand(db, d.id, 'InstallApprovedApplication', item.id);
      // Inventory not yet refreshed after a completed install: don't install again.
      if (last?.state === 'completed' && (!inst || now - last.updated < RETRY_MS)) continue;
      const id = deploy(db, orgId, d.id, 'InstallApprovedApplication', item.id, now, true);
      if (id) out.push({ device_id: d.id, catalog_id: item.id, command_id: id });
    }
  }
  return out;
}

// ---- installation requests ----

export interface SoftwareRequest { id: string; device_id: string; catalog_id: string; username: string; reason: string | null; state: string; decided_at: number | null; note: string | null; command_id: string | null; at: number }

export function createRequest(db: DatabaseSync, d: DeviceRow, b: Record<string, unknown>, now = Date.now()): SoftwareRequest {
  const catalogId = typeof b.catalog_id === 'string' ? b.catalog_id : '';
  const row = db.prepare('SELECT item FROM catalog WHERE id = ?').get(catalogId) as { item: string } | undefined;
  if (!row) throw invalid('catalog_id', 'not in the catalog');
  const item = json<CatalogItem>(row.item);
  if (item.blocked) throw invalid('catalog_id', 'blocked by the organization');
  const username = typeof b.username === 'string' ? b.username.trim().slice(0, 320) : '';
  if (!username || /[\0\n]/.test(username)) throw invalid('username');
  const reason = typeof b.reason === 'string' && b.reason.trim() ? b.reason.trim().slice(0, 500) : null;
  const open = db.prepare("SELECT id FROM software_requests WHERE device_id = ? AND catalog_id = ? AND username = ? AND state = 'pending'").get(d.id, catalogId, username) as { id: string } | undefined;
  if (open) return getRequest(db, open.id)!;
  const id = randomUUID();
  db.prepare('INSERT INTO software_requests (id, org_id, device_id, catalog_id, username, reason, at) VALUES (?, ?, ?, ?, ?, ?, ?)').run(id, d.org_id, d.id, catalogId, username, reason, now);
  return getRequest(db, id)!;
}

export function getRequest(db: DatabaseSync, id: string): SoftwareRequest | undefined {
  return db.prepare('SELECT id, device_id, catalog_id, username, reason, state, decided_at, note, command_id, at FROM software_requests WHERE id = ?').get(id) as SoftwareRequest | undefined;
}

/** Approve: allowlist the app and send the install to the requesting device. Reject: record why. */
export function decideRequest(db: DatabaseSync, orgId: number, id: string, adminId: number, approve: boolean, note: string | null, now = Date.now()) {
  const r = db.prepare('SELECT id, device_id, catalog_id, state FROM software_requests WHERE id = ? AND org_id = ?').get(id, orgId) as { id: string; device_id: string; catalog_id: string; state: string } | undefined;
  if (!r) return null;
  if (r.state !== 'pending') throw invalid('state', `request already ${r.state}`);
  let commandId: string | null = null;
  if (approve) {
    const dev = db.prepare('SELECT revoked FROM devices WHERE id = ?').get(r.device_id) as { revoked: number } | undefined;
    if (dev && !dev.revoked) commandId = deploy(db, orgId, r.device_id, 'InstallApprovedApplication', r.catalog_id, now) ?? lastCommand(db, r.device_id, 'InstallApprovedApplication', r.catalog_id)?.id ?? null;
    else ensureAllowlisted(db, orgId, [r.catalog_id]);
  }
  db.prepare('UPDATE software_requests SET state = ?, decided_by = ?, decided_at = ?, note = ?, command_id = ? WHERE id = ?')
    .run(approve ? 'approved' : 'rejected', adminId, now, note, commandId, id);
  return getRequest(db, id)!;
}

/** Deployment history: every install/remove command for the organization's devices, newest first. */
export function deployments(db: DatabaseSync, orgId: number, limit = 200) {
  return (db.prepare(`SELECT c.id, c.device_id, d.hostname, c.envelope, c.state, c.reason, c.updated FROM commands c JOIN devices d ON d.id = c.device_id
    WHERE d.org_id = ? AND json_extract(c.envelope, '$.command') IN ('InstallApprovedApplication', 'RemoveApplication') ORDER BY c.rowid DESC LIMIT ?`)
    .all(orgId, limit) as { id: string; device_id: string; hostname: string; envelope: string; state: string; reason: string | null; updated: number }[])
    .map((c) => {
      const e = json<{ command: string; args: { catalog_id: string }; issued_at: string; expires_at: string }>(c.envelope);
      const expired = ['pending', 'received'].includes(c.state) && Date.parse(e.expires_at) < Date.now();
      return { id: c.id, device_id: c.device_id, hostname: c.hostname, action: e.command === 'RemoveApplication' ? 'uninstall' : 'install',
        catalog_id: e.args.catalog_id, issued_at: e.issued_at, state: expired ? 'expired' : c.state, reason: c.reason, updated: c.updated };
    });
}

/** Software inventory: for each catalog app, which devices report it installed; plus every device's app count. */
export function inventorySummary(db: DatabaseSync, orgId: number) {
  const devices = db.prepare('SELECT id, org_id, hostname, arch, department FROM devices WHERE org_id = ? AND revoked = 0 ORDER BY hostname').all(orgId) as unknown as (DeviceRow & { hostname: string })[];
  const items = catalogItems(db);
  const inst = new Map(devices.map((d) => [d.id, installedIds(db, d.id)]));
  return {
    apps: items.map((i) => {
      const targets = devices.filter((d) => i.arches.includes(d.arch) && assignedTo(db, i, d));
      return { id: i.id, name: i.name, required: !!i.required, blocked: !!i.blocked, assign: i.assign ?? null,
        assigned_devices: targets.length, installed_on: devices.filter((d) => inst.get(d.id)?.has(i.id)).map((d) => d.id),
        missing_on: i.required ? targets.filter((d) => inst.get(d.id) && !inst.get(d.id)!.has(i.id)).map((d) => d.id) : [] };
    }),
    devices: devices.map((d) => {
      const s = inst.get(d.id);
      return { id: d.id, hostname: d.hostname, department: d.department, reported: !!s, app_count: s?.size ?? 0,
        catalog_apps: s ? items.filter((i) => s.has(i.id)).map((i) => i.id) : [] };
    }),
  };
}

/** One device's installed software from its last inventory (for the device page). */
export function deviceSoftware(db: DatabaseSync, deviceId: string) {
  const row = db.prepare('SELECT body, at FROM inventory WHERE device_id = ?').get(deviceId) as { body: string; at: number } | undefined;
  if (!row) return { reported_at: null, items: [] };
  const b = json<{ packages?: { name: string; version?: string }[]; flatpaks?: { name: string; version?: string; origin?: string }[] }>(row.body);
  const catalog = new Map(catalogItems(db).map((i) => [i.id, i]));
  const items = [
    ...(b.flatpaks ?? []).map((f) => ({ id: `flatpak:${f.name}`, version: f.version ?? null })),
    ...(b.packages ?? []).map((p) => ({ id: `apt:${p.name}`, version: p.version ?? null })),
  ].map((x) => ({ ...x, catalog_name: catalog.get(x.id)?.name ?? null }));
  return { reported_at: row.at, items };
}

// App Center catalog (WSOS-APP-001, WSOS-APP-003, WSOS-ARM-005): the organization's approved Linux apps from the
// server's desktop/v1/os/catalog, fetched with the device credential, with policy and arch flags and installed state
// added on the device. No server (personal device, not enrolled, offline) = an explicit state, never sample data.
import type { DevicePolicy, Runner } from './service.ts';

export interface CatalogItem {
  id: string; source: 'apt' | 'flatpak' | 'appimage'; name: string; arches: string[];
  required?: boolean; blocked?: boolean; sha256?: string; category?: string; summary?: string; publisher?: string;
}
export interface CatalogEntry extends CatalogItem {
  installed: boolean;
  /** false when the app has no build for this device's arch ("Not available for ARM64"). */
  available: boolean;
  /** Why the user can't install it here; null when they can. */
  blocked_reason: string | null;
  /** Software Management: the user may ask an administrator to approve it (policy software_install = request). */
  requestable: boolean;
  /** This user's latest request for it from this device, if any. */
  request: { id: string; state: 'pending' | 'approved' | 'rejected'; note: string | null; at: number } | null;
}
export type CatalogResult =
  | { state: 'ok'; arch: string; items: CatalogEntry[]; fetched_at: number }
  | { state: 'not_enrolled' | 'unreachable' | 'error'; arch: string; items: []; error: string };

export interface CatalogEnv {
  /** Enrolled server host and device credential, or null on an unmanaged device. */
  server(): { host: string; token: string } | null;
  fetchJson(url: string, headers: Record<string, string>): Promise<unknown>;
  /** POST JSON with the device credential (installation requests). */
  postJson?(url: string, headers: Record<string, string>, body: unknown): Promise<unknown>;
  arch: 'amd64' | 'arm64';
  policy(): DevicePolicy | null;
  runner: Runner;
  now(): number;
}

const ARCH_LABEL: Record<string, string> = { amd64: 'x86-64', arm64: 'ARM64' };
const MAX_PAGES = 50;

function valid(x: unknown): x is CatalogItem {
  const i = x as CatalogItem;
  return !!i && typeof i.id === 'string' && /^(apt|flatpak|appimage):[A-Za-z0-9._+-]{1,200}$/.test(i.id) && i.id.startsWith(`${i.source}:`)
    && typeof i.name === 'string' && Array.isArray(i.arches);
}

async function fetchAll(env: CatalogEnv, host: string, token: string, arch: string): Promise<CatalogItem[]> {
  const out: CatalogItem[] = [];
  let cursor: string | null = '';
  for (let n = 0; cursor !== null && n < MAX_PAGES; n++) {
    const u = new URL('/desktop/v1/os/catalog', `https://${host}`);
    u.searchParams.set('arch', arch);
    u.searchParams.set('limit', '500');
    if (cursor) u.searchParams.set('cursor', cursor);
    const page = await env.fetchJson(u.toString(), { 'x-ws-device': token }) as { items?: unknown[]; next_cursor?: string | null };
    for (const i of page.items ?? []) if (valid(i)) out.push(i);
    cursor = page.next_cursor ?? null;
  }
  return out;
}

async function installedSets(runner: Runner) {
  const dpkg = await runner.run('dpkg-query', ['-W', '-f=${Package}\t${db:Status-Abbrev}\n']);
  const apt = new Set(dpkg.stdout.split('\n').filter((l) => /\tii/.test(l)).map((l) => l.split('\t')[0].split(':')[0]));
  const fp = await runner.run('flatpak', ['list', '--system', '--app', '--columns=application']);
  const flatpak = new Set(fp.code === 0 ? fp.stdout.split('\n').map((l) => l.trim()).filter(Boolean) : []);
  return { apt, flatpak };
}

type RequestRow = { id: string; catalog_id: string; username: string; state: 'pending' | 'approved' | 'rejected'; note: string | null; at: number };

/** This device's installation requests (pending, or decided in the last 30 days); [] when the server can't say. */
async function requests(env: CatalogEnv, host: string, token: string): Promise<RequestRow[]> {
  try {
    const r = await env.fetchJson(new URL('/desktop/v1/os/software-requests', `https://${host}`).toString(), { 'x-ws-device': token }) as { items?: RequestRow[] };
    return Array.isArray(r.items) ? r.items : [];
  } catch { return []; }
}

/**
 * Software Management: ask the organization to approve installing a catalog app. `user` is the caller's local account
 * name (from the bus credentials, never from arguments). Only on enrolled devices whose policy allows requests.
 */
export async function requestApp(env: CatalogEnv, user: string, catalogId: string, reason: string): Promise<RequestRow> {
  if (!/^(apt|flatpak):[A-Za-z0-9._+-]{1,200}$/.test(catalogId)) throw Object.assign(new Error('catalog id'), { code: 'InvalidArgs' });
  const srv = env.server();
  if (!srv || !env.postJson) throw Object.assign(new Error('this device is not managed by an organization'), { code: 'PreconditionFailed' });
  const mode = env.policy()?.software_install;
  if (mode !== 'request') throw Object.assign(new Error('your organization does not take installation requests'), { code: 'NotAuthorized' });
  const text = reason.replace(/[\u0000-\u001f]/g, ' ').trim().slice(0, 500);
  return await env.postJson(new URL('/desktop/v1/os/software-requests', `https://${srv.host}`).toString(), { 'x-ws-device': srv.token },
    { catalog_id: catalogId, username: user, ...(text ? { reason: text } : {}) }) as RequestRow;
}

export async function loadCatalog(env: CatalogEnv, user?: string): Promise<CatalogResult> {
  const arch = env.arch;
  const srv = env.server();
  if (!srv) return { state: 'not_enrolled', arch, items: [], error: 'This device is not enrolled with a WorkSuite server, so there is no approved app catalog.' };
  let mine: CatalogItem[], other: CatalogItem[];
  try {
    mine = await fetchAll(env, srv.host, srv.token, arch);
    // The server filters by arch; asking for the other arch shows apps that exist but not for this device.
    other = await fetchAll(env, srv.host, srv.token, arch === 'amd64' ? 'arm64' : 'amd64');
  } catch (e) {
    const msg = (e as Error).message ?? '';
    return /HTTP 4\d\d/.test(msg)
      ? { state: 'error', arch, items: [], error: `The server refused the catalog request (${msg}).` }
      : { state: 'unreachable', arch, items: [], error: 'Can’t reach your organization’s server. Check the network and try again.' };
  }
  const ids = new Set(mine.map((i) => i.id));
  const policy = env.policy();
  const allow = policy?.app_allowlist;
  const mode = policy?.software_install;
  const reqs = user ? (await requests(env, srv.host, srv.token)).filter((r) => r.username === user) : [];
  const inst = await installedSets(env.runner);
  const entry = (i: CatalogItem, available: boolean): CatalogEntry => {
    const name = i.id.slice(i.source.length + 1);
    const installed = i.source === 'apt' ? inst.apt.has(name) : i.source === 'flatpak' ? inst.flatpak.has(name) : false;
    let blocked_reason: string | null = null;
    let requestable = false;
    if (!available) blocked_reason = `Not available for ${ARCH_LABEL[arch]}`;
    else if (i.blocked) blocked_reason = 'Blocked by your organization';
    else if (i.source === 'appimage' && policy?.appimages === 'block') blocked_reason = 'Your organization does not allow AppImages';
    else if (mode === 'block' && i.source !== 'appimage') blocked_reason = 'Your organization installs apps for you';
    else if (mode !== 'any' && allow && allow.length && i.source !== 'appimage' && !allow.includes(i.id)) {
      blocked_reason = 'Not on your organization’s approved list';
      requestable = mode === 'request';
    }
    const latest = reqs.filter((r) => r.catalog_id === i.id).sort((a, b) => b.at - a.at)[0];
    const request = latest ? { id: latest.id, state: latest.state, note: latest.note ?? null, at: latest.at } : null;
    return { ...i, installed, available, blocked_reason, requestable, request };
  };
  const items = [...mine.map((i) => entry(i, true)), ...other.filter((i) => !ids.has(i.id)).map((i) => entry(i, false))]
    .sort((a, b) => a.name.localeCompare(b.name));
  return { state: 'ok', arch, items, fetched_at: env.now() };
}

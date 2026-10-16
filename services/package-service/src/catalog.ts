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
}
export type CatalogResult =
  | { state: 'ok'; arch: string; items: CatalogEntry[]; fetched_at: number }
  | { state: 'not_enrolled' | 'unreachable' | 'error'; arch: string; items: []; error: string };

export interface CatalogEnv {
  /** Enrolled server host and device credential, or null on an unmanaged device. */
  server(): { host: string; token: string } | null;
  fetchJson(url: string, headers: Record<string, string>): Promise<unknown>;
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

export async function loadCatalog(env: CatalogEnv): Promise<CatalogResult> {
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
  const inst = await installedSets(env.runner);
  const entry = (i: CatalogItem, available: boolean): CatalogEntry => {
    const name = i.id.slice(i.source.length + 1);
    const installed = i.source === 'apt' ? inst.apt.has(name) : i.source === 'flatpak' ? inst.flatpak.has(name) : false;
    let blocked_reason: string | null = null;
    if (!available) blocked_reason = `Not available for ${ARCH_LABEL[arch]}`;
    else if (i.blocked) blocked_reason = 'Blocked by your organization';
    else if (i.source === 'appimage' && policy?.appimages === 'block') blocked_reason = 'Your organization does not allow AppImages';
    else if (allow && allow.length && i.source !== 'appimage' && !allow.includes(i.id)) blocked_reason = 'Not on your organization’s approved list';
    return { ...i, installed, available, blocked_reason };
  };
  const items = [...mine.map((i) => entry(i, true)), ...other.filter((i) => !ids.has(i.id)).map((i) => entry(i, false))]
    .sort((a, b) => a.name.localeCompare(b.name));
  return { state: 'ok', arch, items, fetched_at: env.now() };
}

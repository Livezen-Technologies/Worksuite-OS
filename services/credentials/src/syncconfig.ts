// After sign-in, write the sync service's config (services/sync/src/main.ts SyncConfig) from desktop/v1/bootstrap,
// then (re)start the sync unit. On sign-out, remove it. The file holds no secrets: tokens come from this broker and
// the device credential from the device agent.
import { execFile } from 'node:child_process';
import { existsSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import type { Account } from './broker.ts';
import { checkUrl, OidcError, type OidcOptions } from './oidc.ts';

type DataType = 'preference' | 'document' | 'message' | 'authoritative';
const DATA_TYPES = new Set<DataType>(['preference', 'document', 'message', 'authoritative']);
const MODULE_KEY = /^[a-z][a-z0-9_-]{0,63}$/;

export interface SyncConfigFile {
  account: { id: string; server_url: string; org_id: string; user_id: string; mode: 'personal' | 'enterprise' };
  streams: string[];
  modules: Record<string, DataType>;
}

/**
 * Bootstrap fields used (desktop/v1/bootstrap): `user.id`, `org.id`, and `modules[]` with `key`, optional `offline`
 * (`online_only` modules are not synced, WSOS-SYN-009) and optional `data_type` (default `document`, SRS §8.4).
 */
export function buildSyncConfig(account: Account, apiBase: string, mode: 'personal' | 'enterprise', bootstrap: unknown): SyncConfigFile {
  const b = bootstrap as { user?: { id?: unknown }; org?: { id?: unknown }; modules?: unknown };
  const userId = b.user?.id, orgId = b.org?.id;
  if ((typeof userId !== 'string' && typeof userId !== 'number') || (typeof orgId !== 'string' && typeof orgId !== 'number')) throw new OidcError('bootstrap_invalid');
  const modules: Record<string, DataType> = {};
  for (const m of Array.isArray(b.modules) ? b.modules : []) {
    const key = (m as { key?: unknown }).key;
    if (typeof key !== 'string' || !MODULE_KEY.test(key)) continue;
    if ((m as { offline?: unknown }).offline === 'online_only') continue;
    const t = (m as { data_type?: unknown }).data_type;
    modules[key] = DATA_TYPES.has(t as DataType) ? (t as DataType) : 'document';
  }
  return {
    account: { id: account.id, server_url: apiBase, org_id: String(orgId), user_id: String(userId), mode },
    streams: Object.keys(modules),
    modules,
  };
}

export async function fetchBootstrap(apiBase: string, accessToken: string, deviceCredential: string | null, o: OidcOptions = {}) {
  const url = new URL('desktop/v1/bootstrap', checkUrl(apiBase, o));
  const res = await (o.fetch ?? fetch)(url, {
    headers: { authorization: `Bearer ${accessToken}`, ...(deviceCredential ? { 'x-ws-device': deviceCredential } : {}) },
    redirect: 'error', signal: AbortSignal.timeout(15_000),
  });
  if (res.status === 403) throw new OidcError('device_not_enrolled');
  if (res.status !== 200) throw new OidcError('bootstrap_failed');
  return res.json();
}

/** Atomic 0600 write. One connected account per session: a new sign-in replaces the previous config. */
export function writeSyncConfig(path: string, cfg: SyncConfigFile) {
  writeFileSync(path + '.tmp', JSON.stringify(cfg, null, 2), { mode: 0o600 });
  renameSync(path + '.tmp', path);
}

/** Remove the config only if it belongs to this account. Returns whether it was removed. */
export function removeSyncConfig(path: string, accountId: string): boolean {
  if (!existsSync(path)) return false;
  try {
    if ((JSON.parse(readFileSync(path, 'utf8')) as SyncConfigFile).account?.id !== accountId) return false;
  } catch { /* unreadable config: remove it */ }
  rmSync(path, { force: true });
  return true;
}

/** Fixed arguments, user manager only. */
export function systemctlUser(verb: 'restart' | 'stop', unit = 'worksuite-sync.service'): Promise<void> {
  return new Promise((resolve) => execFile('systemctl', ['--user', verb, unit], () => resolve()));
}

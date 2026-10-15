// WSOS-DRV-003: while a Drive document is open in WorkSuite Office the desktop holds the server file lock
// (POST/DELETE desktop/v1/files/{id}/lock). The shell asks for the lock by Drive-relative path when it opens the
// document and releases it when Office exits; the lock is refreshed before its server TTL (10 min) runs out.
import type { Db } from './db.ts';
import { NetworkError, type TokenProvider } from './transport.ts';

export type LockCall = (method: 'POST' | 'DELETE', fileId: string, token: string) => Promise<{ status: number; body: unknown }>;
export type LockResult = { ok: true; lock_id: string } | { ok: false; error: 'not_synced' | 'locked' | 'offline' | 'auth_required' | 'failed' };

export const REFRESH_MS = 4 * 60_000;

/** fetch-based LockCall for the account's server. */
export function fetchLockCall(baseUrl: string, deviceCredential: () => string | null, fetchImpl: typeof fetch = fetch): LockCall {
  return async (method, fileId, token) => {
    const device = deviceCredential();
    let res: Response;
    try {
      res = await fetchImpl(new URL(`desktop/v1/files/${encodeURIComponent(fileId)}/lock`, baseUrl), {
        method, headers: { authorization: `Bearer ${token}`, ...(device ? { 'x-ws-device': device } : {}), 'x-request-id': crypto.randomUUID() },
      });
    } catch (e) { throw new NetworkError(String(e)); }
    return { status: res.status, body: res.status === 204 ? null : await res.json().catch(() => null) };
  };
}

export class FileLocks {
  private held = new Map<string, { fileId: string; lockId: string; timer: NodeJS.Timeout }>();
  private o: { db: Db; call: LockCall; tokens: TokenProvider; refreshMs?: number };
  constructor(o: { db: Db; call: LockCall; tokens: TokenProvider; refreshMs?: number }) { this.o = o; }

  /** Drive file id for a path the sync engine knows (file_cache). */
  fileId(path: string): string | null {
    const r = this.o.db.prepare('SELECT file_id FROM file_cache WHERE path = ? LIMIT 1').get(path) as { file_id: string } | undefined;
    return r?.file_id ?? null;
  }

  private async post(fileId: string): Promise<LockResult> {
    try {
      let r = await this.o.call('POST', fileId, await this.o.tokens.current());
      if (r.status === 401) r = await this.o.call('POST', fileId, await this.o.tokens.refresh());
      if (r.status === 200) return { ok: true, lock_id: String((r.body as { lock_id?: unknown })?.lock_id ?? '') };
      if (r.status === 409) return { ok: false, error: 'locked' };
      if (r.status === 401) return { ok: false, error: 'auth_required' };
      return { ok: false, error: 'failed' };
    } catch (e) {
      return { ok: false, error: e instanceof NetworkError ? 'offline' : 'failed' };
    }
  }

  async lock(path: string): Promise<LockResult> {
    const have = this.held.get(path);
    if (have) return { ok: true, lock_id: have.lockId };
    const fileId = this.fileId(path);
    if (!fileId) return { ok: false, error: 'not_synced' };
    const r = await this.post(fileId);
    if (!r.ok) return r;
    const timer = setInterval(() => { void this.post(fileId); }, this.o.refreshMs ?? REFRESH_MS);
    timer.unref?.();
    this.held.set(path, { fileId, lockId: r.lock_id, timer });
    return r;
  }

  async unlock(path: string): Promise<boolean> {
    const h = this.held.get(path);
    if (!h) return false;
    clearInterval(h.timer);
    this.held.delete(path);
    try { await this.o.call('DELETE', h.fileId, await this.o.tokens.current()); } catch { /* the server lock expires on its own */ }
    return true;
  }

  async releaseAll() { for (const p of [...this.held.keys()]) await this.unlock(p); }
  heldPaths(): string[] { return [...this.held.keys()]; }
}

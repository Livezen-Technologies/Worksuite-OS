// In-memory server implementing the desktop/v1/sync contract: dedupe by (account, mutation_id), revision checks.
import { NetworkError, type Change, type MutationIn, type MutationResult, type SyncTransport, type TokenProvider } from '../src/transport.ts';

type Obj = { revision: number; deleted: boolean; data: unknown };

export class FakeServer {
  objects = new Map<string, Obj>();
  log: Change[] = [];
  seen = new Map<string, MutationResult>();
  effects = 0;                 // business effects actually applied
  validToken = 't1';
  oldestCursor = 0;            // cursors below this are expired
  dropResponseOnce = false;    // commit, then lose the response (crash/network after commit)
  failNext = 0;                // number of 503s to return

  private key = (m: string, id: string) => `${m}/${id}`;

  apply(m: MutationIn): MutationResult {
    const prev = this.seen.get(m.mutation_id);
    if (prev) return prev.status === 'applied' ? { ...prev, status: 'duplicate' } as MutationResult : prev;
    if (m.module === 'invalid') return { mutation_id: m.mutation_id, status: 'rejected', error: { code: 'VALIDATION', message: 'title required', field: 'title' } };
    const k = this.key(m.module, m.object_id);
    const cur = this.objects.get(k);
    const curRev = cur?.revision ?? null;
    let result: MutationResult;
    if (!m.force && curRev !== m.base_revision) {
      result = { mutation_id: m.mutation_id, status: 'conflict', revision: curRev ?? 0, server_version: cur?.data ?? null, server_deleted: cur?.deleted };
    } else {
      const revision = this.log.length + 1;
      const obj = { revision, deleted: m.operation === 'delete', data: m.payload };
      this.objects.set(k, obj);
      this.log.push({ module: m.module, object_id: m.object_id, ...obj });
      this.effects++;
      result = { mutation_id: m.mutation_id, status: 'applied', revision };
    }
    this.seen.set(m.mutation_id, result);
    return result;
  }

  transport(): SyncTransport {
    return {
      postMutations: async (req, token) => {
        if (token !== this.validToken) return { status: 401, body: { error: { code: 'TOKEN_EXPIRED', message: 'expired' } } };
        if (this.failNext > 0) { this.failNext--; return { status: 503, body: { error: { code: 'UNAVAILABLE', message: 'later' } } }; }
        const results = req.mutations.map((m) => this.apply(m));
        if (this.dropResponseOnce) { this.dropResponseOnce = false; throw new NetworkError('connection reset after commit'); }
        return { status: 200, body: { results } };
      },
      getChanges: async (req, token) => {
        if (token !== this.validToken) return { status: 401, body: { error: { code: 'TOKEN_EXPIRED', message: 'expired' } } };
        const from = req.cursor == null ? 0 : Number(req.cursor);
        if (req.cursor != null && from < this.oldestCursor) return { status: 410, body: { error: { code: 'CURSOR_EXPIRED', message: 'resync' } } };
        if (req.cursor == null) {
          // Full snapshot: current state of every object in the stream.
          const changes = [...this.objects.entries()].filter(([k]) => k.startsWith(req.stream + '/'))
            .map(([k, o]) => ({ module: req.stream, object_id: k.slice(req.stream.length + 1), ...o }));
          return { status: 200, body: { changes, next_cursor: String(this.log.length), has_more: false } };
        }
        const changes = this.log.slice(from, from + req.limit).filter((c) => c.module === req.stream);
        const next = Math.min(this.log.length, from + req.limit);
        return { status: 200, body: { changes, next_cursor: String(next), has_more: next < this.log.length } };
      },
    };
  }

  tokens(initial = this.validToken, refreshOk = () => true): TokenProvider & { refreshes: number } {
    let tok = initial;
    const p = {
      refreshes: 0,
      current: async () => tok,
      refresh: async () => { p.refreshes++; if (!refreshOk()) throw new Error('refresh failed'); tok = this.validToken; return tok; },
    };
    return p;
  }
}

// Injectable HTTP transport (desktop/v1/sync/*). Production wires fetch; tests use fakes.

export interface MutationIn {
  mutation_id: string;
  module: string;
  object_id: string;
  operation: 'create' | 'update' | 'delete';
  base_revision: number | null;
  payload: unknown;
  /** Last-write-wins types only: apply regardless of base_revision. */
  force?: boolean;
}

export type MutationResult =
  | { mutation_id: string; status: 'applied' | 'duplicate'; revision: number }
  | { mutation_id: string; status: 'conflict'; revision: number; server_version: unknown; server_deleted?: boolean }
  | { mutation_id: string; status: 'rejected'; error: { code: string; message: string; field?: string } };

export interface Change {
  module: string;
  object_id: string;
  revision: number;
  deleted: boolean;
  data: unknown;
}

export type TransportResponse<T> =
  | { status: 200; body: T }
  | { status: 401 | 403 | 409 | 410 | 413 | 422 | 429 | 500 | 502 | 503 | 504; body: { error: { code: string; message: string } } };

export interface SyncTransport {
  /** POST desktop/v1/sync/mutations — Idempotency-Key header = batch id; X-WS-Device sent whenever the device is enrolled. */
  postMutations(req: { batch_id: string; mutations: MutationIn[] }, accessToken: string): Promise<TransportResponse<{ results: MutationResult[] }>>;
  /** GET desktop/v1/sync/changes?stream=&cursor= ; 410 CURSOR_EXPIRED when the cursor is too old. */
  getChanges(req: { stream: string; cursor: string | null; limit: number }, accessToken: string): Promise<TransportResponse<{ changes: Change[]; next_cursor: string; has_more: boolean }>>;
}

export interface TokenProvider {
  /** In-memory access token (WSOS-IDN-003). */
  current(): Promise<string>;
  /** Refresh via the broker; throws if refresh fails (user must sign in again). */
  refresh(): Promise<string>;
}

/** Thrown by transports on network-level failure (no HTTP response). */
export class NetworkError extends Error {}

export function fetchTransport(baseUrl: string, deviceCredential: () => string | null, fetchImpl: typeof fetch = fetch): SyncTransport {
  const call = async (method: string, path: string, token: string, body?: unknown, idem?: string) => {
    let res: Response;
    const device = deviceCredential();
    try {
      res = await fetchImpl(new URL(path, baseUrl), {
        method,
        headers: {
          authorization: `Bearer ${token}`,
          ...(device ? { 'x-ws-device': device } : {}),
          'x-request-id': crypto.randomUUID(),
          ...(idem ? { 'idempotency-key': idem } : {}),
          ...(body ? { 'content-type': 'application/json' } : {}),
        },
        body: body ? JSON.stringify(body) : undefined,
      });
    } catch (e) {
      throw new NetworkError(String(e));
    }
    return { status: res.status, body: await res.json() } as TransportResponse<any>;
  };
  return {
    postMutations: (req, t) => call('POST', 'desktop/v1/sync/mutations', t, req, req.batch_id),
    getChanges: (req, t) => {
      const q = new URLSearchParams({ stream: req.stream, limit: String(req.limit) });
      if (req.cursor) q.set('cursor', req.cursor);
      return call('GET', `desktop/v1/sync/changes?${q}`, t);
    },
  };
}

// desktop/v1/devices/* and desktop/v1/policies, desktop/v1/os/* as used by the agent (api-contracts/openapi.yaml).
import { randomUUID } from 'node:crypto';
import type { CommandEnvelope } from './commands.ts';
import type { Policy } from './state.ts';

export class ApiError extends Error {
  readonly status: number; readonly code: string;
  constructor(status: number, code: string) { super(`${status} ${code}`); this.status = status; this.code = code; }
}

export interface Heartbeat {
  os_version: string; shell_version: string; kernel_version: string; policy_version: string;
  update_status?: string; observed?: Record<string, unknown>;
}

export interface DeviceApi {
  register(serverUrl: string, enrollmentToken: string, body: { public_key: string; tpm_backed: boolean; arch: string; hostname: string }): Promise<{ device_id: string; credential: string; org_name?: string }>;
  heartbeat(hb: Heartbeat): Promise<{ commands: unknown[] }>;
  policy(): Promise<Policy>;
  ack(commandId: string, state: string, reason?: string): Promise<void>;
  inventory(body: unknown): Promise<void>;
  diagnostics(body: unknown): Promise<void>;
}

export function httpApi(state: () => { server_url?: string; credential?: string }, fetchImpl: typeof fetch = fetch): DeviceApi {
  const call = async (method: string, path: string, opts: { body?: unknown; bearer?: string; base?: string; idem?: boolean } = {}) => {
    const s = state();
    const base = opts.base ?? s.server_url;
    if (!base) throw new ApiError(0, 'NOT_ENROLLED');
    const url = new URL(path, base);
    if (url.protocol !== 'https:') throw new ApiError(0, 'INSECURE_URL');
    let res: Response;
    try {
      res = await fetchImpl(url, {
        method, redirect: 'error', signal: AbortSignal.timeout(30_000),
        headers: {
          ...(opts.bearer ? { authorization: `Bearer ${opts.bearer}` } : {}),
          ...(s.credential && !opts.bearer ? { 'x-ws-device': s.credential } : {}),
          ...(opts.idem ? { 'idempotency-key': randomUUID() } : {}),
          'x-request-id': randomUUID(),
          ...(opts.body ? { 'content-type': 'application/json' } : {}),
        },
        body: opts.body ? JSON.stringify(opts.body) : undefined,
      });
    } catch (e) { throw new ApiError(0, 'NETWORK'); }
    const text = await res.text();
    const json = text ? JSON.parse(text) : {};
    if (res.status >= 400) throw new ApiError(res.status, json?.error?.code ?? `HTTP_${res.status}`);
    return json;
  };
  return {
    register: (serverUrl, token, body) => call('POST', 'desktop/v1/devices/register', { base: serverUrl, bearer: token, body, idem: true }),
    heartbeat: (hb) => call('POST', 'desktop/v1/devices/heartbeat', { body: hb }),
    policy: () => call('GET', 'desktop/v1/policies'),
    ack: async (id, st, reason) => { await call('POST', `desktop/v1/devices/commands/${encodeURIComponent(id)}/ack`, { body: { state: st, ...(reason ? { reason } : {}) }, idem: true }); },
    inventory: async (body) => { await call('POST', 'desktop/v1/os/inventory', { body, idem: true }); },
    diagnostics: async (body) => { await call('POST', 'desktop/v1/os/diagnostics', { body, idem: true }); },
  };
}

export type { CommandEnvelope };

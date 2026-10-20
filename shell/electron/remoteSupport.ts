// Remote support consent on the desktop (issue #19): the shell side of services/device-agent/src/remoteSupport.ts.
// The agent publishes the request in /run/worksuite-device-agent/remote-support.json (no secrets) and, for an
// attended request, a one-time nonce readable only by the seat user in consent/<uid>. The shell draws the consent
// dialog and the "remote support" indicator and answers over remote-support.sock. Without the agent nothing is shown.
import { readFile } from 'node:fs/promises'
import { createConnection } from 'node:net'
import { join } from 'node:path'

export const RS_DIR = '/run/worksuite-device-agent'
export type RsMode = 'view' | 'control'
export interface RsSession {
  session_id: string
  state: 'pending' | 'active' | 'ended'
  mode: RsMode
  reason: string
  admin_name: string
  org_name: string
  consent: 'user' | 'unattended_policy' | null
  granted_mode: RsMode | null
  requested_at: number
  started_at: number | null
  expires_at: number
}
type Reply<T> = { ok: true; value: T } | { ok: false; error: string }

/** The published file → a session, or null when it is absent or not the agent's shape. */
export function parseSession(text: string | null): RsSession | null {
  if (!text) return null
  let o: unknown
  try { o = JSON.parse(text) } catch { return null }
  if (!o || typeof o !== 'object') return null
  const s = o as Partial<RsSession>
  if (typeof s.session_id !== 'string' || (s.state !== 'pending' && s.state !== 'active') || (s.mode !== 'view' && s.mode !== 'control')) return null
  if (typeof s.admin_name !== 'string' || typeof s.reason !== 'string') return null
  return {
    session_id: s.session_id, state: s.state, mode: s.mode, reason: s.reason, admin_name: s.admin_name, org_name: typeof s.org_name === 'string' ? s.org_name : '',
    consent: s.consent === 'user' || s.consent === 'unattended_policy' ? s.consent : null,
    granted_mode: s.granted_mode === 'view' || s.granted_mode === 'control' ? s.granted_mode : null,
    requested_at: Number(s.requested_at) || 0, started_at: s.started_at == null ? null : Number(s.started_at), expires_at: Number(s.expires_at) || 0,
  }
}

export interface RsDeps {
  read(path: string): Promise<string | null>
  /** One JSON line to the socket, one JSON reply back. */
  call(path: string, line: string): Promise<string>
  uid: number
}

export const realDeps = (): RsDeps => ({
  read: (p) => readFile(p, 'utf8').catch(() => null),
  call: (p, line) => new Promise((resolve, reject) => {
    const s = createConnection(p)
    let buf = ''
    s.setEncoding('utf8')
    s.setTimeout(10_000, () => { s.destroy(); reject(new Error('timeout')) })
    s.on('connect', () => s.write(line + '\n'))
    s.on('data', (c) => { buf += c })
    s.on('end', () => resolve(buf))
    s.on('error', reject)
  }),
  uid: process.getuid?.() ?? -1,
})

export function remoteSupportBridge(d: RsDeps = realDeps(), dir = RS_DIR) {
  const send = async (method: string, params?: Record<string, unknown>): Promise<Reply<RsSession | null>> => {
    let text: string
    try { text = await d.call(join(dir, 'remote-support.sock'), JSON.stringify({ method, ...(params ? { params } : {}) })) } catch { return { ok: false, error: 'service_unavailable' } }
    let r: { result?: unknown; error?: string }
    try { r = JSON.parse(text) } catch { return { ok: false, error: 'bad_reply' } }
    return r.error ? { ok: false, error: r.error } : { ok: true, value: parseSession(r.result ? JSON.stringify(r.result) : null) }
  }
  return {
    async state(): Promise<RsSession | null> { return parseSession(await d.read(join(dir, 'remote-support.json'))) },
    /** decision: deny | view | control. The nonce is read here, in the main process, never handed to the page. */
    async decide(decision: string): Promise<Reply<RsSession | null>> {
      if (decision !== 'deny' && decision !== 'view' && decision !== 'control') return { ok: false, error: 'invalid_argument' }
      if (d.uid < 0) return { ok: false, error: 'service_unavailable' }
      const nonce = (await d.read(join(dir, 'consent', String(d.uid))))?.trim()
      if (!nonce) return { ok: false, error: 'NO_PENDING_REQUEST' }
      return send('Decide', { nonce, decision })
    },
    revokeControl: () => send('RevokeControl'),
    end: () => send('End'),
  }
}

type Handle = (channel: string, fn: (...args: string[]) => unknown) => void
export function startRemoteSupportHost(handle: Handle, b = remoteSupportBridge()) {
  handle('ws:remoteSupportState', () => b.state())
  handle('ws:remoteSupportDecide', (decision) => b.decide(decision))
  handle('ws:remoteSupportRevokeControl', () => b.revokeControl())
  handle('ws:remoteSupportEnd', () => b.end())
}

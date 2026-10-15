// Client for the credentials broker socket ($XDG_RUNTIME_DIR/worksuite/credentials.sock).
// The shell only signs in, signs out, lists accounts and forwards lock state; tokens never reach the renderer.
import { spawn } from 'node:child_process'
import { createConnection } from 'node:net'
import path from 'node:path'

export type BrokerReply = { ok: true; value: unknown } | { ok: false; error: string }

const socketPath = (name: string) => path.join(process.env.XDG_RUNTIME_DIR || `/run/user/${process.getuid?.() ?? 0}`, 'worksuite', name)

export function brokerCall(method: string, params: Record<string, unknown> = {}, timeoutMs = 15_000): Promise<BrokerReply> {
  return serviceCall('credentials.sock', method, params, timeoutMs)
}

/** The sync service's control socket (Unsent, ExportUnsent, Forget, SyncNow, Status). */
export function syncCall(method: string, params: Record<string, unknown> = {}): Promise<BrokerReply> {
  return serviceCall('sync.sock', method, params, 15_000)
}

function serviceCall(name: string, method: string, params: Record<string, unknown>, timeoutMs: number): Promise<BrokerReply> {
  return new Promise((resolve) => {
    const sock = createConnection(socketPath(name))
    let buf = ''
    let settled = false
    const finish = (r: BrokerReply) => { if (!settled) { settled = true; sock.destroy(); resolve(r) } }
    sock.setEncoding('utf8')
    sock.setTimeout(timeoutMs, () => finish({ ok: false, error: 'broker_timeout' }))
    sock.on('connect', () => sock.write(JSON.stringify({ method, params }) + '\n'))
    sock.on('data', (c) => {
      buf += c
      const nl = buf.indexOf('\n')
      if (nl < 0) return
      try {
        const res = JSON.parse(buf.slice(0, nl))
        finish('error' in res ? { ok: false, error: String(res.error) } : { ok: true, value: res.result })
      } catch { finish({ ok: false, error: 'bad_reply' }) }
    })
    sock.on('error', () => finish({ ok: false, error: 'broker_unavailable' }))
  })
}

/** Accounts as the renderer may see them: no tokens, no subject beyond the opaque id. */
export function publicAccounts(v: unknown) {
  return Array.isArray(v)
    ? v.map((a) => ({ id: String(a.id), name: a.name == null ? null : String(a.name), server_url: String(a.server_url), state: String(a.state ?? '') }))
    : []
}

/**
 * Follow logind Lock/Unlock for this session (the real lock is the ext-session-lock locker, WSOS-LOCK-001)
 * and tell the broker, which drops cached tokens while locked (WSOS-INT-009). Fixed arguments, no shell.
 */
export function followSessionLock(onChange: (locked: boolean) => void) {
  const session = process.env.XDG_SESSION_ID
  if (!session) return
  const child = spawn('gdbus', ['monitor', '--system', '--dest', 'org.freedesktop.login1', '--object-path', `/org/freedesktop/login1/session/${session.replace(/[^A-Za-z0-9_]/g, '_')}`], { stdio: ['ignore', 'pipe', 'ignore'] })
  let buf = ''
  child.stdout.setEncoding('utf8')
  child.stdout.on('data', (c: string) => {
    buf += c
    let nl: number
    while ((nl = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, nl); buf = buf.slice(nl + 1)
      if (/org\.freedesktop\.login1\.Session\.Lock \(\)/.test(line)) onChange(true)
      else if (/org\.freedesktop\.login1\.Session\.Unlock \(\)/.test(line)) onChange(false)
    }
  })
  child.on('error', () => {})
}

// Setup wizard → lk.worksuite.Setup1 on the system bus (services/setup). busctl with fixed arguments; polkit asks for
// an administrator through the session's agent for the calls that change setup. The service validates everything
// again; this side only refuses obviously malformed input before it leaves the process.
import { execFile } from 'node:child_process'

export const NAME = 'lk.worksuite.Setup1'
export const PATH = '/lk/worksuite/Setup1'
type Reply<T> = { ok: true; value: T } | { ok: false; error: string }
export type Exec = (cmd: string, args: string[]) => Promise<{ code: number; stdout: string; stderr: string }>

const realExec: Exec = (cmd, args) => new Promise((resolve) => {
  execFile(cmd, args, { timeout: 5 * 60_000, maxBuffer: 8 << 20 }, (err, stdout, stderr) => resolve({ code: err ? 1 : 0, stdout, stderr }))
})

function failure(stderr: string): string {
  const m = /Call failed: (.*)/.exec(stderr)
  if (!m) return /not found|was not provided|ServiceUnknown|could not activate/i.test(stderr) ? 'service_unavailable' : 'failed'
  const text = m[1].trim()
  if (/not authorized|NotAuthorized|Interactive authentication required|dismissed/i.test(text)) return 'not_authorized'
  return text
}

async function call(exec: Exec, member: string, signature: string, args: string[]): Promise<Reply<unknown[]>> {
  const r = await exec('busctl', ['--system', '--json=short', '--allow-interactive-authorization=yes', '--timeout=300', 'call', NAME, PATH, NAME, member, ...(signature ? [signature, ...args] : [])])
  if (r.code !== 0) return { ok: false, error: failure(r.stderr) }
  try { return { ok: true, value: (JSON.parse(r.stdout) as { data: unknown[] }).data } } catch { return { ok: false, error: 'failed' } }
}
const jsonOf = (r: Reply<unknown[]>): Reply<unknown> => {
  if (!r.ok) return r
  try { return { ok: true, value: JSON.parse(String(r.value[0])) } } catch { return { ok: false, error: 'failed' } }
}

const EVENT = /^[A-Z_]{2,32}$/
const KEY = /^[A-Za-z]{1,40}$/

export function setupClient(exec: Exec = realExec) {
  return {
    async state(): Promise<Reply<unknown>> { return jsonOf(await call(exec, 'GetState', '', [])) },
    async recovery(): Promise<Reply<unknown>> { return jsonOf(await call(exec, 'GetRecoveryOptions', '', [])) },
    async apps(): Promise<Reply<unknown>> { return jsonOf(await call(exec, 'GetApps', '', [])) },
    async log(lines: number): Promise<Reply<string>> {
      const n = Number.isInteger(lines) && lines > 0 && lines <= 5000 ? lines : 200
      const r = await call(exec, 'GetLog', 'u', [String(n)])
      return r.ok ? { ok: true, value: String(r.value[0] ?? '') } : r
    },
    async send(event: unknown): Promise<Reply<unknown>> {
      const e = event as { type?: unknown }
      if (!e || typeof e !== 'object' || typeof e.type !== 'string' || !EVENT.test(e.type)) return { ok: false, error: 'invalid_argument' }
      const body = JSON.stringify(event)
      if (body.length > 64 * 1024) return { ok: false, error: 'invalid_argument' }
      return jsonOf(await call(exec, 'Send', 's', [body]))
    },
    async answer(key: unknown, value: unknown): Promise<Reply<true>> {
      if (typeof key !== 'string' || !KEY.test(key)) return { ok: false, error: 'invalid_argument' }
      const body = JSON.stringify(value ?? null)
      if (body.length > 64 * 1024) return { ok: false, error: 'invalid_argument' }
      const r = await call(exec, 'SetAnswer', 'ss', [key, body])
      return r.ok ? { ok: true, value: true } : r
    },
  }
}

const parse = (raw: string): unknown => { try { return JSON.parse(raw) } catch { return undefined } }

/** Registers the ws:setup* channels. The renderer sends JSON strings (preload), parsed here and checked again. */
export function registerSetup(handle: (channel: string, fn: (...a: string[]) => unknown) => void, client = setupClient()) {
  handle('ws:setupState', () => client.state())
  handle('ws:setupRecovery', () => client.recovery())
  handle('ws:setupApps', () => client.apps())
  handle('ws:setupLog', (lines) => client.log(Number(lines)))
  handle('ws:setupSend', (event) => client.send(parse(String(event))))
  handle('ws:setupAnswer', (key, value) => client.answer(String(key), parse(String(value))))
}

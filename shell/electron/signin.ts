// Settings › Users › Sign-in options (boards AuthMethods, AuthPin, AuthPasskey): this device's PIN and FIDO2 security
// keys, managed by the root helper worksuite-signin (services/session/signin).
// - What is set up comes from the public index /var/lib/worksuite/signin/methods.json (no secrets) and the policy files.
// - Changes run the helper through pkexec (polkit lk.worksuite.signin.manage, auth_self: the person types their own
//   password each time). Fixed arguments; the PIN goes on stdin only, never argv, never logged.
// - The default method is a preference: one request on the helper's socket, answered for the caller's own account.
import { spawn } from 'node:child_process'
import { readFileSync } from 'node:fs'
import net from 'node:net'
import os from 'node:os'

export const HELPER = '/usr/lib/worksuite/worksuite-signin'
export type SignInMethod = 'password' | 'pin' | 'key'
export interface SecurityKey { id: string; name: string; added: number | null }
export interface SignInMethods {
  pin: boolean; keys: SecurityKey[]; default: SignInMethod
  allow_pin: boolean; pin_min_length: number; pin_max_length: number; attempt_limit: number
}
export type SigninResult = { ok: true; id?: string } | { ok: false; error: string }
type Avail<T> = { available: true; value: T } | { available: false; reason: string }

export interface SigninPaths { methods: string; policy: string; faillock: string; socket: string }
export const PATHS: SigninPaths = {
  methods: '/var/lib/worksuite/signin/methods.json',
  policy: '/etc/worksuite/signin-policy.conf',
  faillock: '/etc/worksuite/faillock.conf',
  socket: '/run/worksuite-signin.sock',
}

function conf(p: string): Record<string, string> {
  const out: Record<string, string> = {}
  let text = ''
  try { text = readFileSync(p, 'utf8') } catch { return out }
  for (const raw of text.split('\n')) {
    const line = raw.split('#')[0].trim()
    const i = line.indexOf('=')
    if (i > 0) out[line.slice(0, i).trim().toLowerCase()] = line.slice(i + 1).trim()
  }
  return out
}

/** Same rules as worksuite_signin.core.policy(): the helper enforces them, this only shows them. */
export function signinPolicy(paths: SigninPaths = PATHS) {
  const c = conf(paths.policy)
  const min = Math.max(4, Math.min(12, Number.parseInt(c.pin_min_length ?? '6', 10) || 6))
  const deny = Number.parseInt(conf(paths.faillock).deny ?? '5', 10)
  const limit = !Number.isFinite(deny) ? 3 : deny <= 0 ? 5 : Math.max(1, Math.min(5, deny - 2))
  return { allow_pin: !['0', 'false', 'no'].includes(c.allow_pin ?? '1'), pin_min_length: min, pin_max_length: 12, attempt_limit: limit }
}

export function signinMethods(user = os.userInfo().username, paths: SigninPaths = PATHS): Avail<SignInMethods> {
  let idx: { users?: Record<string, { pin?: unknown; keys?: unknown; default?: unknown }> } = {}
  try { idx = JSON.parse(readFileSync(paths.methods, 'utf8')) } catch { /* nobody has set anything up yet */ }
  const u = idx.users?.[user] ?? {}
  const keys: SecurityKey[] = Array.isArray(u.keys)
    ? u.keys.filter((k): k is { id: string; name?: unknown; added?: unknown } => !!k && typeof k.id === 'string')
      .map((k) => ({ id: k.id, name: typeof k.name === 'string' ? k.name : '', added: typeof k.added === 'number' ? k.added : null }))
    : []
  const pin = u.pin === true
  const d = u.default === 'pin' && pin ? 'pin' : u.default === 'key' && keys.length ? 'key' : 'password'
  return { available: true, value: { pin, keys, default: d, ...signinPolicy(paths) } }
}

export type Runner = (args: string[], stdin: string) => Promise<{ status: number | null; out: string }>

const pkexec: Runner = (args, stdin) => new Promise((resolve) => {
  const child = spawn('pkexec', ['/usr/lib/worksuite/worksuite-signin', ...args], { stdio: ['pipe', 'pipe', 'ignore'] })
  let out = ''
  child.stdout.on('data', (d) => { out += d })
  child.on('error', () => resolve({ status: -1, out: '' }))
  child.on('close', (status) => resolve({ status, out }))
  child.stdin.end(stdin)
})

async function manage(args: string[], stdin = '', run: Runner = pkexec): Promise<SigninResult> {
  const r = await run(args, stdin)
  // pkexec: 126 = authentication dismissed or failed, 127 = not authorized.
  if (r.status === 126 || r.status === 127) return { ok: false, error: 'auth_cancelled' }
  if (r.status === -1) return { ok: false, error: 'unavailable' }
  try {
    const j = JSON.parse(r.out.trim().split('\n').pop() ?? '') as { ok?: boolean; error?: unknown; id?: unknown }
    if (j.ok === true) return typeof j.id === 'string' ? { ok: true, id: j.id } : { ok: true }
    return { ok: false, error: typeof j.error === 'string' && /^[a-z_]{1,32}$/.test(j.error) ? j.error : 'failed' }
  } catch { return { ok: false, error: 'failed' } }
}

export function signinHost(run: Runner = pkexec, paths: SigninPaths = PATHS) {
  return {
    methods: () => signinMethods(undefined, paths),
    pinSet: (pin: string) => {
      // Checked again by the helper; this keeps anything that isn't a PIN off stdin.
      if (!/^[0-9]{4,12}$/.test(pin)) return Promise.resolve<SigninResult>({ ok: false, error: 'digits_only' })
      return manage(['pin-set'], pin + '\n', run)
    },
    pinRemove: () => manage(['pin-remove'], '', run),
    keyAdd: (name: string) => manage(['key-add', '--name', name.replace(/\s+/g, ' ').trim().slice(0, 60) || 'Security key'], '', run),
    keyRemove: (id: string) => /^[0-9a-f]{16}$/.test(id) ? manage(['key-remove', '--id', id], '', run) : Promise.resolve<SigninResult>({ ok: false, error: 'bad_request' }),
    setDefault: (method: SignInMethod, user = os.userInfo().username) => ask({ op: 'set_default', user, method }, paths.socket),
  }
}

export function ask(req: Record<string, unknown>, socketPath = PATHS.socket): Promise<SigninResult> {
  return new Promise((resolve) => {
    const s = net.createConnection(socketPath)
    let buf = ''
    const done = (r: SigninResult) => { s.destroy(); resolve(r) }
    s.setTimeout(5000, () => done({ ok: false, error: 'unavailable' }))
    s.on('connect', () => s.write(JSON.stringify(req) + '\n'))
    s.on('data', (d) => {
      buf += d
      if (!buf.includes('\n')) return
      try {
        const j = JSON.parse(buf.split('\n')[0]) as { ok?: boolean; error?: string }
        done(j.ok === true ? { ok: true } : { ok: false, error: typeof j.error === 'string' ? j.error : 'failed' })
      } catch { done({ ok: false, error: 'failed' }) }
    })
    s.on('error', () => done({ ok: false, error: 'unavailable' }))
  })
}

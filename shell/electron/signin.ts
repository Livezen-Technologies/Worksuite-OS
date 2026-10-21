// Settings › Users › Sign-in options (boards AuthMethods, AuthPin, AuthPasskey): this device's PIN and FIDO2 security
// keys, managed by the root helper worksuite-signin (services/session/signin).
// - What is set up comes from the public index /var/lib/worksuite/signin/methods.json (no secrets) and the policy files.
// - Changes are named methods of lk.worksuite.SignIn1 on the system bus (WSOS-ARC-002), each behind polkit
//   lk.worksuite.signin.manage (auth_self: the person types their own password each time); the service acts on the
//   bus caller's account only. The PIN is a D-Bus argument, never argv, never logged.
// - The default method is a preference: one request on the helper's socket, answered for the caller's own account.
import dbus from 'dbus-next'
import { readdirSync, readFileSync } from 'node:fs'
import net from 'node:net'
import os from 'node:os'

export const HELPER = '/usr/lib/worksuite/worksuite-signin'
export type SignInMethod = 'password' | 'pin' | 'key'
export interface SecurityKey { id: string; name: string; added: number | null }
export interface SignInMethods {
  pin: boolean; keys: SecurityKey[]; default: SignInMethod
  allow_pin: boolean; pin_min_length: number; pin_max_length: number; attempt_limit: number
  /** A FIDO security key is plugged in (null: this computer has no hidraw devices to look at). */
  key_present: boolean | null
}
export type SigninResult = { ok: true; id?: string } | { ok: false; error: string }
type Avail<T> = { available: true; value: T } | { available: false; reason: string }

export interface SigninPaths { methods: string; policy: string; faillock: string; socket: string; sys?: string }
export const PATHS: SigninPaths = {
  methods: '/var/lib/worksuite/signin/methods.json',
  policy: '/etc/worksuite/signin-policy.conf',
  faillock: '/etc/worksuite/faillock.conf',
  socket: '/run/worksuite-signin.sock',
  sys: '/sys',
}

/** HID Usage Page 0xF1D0 (FIDO Alliance) in a report descriptor: same test as worksuite_signin.core.fido_devices(). */
const FIDO_PAGE = Buffer.from([0x06, 0xd0, 0xf1])
/** #57: is a security key plugged in? Report descriptors in sysfs are world-readable, so no privilege is needed. */
export function fidoKeyPresent(sys = '/sys'): boolean | null {
  let names: string[]
  try { names = readdirSync(`${sys}/class/hidraw`) } catch { return null }
  return names.some((n) => { try { return readFileSync(`${sys}/class/hidraw/${n}/device/report_descriptor`).includes(FIDO_PAGE) } catch { return false } })
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
  // #56: exactly `min` digits unless the policy allows longer PINs (pin_max_length), so the field stops at the length.
  const max = Math.max(min, Math.min(12, Number.parseInt(c.pin_max_length ?? String(min), 10) || min))
  const deny = Number.parseInt(conf(paths.faillock).deny ?? '5', 10)
  const limit = !Number.isFinite(deny) ? 3 : deny <= 0 ? 5 : Math.max(1, Math.min(5, deny - 2))
  return { allow_pin: !['0', 'false', 'no'].includes(c.allow_pin ?? '1'), pin_min_length: min, pin_max_length: max, attempt_limit: limit }
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
  return { available: true, value: { pin, keys, default: d, ...signinPolicy(paths), key_present: fidoKeyPresent(paths.sys ?? '/sys') } }
}

export type Runner = (args: string[], stdin: string) => Promise<{ status: number | null; out: string }>

/** The helper command (as before) → its lk.worksuite.SignIn1 method. Unknown commands never reach the bus. */
export function busCall(args: string[], stdin: string): { member: 'SetPin' | 'RemovePin' | 'AddKey' | 'RemoveKey'; body: string[] } | null {
  const opt = (k: string) => { const i = args.indexOf(k); return i >= 0 && i + 1 < args.length ? args[i + 1] : '' }
  switch (args[0]) {
    case 'pin-set': return { member: 'SetPin', body: [stdin.replace(/\n$/, '')] }
    case 'pin-remove': return { member: 'RemovePin', body: [] }
    case 'key-add': return { member: 'AddKey', body: [opt('--name')] }
    case 'key-remove': return { member: 'RemoveKey', body: [opt('--id')] }
    default: return null
  }
}

/** The method call itself. Sent directly rather than through an introspected proxy (#56/#57: the service's empty
 *  introspection made getInterface() throw, so nothing was ever saved); the signature is fixed by busCall(). */
export function busMessage(c: NonNullable<ReturnType<typeof busCall>>) {
  return new dbus.Message({
    destination: 'lk.worksuite.SignIn1', path: '/lk/worksuite/SignIn1', interface: 'lk.worksuite.SignIn1',
    member: c.member, signature: c.body.length ? 's' : '', body: c.body,
  })
}

/** Status like the old pkexec runner: 0 with the JSON result, 126 when polkit refused, -1 when the service is missing. */
const busRunner: Runner = async (args, stdin) => {
  const c = busCall(args, stdin)
  if (!c) return { status: 1, out: '{"ok":false,"error":"bad_request"}' }
  const bus = dbus.systemBus()
  try {
    const reply = await bus.call(busMessage(c))
    return { status: 0, out: String(reply?.body?.[0] ?? '') }
  } catch (e) {
    const type = (e as { type?: string }).type ?? ''
    return type === 'lk.worksuite.Error.NotAuthorized' ? { status: 126, out: '' } : /ServiceUnknown|NameHasNoOwner|Spawn|NoReply|Disconnected/.test(type) || !type ? { status: -1, out: '' } : { status: 1, out: '' }
  } finally { bus.disconnect() }
}

async function manage(args: string[], stdin = '', run: Runner = busRunner): Promise<SigninResult> {
  const r = await run(args, stdin)
  // 126 = authentication dismissed or failed (polkit), 127 = not authorized.
  if (r.status === 126 || r.status === 127) return { ok: false, error: 'auth_cancelled' }
  if (r.status === -1) return { ok: false, error: 'unavailable' }
  try {
    const j = JSON.parse(r.out.trim().split('\n').pop() ?? '') as { ok?: boolean; error?: unknown; id?: unknown }
    if (j.ok === true) return typeof j.id === 'string' ? { ok: true, id: j.id } : { ok: true }
    return { ok: false, error: typeof j.error === 'string' && /^[a-z_]{1,32}$/.test(j.error) ? j.error : 'failed' }
  } catch { return { ok: false, error: 'failed' } }
}

export function signinHost(run: Runner = busRunner, paths: SigninPaths = PATHS) {
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
        const j = JSON.parse(buf.split('\n')[0]) as { ok?: boolean; error?: string; result?: string }
        // A PIN check answers {ok, result: ok|wrong|locked|no_pin|disabled|not_pin}; other requests {ok, error}.
        const why = typeof j.error === 'string' ? j.error : typeof j.result === 'string' ? j.result : 'failed'
        done(j.ok === true ? { ok: true } : { ok: false, error: why })
      } catch { done({ ok: false, error: 'failed' }) }
    })
    s.on('error', () => done({ ok: false, error: 'unavailable' }))
  })
}

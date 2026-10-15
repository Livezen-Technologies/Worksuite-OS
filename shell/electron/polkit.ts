// Shell-rendered polkit authentication agent (WSOS-INT-010). `worksuite-shell --polkit-agent` (started by
// worksuite-polkit-agent.service) registers with polkitd for the user's graphical session. Each request opens a
// small always-on-top shell window naming the requesting program, the action and the administrator account; the
// password goes from that window to polkit-agent-helper-1 on its stdin (never argv, never logged), and PAM decides
// (pam_faillock counts failures, WSOS-AUTH-004). The helper reports success to polkitd itself.
import { spawn } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { connect } from 'node:net'
import path from 'node:path'
import dbus from 'dbus-next'

const { Message, Variant } = dbus
type Bus = InstanceType<typeof dbus.MessageBus>
type Msg = InstanceType<typeof Message>
// dbus-next's typings declare the first argument as a string; at runtime it is the call being answered.
const newError = (m: Msg, name: string, text: string) => (Message.newError as unknown as (m: Msg, n: string, t: string) => Msg)(m, name, text)

export const AGENT_PATH = '/lk/worksuite/PolkitAgent'
const AUTHORITY = { destination: 'org.freedesktop.PolicyKit1', path: '/org/freedesktop/PolicyKit1/Authority', interface: 'org.freedesktop.PolicyKit1.Authority' }
const AGENT_IFACE = 'org.freedesktop.PolicyKit1.AuthenticationAgent'
export const HELPER_SOCKET = '/run/polkit/agent-helper.socket'
export const HELPERS = ['/usr/lib/polkit-1/polkit-agent-helper-1', '/usr/libexec/polkit-agent-helper-1']

// ---------- identities ----------
export type Identity = { kind: 'unix-user'; uid: number } | { kind: 'unix-group'; gid: number }

export function parseIdentities(raw: unknown): Identity[] {
  const out: Identity[] = []
  for (const item of Array.isArray(raw) ? raw : []) {
    const [kind, d] = item as [string, Record<string, { value: unknown }>]
    if (kind === 'unix-user' && Number.isInteger(Number(d?.uid?.value))) out.push({ kind, uid: Number(d.uid.value) })
    if (kind === 'unix-group' && Number.isInteger(Number(d?.gid?.value))) out.push({ kind, gid: Number(d.gid.value) })
  }
  return out
}

/** Admin accounts that may answer: users named directly plus members of named groups (listed or primary), root last. */
export function accountsFor(ids: Identity[], passwd: string, group: string): string[] {
  const users = passwd.split('\n').map((l) => l.split(':')).filter((f) => f.length >= 4 && f[0]).map((f) => ({ name: f[0], uid: Number(f[2]), gid: Number(f[3]) }))
  const out: string[] = []
  const add = (n: string | undefined) => { if (n && !out.includes(n)) out.push(n) }
  for (const id of ids) {
    if (id.kind === 'unix-user') { add(users.find((u) => u.uid === id.uid)?.name); continue }
    const g = group.split('\n').map((l) => l.split(':')).find((f) => f.length >= 4 && Number(f[2]) === id.gid)
    for (const m of (g?.[3] ?? '').split(',').map((x) => x.trim())) if (users.some((u) => u.name === m)) add(m)
    for (const u of users) if (u.gid === id.gid) add(u.name)
  }
  return [...out.filter((n) => n !== 'root'), ...out.filter((n) => n === 'root')]
}

// ---------- requests ----------
export interface AuthRequest { cookie: string; action: string; message: string; program: string | null; accounts: string[] }

/** What the window shows. `program` comes from pkexec's details or the caller's executable. */
export function describeRequest(actionId: string, message: string, details: Record<string, string>, accounts: string[], cookie: string): AuthRequest {
  const program = details.program || details['polkit.caller-program'] || details.command_line?.split(' ')[0] || null
  return { cookie, action: actionId, message: message || actionId, program: program ? path.basename(program) : null, accounts }
}

// ---------- helper conversation ----------
export interface HelperIo { write(s: string): void; end(): void; onLine(cb: (line: string) => void): void; onClose(cb: () => void): void }
export type HelperResult = 'ok' | 'failed'

/**
 * Drives polkit-agent-helper-1's line protocol: answer the password prompt once, ignore info/error lines, and
 * finish on SUCCESS/FAILURE. A second secret prompt (e.g. a one-time code) is not supported and fails safely.
 */
export function converse(io: HelperIo, user: string, password: string): Promise<HelperResult> {
  return new Promise((resolve) => {
    let answered = false; let done = false
    const finish = (r: HelperResult) => { if (!done) { done = true; io.end(); resolve(r) } }
    io.onLine((line) => {
      if (line === 'SUCCESS') return finish('ok')
      if (line === 'FAILURE') return finish('failed')
      if (line.startsWith('PAM_PROMPT_ECHO_OFF')) {
        if (answered) return finish('failed')
        answered = true
        io.write(`${password}\n`)
      } else if (line.startsWith('PAM_PROMPT_ECHO_ON')) io.write(`${user}\n`)
    })
    io.onClose(() => finish('failed'))
  })
}

function lineReader(onLine: (l: string) => void) {
  let buf = ''
  return (chunk: Buffer | string) => {
    buf += String(chunk)
    let i
    while ((i = buf.indexOf('\n')) >= 0) { onLine(buf.slice(0, i)); buf = buf.slice(i + 1) }
  }
}

/** Socket-activated helper (polkit ≥ 126) when present, else the setuid helper binary. Cookie on the stream, not argv. */
export function openHelper(user: string, cookie: string): HelperIo | null {
  if (existsSync(HELPER_SOCKET)) {
    const s = connect(HELPER_SOCKET)
    s.write(`${user}\n${cookie}\n`)
    return {
      write: (x) => { s.write(x) }, end: () => { s.end() },
      onLine: (cb) => { s.on('data', lineReader(cb)) }, onClose: (cb) => { s.on('close', cb); s.on('error', cb) },
    }
  }
  const bin = HELPERS.find((h) => existsSync(h))
  if (!bin) return null
  const p = spawn(bin, [user], { stdio: ['pipe', 'pipe', 'ignore'], env: { LC_ALL: 'C', PATH: '/usr/bin:/bin' } })
  p.stdin.write(`${cookie}\n`)
  return {
    write: (x) => { p.stdin.write(x) }, end: () => { p.stdin.end() },
    onLine: (cb) => { p.stdout.on('data', lineReader(cb)) }, onClose: (cb) => { p.on('close', cb); p.on('error', cb) },
  }
}

// ---------- D-Bus agent ----------
export interface AgentUi {
  /** Show the request; resolve with the chosen account+password, or null when the user cancels. */
  ask(req: AuthRequest, retry: boolean): Promise<{ account: string; password: string } | null>
  close(cookie: string): void
}

const ERR_CANCELLED = 'org.freedesktop.PolicyKit1.Error.Cancelled'
const ERR_FAILED = 'org.freedesktop.PolicyKit1.Error.Failed'
export const MAX_TRIES = 3

/** Runs one request: up to MAX_TRIES password attempts. */
export async function authenticate(req: AuthRequest, ui: AgentUi, open: (user: string, cookie: string) => HelperIo | null, cancelled: () => boolean): Promise<'ok' | 'cancelled' | 'failed'> {
  for (let i = 0; i < MAX_TRIES; i++) {
    const a = await ui.ask(req, i > 0)
    if (!a || cancelled()) return 'cancelled'
    if (!req.accounts.includes(a.account)) return 'failed'
    const io = open(a.account, req.cookie)
    if (!io) return 'failed'
    if ((await converse(io, a.account, a.password)) === 'ok') return 'ok'
  }
  return 'failed'
}

export interface AgentDeps { ui: AgentUi; open?: typeof openHelper; passwd?: () => string; group?: () => string }

/** Exports the AuthenticationAgent interface; only polkitd (owner of org.freedesktop.PolicyKit1) may call it. */
export function exportAgent(bus: Bus, deps: AgentDeps, polkitOwner: () => Promise<string | null>) {
  const live = new Map<string, { cancelled: boolean }>()
  const read = (p: string) => { try { return readFileSync(p, 'utf8') } catch { return '' } }
  bus.addMethodHandler((m: Msg) => {
    if (m.path !== AGENT_PATH || m.interface !== AGENT_IFACE) return false
    void (async () => {
      if (m.sender !== (await polkitOwner())) { bus.send(newError(m, 'org.freedesktop.DBus.Error.AccessDenied', 'not polkitd')); return }
      if (m.member === 'CancelAuthentication') {
        const c = String(m.body[0]); const s = live.get(c)
        if (s) { s.cancelled = true; deps.ui.close(c) }
        bus.send(Message.newMethodReturn(m, '', [])); return
      }
      if (m.member !== 'BeginAuthentication') { bus.send(newError(m, 'org.freedesktop.DBus.Error.UnknownMethod', 'unknown')); return }
      const [actionId, message, , details, cookie, identities] = m.body as [string, string, string, Record<string, string>, string, unknown]
      const accounts = accountsFor(parseIdentities(identities), (deps.passwd ?? (() => read('/etc/passwd')))(), (deps.group ?? (() => read('/etc/group')))())
      const state = { cancelled: false }
      live.set(cookie, state)
      const req = describeRequest(actionId, message, details ?? {}, accounts, cookie)
      const r = accounts.length ? await authenticate(req, deps.ui, deps.open ?? openHelper, () => state.cancelled) : 'failed'
      live.delete(cookie)
      deps.ui.close(cookie)
      if (r === 'ok') bus.send(Message.newMethodReturn(m, '', []))
      else bus.send(newError(m, r === 'cancelled' ? ERR_CANCELLED : ERR_FAILED, r === 'cancelled' ? 'Cancelled by the user' : 'Authentication failed'))
    })()
    return true
  })
}

/** The user's graphical session id from logind (user services have no XDG_SESSION_ID). */
export async function displaySession(bus: Bus, uid: number): Promise<string | null> {
  if (process.env.XDG_SESSION_ID) return process.env.XDG_SESSION_ID
  try {
    const u = await bus.call(new Message({ destination: 'org.freedesktop.login1', path: '/org/freedesktop/login1', interface: 'org.freedesktop.login1.Manager', member: 'GetUser', signature: 'u', body: [uid] }))
    const p = await bus.call(new Message({ destination: 'org.freedesktop.login1', path: String(u!.body[0]), interface: 'org.freedesktop.DBus.Properties', member: 'Get', signature: 'ss', body: ['org.freedesktop.login1.User', 'Display'] }))
    const [id] = (p!.body[0] as { value: [string, string] }).value
    return id || null
  } catch { return null }
}

export async function registerAgent(bus: Bus, sessionId: string, locale: string): Promise<void> {
  await bus.call(new Message({ ...AUTHORITY, member: 'RegisterAuthenticationAgent', signature: '(sa{sv})ss',
    body: [['unix-session', { 'session-id': new Variant('s', sessionId) }], locale, AGENT_PATH] }))
}

export async function nameOwner(bus: Bus, name: string): Promise<string | null> {
  try {
    const r = await bus.call(new Message({ destination: 'org.freedesktop.DBus', path: '/org/freedesktop/DBus', interface: 'org.freedesktop.DBus', member: 'GetNameOwner', signature: 's', body: [name] }))
    return String(r!.body[0])
  } catch { return null }
}

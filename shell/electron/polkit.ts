// G05: the shell side of the WorkSuite polkit agent (services/session/polkit, WSOS-INT-010). The agent registers with
// polkitd and sends each administrator request here over $XDG_RUNTIME_DIR/worksuite-polkit.sock; the renderer draws
// the prompt and the password goes back to the agent, which hands it to PAM. Nothing here decides whether a password
// is right. Without the agent (lxpolkit fallback, browser preview) no prompt is shown by the shell.
import net from 'node:net'
import path from 'node:path'

type Handle = (channel: string, fn: (...args: string[]) => unknown) => void
type Broadcast = (channel: string, payload: unknown) => void

export interface PolkitPrompt {
  id: string
  actionId: string
  message: string
  program: string | null
  user: string
  userDisplay: string
  /** Tries left before pam_faillock locks the account (null while locked). */
  remaining: number | null
  locked: boolean
  /** ms since epoch; null while locked means "until an administrator unlocks it". */
  lockedUntil: number | null
  deny: number
  unlockTime: number
  failed: boolean
  info: { text: string; error: boolean } | null
  busy: boolean
}

const str = (v: unknown, max = 500) => (typeof v === 'string' ? v.slice(0, max) : '')
const num = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : null)

/** Applies one agent message to the current prompt (null = no prompt on screen). */
export function applyAgentMessage(cur: PolkitPrompt | null, m: Record<string, unknown>): PolkitPrompt | null {
  const lock = (p: PolkitPrompt) => ({
    remaining: num(m.remaining), locked: m.locked === true, lockedUntil: num(m.locked_until),
    deny: num(m.deny) ?? p.deny, unlockTime: num(m.unlock_time) ?? p.unlockTime,
  })
  switch (m.type) {
    case 'request': {
      const base: PolkitPrompt = {
        id: str(m.id, 64), actionId: str(m.action_id, 200), message: str(m.message), program: str(m.program, 80) || null,
        user: str(m.user, 64), userDisplay: str(m.user_display, 120) || str(m.user, 64),
        remaining: null, locked: false, lockedUntil: null, deny: 5, unlockTime: 600, failed: false, info: null, busy: false,
      }
      return base.id ? { ...base, ...lock(base) } : cur
    }
    case 'info':
      return cur && m.id === cur.id ? { ...cur, info: { text: str(m.text, 300), error: m.error === true } } : cur
    case 'result':
      if (!cur || m.id !== cur.id) return cur
      if (m.ok === true) return null
      return { ...cur, ...lock(cur), failed: true, busy: false }
    case 'done':
      return cur && m.id === cur.id ? null : cur
    default:
      return cur
  }
}

/** Splits the socket stream into JSON objects; malformed lines are dropped. */
export function lineParser(onMessage: (m: Record<string, unknown>) => void) {
  let buf = ''
  return (chunk: string) => {
    buf += chunk
    let i: number
    while ((i = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, i)
      buf = buf.slice(i + 1)
      try {
        const m = JSON.parse(line)
        if (m && typeof m === 'object' && typeof m.type === 'string') onMessage(m)
      } catch { /* ignore */ }
    }
    if (buf.length > 65536) buf = ''
  }
}

export function socketPath(env = process.env): string {
  return path.join(env.XDG_RUNTIME_DIR || `/run/user/${process.getuid?.() ?? 0}`, 'worksuite-polkit.sock')
}

export function startPolkitBridge(handle: Handle, broadcast: Broadcast, connect: (p: string) => net.Socket = (p) => net.connect(p)) {
  let prompt: PolkitPrompt | null = null
  let sock: net.Socket | null = null
  const set = (p: PolkitPrompt | null) => { prompt = p; broadcast('ws:polkit', prompt) }
  const send = (m: Record<string, unknown>) => { if (sock && !sock.destroyed) sock.write(JSON.stringify(m) + '\n') }
  const open = () => {
    const s = connect(socketPath())
    s.setEncoding('utf8')
    s.on('connect', () => { sock = s })
    s.on('data', lineParser((m) => set(applyAgentMessage(prompt, m))))
    s.on('error', () => {})
    s.on('close', () => { if (sock === s) sock = null; if (prompt) set(null); setTimeout(open, 3000) })
  }
  open()
  handle('ws:polkitState', () => prompt)
  handle('ws:polkitRespond', (id, password) => {
    if (!prompt || prompt.id !== id || (prompt.locked && !(prompt.lockedUntil && Date.now() >= prompt.lockedUntil))) return false
    set({ ...prompt, busy: true, info: null })
    send({ type: 'respond', id, password })
    return true
  })
  handle('ws:polkitCancel', (id) => {
    if (!prompt || prompt.id !== id) return false
    send({ type: 'cancel', id })
    set(null)
    return true
  })
}

// The shell's side of the on-device AI assistant (services/ai): a client for $XDG_RUNTIME_DIR/worksuite/ai.sock and
// the IPC the renderer uses. Desktop's main process plays this part for its windows (electron/services/local-ai/host.ts).
// The renderer never sees a model path or the socket; prompts and answers pass through here and are never logged.
//
// Context for "Summarise the selection / the clipboard" and "Explain this file" is read here, only when the person
// chooses that action: the primary selection and the clipboard through wl-paste, and a file from Files only when it is
// text, under the person's own places, and no larger than FILE_MAX.
import { execFile } from 'node:child_process'
import { createConnection, type Socket } from 'node:net'
import { open, stat } from 'node:fs/promises'
import path from 'node:path'
import { resolveIn } from './files'

type Handle = (channel: string, fn: (...args: string[]) => unknown) => void
type Broadcast = (channel: string, payload: unknown) => void
export type AIReply<T = unknown> = { ok: true; value: T } | { ok: false; error: string }

export const FILE_MAX = 64 * 1024
export const CONTEXT_MAX = 24_000
const REQ_ID = /^[A-Za-z0-9-]{8,64}$/
const MODEL_ID = /^[a-z0-9][a-z0-9._-]{1,63}$/

export const aiSocketPath = (env: NodeJS.ProcessEnv = process.env) => path.join(env.XDG_RUNTIME_DIR || `/run/user/${process.getuid?.() ?? 0}`, 'worksuite', 'ai.sock')

/** One request on its own connection; `onStream` gets the answer's events when the method streams (Ask). */
export function aiCall(method: string, params: Record<string, unknown> = {}, opts: { socket?: string; timeoutMs?: number; onStream?: (ev: Record<string, unknown>) => boolean } = {}): Promise<AIReply> {
  return new Promise((resolve) => {
    const sock = createConnection(opts.socket ?? aiSocketPath())
    let buf = ''
    let replied = false
    const finish = (r: AIReply) => { if (!replied) { replied = true; resolve(r) } }
    sock.setEncoding('utf8')
    sock.setTimeout(opts.timeoutMs ?? 30_000, () => { finish({ ok: false, error: 'service_timeout' }); if (!opts.onStream) sock.destroy() })
    sock.on('connect', () => sock.write(JSON.stringify({ id: 1, method, params }) + '\n'))
    sock.on('data', (c: string) => {
      buf += c
      let nl: number
      while ((nl = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, nl); buf = buf.slice(nl + 1)
        let m: Record<string, unknown>
        try { m = JSON.parse(line) } catch { finish({ ok: false, error: 'bad_reply' }); sock.destroy(); return }
        if (m.stream && opts.onStream) {
          // The stream ends with done or error: then the connection is closed.
          if (opts.onStream(m.stream as Record<string, unknown>)) sock.destroy()
          continue
        }
        if ('error' in m) { finish({ ok: false, error: String(m.error) }); sock.destroy(); return }
        finish({ ok: true, value: m.result })
        if (!opts.onStream) sock.destroy()
        else sock.setTimeout(0)
      }
    })
    sock.on('error', () => finish({ ok: false, error: 'service_unavailable' }))
    sock.on('close', () => finish({ ok: false, error: 'service_unavailable' }))
  })
}

/** Follows the service's Watch stream; reconnects every 5 s while it is not running. */
export function watchAI(onChange: () => void, socket = aiSocketPath()): () => void {
  let sock: Socket | null = null
  let stopped = false
  let timer: NodeJS.Timeout | null = null
  const connect = () => {
    if (stopped) return
    sock = createConnection(socket)
    let buf = ''
    sock.setEncoding('utf8')
    sock.on('connect', () => { sock!.write(JSON.stringify({ id: 1, method: 'Watch' }) + '\n'); onChange() })
    sock.on('data', (c: string) => {
      buf += c
      let nl: number
      while ((nl = buf.indexOf('\n')) >= 0) { const l = buf.slice(0, nl); buf = buf.slice(nl + 1); if (l.includes('"changed"')) onChange() }
    })
    sock.on('error', () => {})
    sock.on('close', () => { if (!stopped) timer = setTimeout(connect, 5000) })
  }
  connect()
  return () => { stopped = true; if (timer) clearTimeout(timer); sock?.destroy() }
}

const exec = (cmd: string, args: string[]) => new Promise<string | null>((resolve) =>
  execFile(cmd, args, { timeout: 3000, maxBuffer: CONTEXT_MAX * 4 }, (e, out) => resolve(e ? null : String(out))))

/** Text only, valid UTF-8, no NULs: what may go to the model from a file. */
export function asText(buf: Buffer): string | null {
  if (buf.includes(0)) return null
  const s = buf.toString('utf8')
  if (s.includes('�')) return null
  return s
}

/** A text file from Files, for "Explain this file": inside the person's places, a regular file, ≤ FILE_MAX, text. */
export async function readTextFile(env: Parameters<typeof resolveIn>[0], root: string, rel: string): Promise<AIReply<{ name: string; text: string }>> {
  const p = resolveIn(env, root, rel)
  if (!p || !rel) return { ok: false, error: 'invalid_argument' }
  const st = await stat(p.full).catch(() => null)
  if (!st?.isFile()) return { ok: false, error: 'not_a_file' }
  if (st.size > FILE_MAX) return { ok: false, error: 'file_too_large' }
  const fh = await open(p.full, 'r')
  try {
    const buf = Buffer.alloc(st.size)
    await fh.read(buf, 0, st.size, 0)
    const text = asText(buf)
    return text === null ? { ok: false, error: 'not_text' } : { ok: true, value: { name: path.basename(p.full), text } }
  } finally {
    await fh.close()
  }
}

const parse = (json: string): Record<string, unknown> | null => { try { const v = JSON.parse(json); return v && typeof v === 'object' && !Array.isArray(v) ? v : null } catch { return null } }

export function startAIHost(handle: Handle, broadcast: Broadcast, files: Parameters<typeof resolveIn>[0], deps: { readClipboard: () => string } ) {
  const id = (s: string) => (MODEL_ID.test(s) ? s : null)
  const withId = (method: string) => (s: string) => { const m = id(s); return m ? aiCall(method, { id: m }) : { ok: false, error: 'invalid_argument' } }
  handle('ws:aiStatus', () => aiCall('Status'))
  handle('ws:aiModels', () => aiCall('Models'))
  handle('ws:aiRefresh', () => aiCall('Refresh'))
  handle('ws:aiInstall', withId('Install'))
  handle('ws:aiRemove', withId('Remove'))
  handle('ws:aiSetDefault', withId('SetDefault'))
  handle('ws:aiCheck', withId('Check'))
  handle('ws:aiTest', (s) => { const m = id(s); return m ? aiCall('Test', { id: m }, { timeoutMs: 6 * 60_000 }) : { ok: false, error: 'invalid_argument' } })
  handle('ws:aiCancel', (s, discard) => { const m = id(s); return m ? aiCall('Cancel', { id: m, discard: discard === '1' }) : { ok: false, error: 'invalid_argument' } })
  handle('ws:aiRestart', () => aiCall('Restart'))
  handle('ws:aiSetSettings', (json) => { const p = parse(json); return p ? aiCall('SetSettings', p) : { ok: false, error: 'invalid_argument' } })
  // The answer streams to the shell windows as ws:aiEvent; the call answers once the service accepted the question.
  handle('ws:aiAsk', (json) => {
    const p = parse(json)
    if (!p || typeof p.id !== 'string' || !REQ_ID.test(p.id)) return { ok: false, error: 'invalid_argument' }
    return aiCall('Ask', p, { timeoutMs: 6 * 60_000, onStream: (ev) => { broadcast('ws:aiEvent', ev); return ev.type === 'done' || ev.type === 'error' } })
  })
  handle('ws:aiCancelAsk', (s) => (REQ_ID.test(s) ? aiCall('CancelAsk', { id: s }) : { ok: false, error: 'invalid_argument' }))
  // Context, read only when the person picks the action.
  handle('ws:aiSelection', async () => {
    const t = await exec('wl-paste', ['--primary', '--no-newline', '--type', 'text/plain'])
    return t?.trim() ? { ok: true, value: t.slice(0, CONTEXT_MAX) } : { ok: false, error: 'no_selection' }
  })
  handle('ws:aiClipboard', () => {
    const t = deps.readClipboard()
    return t.trim() ? { ok: true, value: t.slice(0, CONTEXT_MAX) } : { ok: false, error: 'no_clipboard' }
  })
  handle('ws:aiReadFile', (root, rel) => readTextFile(files, root, rel))
  watchAI(() => broadcast('ws:aiChanged', null))
}

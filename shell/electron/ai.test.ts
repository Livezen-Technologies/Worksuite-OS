// The shell's client for worksuite-ai (electron/ai.ts): the socket protocol and streaming, the service being down,
// and the context it reads for "Explain with AI" (text only, size-capped, inside the person's places).
import { createServer, type Server } from 'node:net'
import { mkdtempSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { FILE_MAX, aiCall, asText, readTextFile } from './ai'

let server: Server | null = null
let dir = ''
afterEach(() => { server?.close(); server = null; if (dir) rmSync(dir, { recursive: true, force: true }) })

function fakeService(onLine: (req: { method: string; params: Record<string, unknown> }, write: (v: unknown) => void) => void) {
  dir = mkdtempSync(path.join(tmpdir(), 'wsai-'))
  const sock = path.join(dir, 'ai.sock')
  server = createServer((c) => {
    let buf = ''
    c.setEncoding('utf8')
    c.on('data', (d: string) => {
      buf += d
      const i = buf.indexOf('\n')
      if (i < 0) return
      const req = JSON.parse(buf.slice(0, i))
      onLine(req, (v) => c.write(JSON.stringify(v) + '\n'))
    })
  })
  return new Promise<string>((r) => server!.listen(sock, () => r(sock)))
}

describe('worksuite-ai client', () => {
  it('a request gets its result or its error code', async () => {
    const sock = await fakeService((req, w) => w(req.method === 'Status' ? { id: 1, result: { runtime: 'off' } } : { id: 1, error: 'bad_request' }))
    expect(await aiCall('Status', {}, { socket: sock })).toEqual({ ok: true, value: { runtime: 'off' } })
    expect(await aiCall('Nope', {}, { socket: sock })).toEqual({ ok: false, error: 'bad_request' })
  })

  it('Ask answers once accepted, then the answer streams until done', async () => {
    const sock = await fakeService((req, w) => {
      expect(req.params.id).toBe('req-00000001')
      w({ id: 1, result: true })
      setTimeout(() => { w({ stream: { id: 'req-00000001', type: 'chunk', text: 'Hi' } }); w({ stream: { id: 'req-00000001', type: 'done', text: 'Hi', tokens: 1, ms: 5, cancelled: false } }) }, 10)
    })
    const events: unknown[] = []
    let done!: () => void
    const finished = new Promise<void>((r) => { done = r })
    const r = await aiCall('Ask', { id: 'req-00000001', messages: [] }, { socket: sock, onStream: (ev) => { events.push(ev); const end = ev.type === 'done'; if (end) done(); return end } })
    expect(r).toEqual({ ok: true, value: true })
    await finished
    expect(events).toEqual([{ id: 'req-00000001', type: 'chunk', text: 'Hi' }, { id: 'req-00000001', type: 'done', text: 'Hi', tokens: 1, ms: 5, cancelled: false }])
  })

  it('a service that is not running is said, not hidden', async () => {
    expect(await aiCall('Status', {}, { socket: path.join(tmpdir(), 'no-such-ai.sock') })).toEqual({ ok: false, error: 'service_unavailable' })
  })
})

describe('Explain with AI: what may be read', () => {
  it('reads a text file inside the person’s places', async () => {
    dir = mkdtempSync(path.join(tmpdir(), 'wsai-home-'))
    writeFileSync(path.join(dir, 'notes.txt'), 'Meeting at 10.\n')
    expect(await readTextFile({ home: dir, user: 'nobody' }, 'home', 'notes.txt')).toEqual({ ok: true, value: { name: 'notes.txt', text: 'Meeting at 10.\n' } })
  })
  it('refuses binary files, large files, folders, and paths that leave the place', async () => {
    dir = mkdtempSync(path.join(tmpdir(), 'wsai-home-'))
    writeFileSync(path.join(dir, 'a.bin'), Buffer.from([0x7f, 0x45, 0x4c, 0x46, 0, 1, 2]))
    writeFileSync(path.join(dir, 'big.txt'), 'x'.repeat(FILE_MAX + 1))
    mkdirSync(path.join(dir, 'folder'))
    symlinkSync('/etc/hostname', path.join(dir, 'link'))
    const env = { home: dir, user: 'nobody' }
    expect(await readTextFile(env, 'home', 'a.bin')).toEqual({ ok: false, error: 'not_text' })
    expect(await readTextFile(env, 'home', 'big.txt')).toEqual({ ok: false, error: 'file_too_large' })
    expect(await readTextFile(env, 'home', 'folder')).toEqual({ ok: false, error: 'not_a_file' })
    expect(await readTextFile(env, 'home', '../etc/passwd')).toEqual({ ok: false, error: 'invalid_argument' })
    expect(await readTextFile(env, 'home', 'link')).toEqual({ ok: false, error: 'invalid_argument' })
    expect(await readTextFile(env, 'nowhere', 'x')).toEqual({ ok: false, error: 'invalid_argument' })
  })
  it('text means valid UTF-8 without NUL bytes', () => {
    expect(asText(Buffer.from('ශ්‍රී லங்கா'))).toBe('ශ්‍රී லங்கா')
    expect(asText(Buffer.from([0xff, 0xfe, 0x41]))).toBeNull()
  })
})

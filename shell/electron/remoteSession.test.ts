import { createHash } from 'node:crypto'
import { mkdtempSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { RemoteSessionController, type CaptureWindow } from './remoteSession'
import { applyInput, helperBackend, keysym, openInput, parseInput, PointerTracker, portalBackend, type InputBackend, type PortalBus } from './rsInput'
import { regionFor, type RsSession } from './remoteSupport'
import { ClipboardSync, CLIP_MAX } from './rsClipboard'
import { CHUNK, FileTransfers, safeName, type FileAudit } from './rsFiles'
import { downscale, QUALITY } from './rsQuality'

const ACTIVE: RsSession = { session_id: '7d1b3c1e-4b1a-4c55-9a77-3f1d2b9e0c11', state: 'active', mode: 'control', reason: 'r', admin_name: 'A', org_name: 'O', consent: 'user', granted_mode: 'control', requested_at: 1, started_at: 2, expires_at: 9e12, record: false, clipboard: false, elevation: null }

function rig(initial: RsSession | null) {
  let s = initial
  const sent: [string, unknown][] = []
  const posts: unknown[] = []
  let closed = 0, ended = 0
  const inputs: string[] = []
  const backend: InputBackend = { name: 'fake', async move(x, y) { inputs.push(`move ${x} ${y}`) }, async button(b, d) { inputs.push(`btn ${b} ${d}`) }, async scroll() { inputs.push('scroll') }, async key(k, d) { inputs.push(`key ${k} ${d}`) }, async close() { inputs.push('close') } }
  let reply: { status: number; body: unknown } = { status: 200, body: { ice_servers: [{ urls: 'stun:x' }], messages: [{ id: 3, type: 'answer', sdp: 'a' }] } }
  const events: Record<string, unknown>[] = []
  const clip = { text: '' }
  const dl = mkdtempSync(join(tmpdir(), 'ws-rs-dl-'))
  const fetchFn = (async (url: string, init?: RequestInit) => {
    if (url.endsWith('/events')) { events.push(JSON.parse(String(init!.body))); return new Response(null, { status: 204 }) }
    if (url.endsWith('/ice-servers')) return new Response(JSON.stringify({ ice_servers: [{ urls: 'turn:fresh', username: 'u', credential: 'c' }] }))
    if (init?.method === 'POST') { posts.push(JSON.parse(String(init.body))); return new Response(null, { status: 204 }) }
    expect(url).toContain('/desktop/v1/os/remote-support/sessions/7d1b3c1e-4b1a-4c55-9a77-3f1d2b9e0c11/signal')
    expect((init?.headers as Record<string, string>)['x-ws-device']).toBe('cred')
    return new Response(JSON.stringify(reply.body), { status: reply.status })
  }) as unknown as typeof fetch
  const win: CaptureWindow = { send: (c, d) => sent.push([c, d]), close: () => { closed++ } }
  let opened = 0
  let now = 1000
  const ctl = new RemoteSessionController({
    state: async () => s, end: async () => { ended++ }, credential: () => 'cred', serverBase: () => 'https://ws.test/', fetch: fetchFn,
    openWindow: () => { opened++; return win }, openInput: async () => backend, now: () => now,
    downloadsDir: () => dl, clipboard: { read: () => clip.text, write: (t) => { clip.text = t } },
    monitors: async () => [{ id: 'screen:1', name: 'Left' }, { id: 'screen:2', name: 'Right' }],
    selectMonitor: (id) => (id === 'screen:2' ? { x: 1920, y: 0, w: 1280, h: 1024, layoutW: 3200, layoutH: 1080 } : null),
  })
  // Data-channel sends are acknowledged by the capture window; the fake acknowledges at once.
  const dc = () => sent.filter(([c]) => c === 'rs:dc-send').map(([, d]) => JSON.parse(String(d)))
  const origSend = win.send
  win.send = (c, d) => { origSend(c, d); if (c === 'rs:dc-send') queueMicrotask(() => ctl.dcAck()) }
  return { ctl, sent, posts, inputs, events, clip, dl, dc, set: (n: RsSession | null) => { s = n }, setReply: (r: typeof reply) => { reply = r }, counts: () => ({ opened, closed, ended }), tickClock: (ms: number) => { now += ms } }
}

describe('remote session media (issue #19)', () => {
  it('no capture window until the session is active (consented)', async () => {
    const r = rig({ ...ACTIVE, state: 'pending', granted_mode: null, consent: null })
    await r.ctl.tick()
    expect(r.counts().opened).toBe(0)
    r.set(ACTIVE)
    await r.ctl.tick()
    expect(r.counts().opened).toBe(1)
    expect(r.sent[0]).toEqual(['rs:start', { iceServers: [{ urls: 'stun:x' }], maxFps: 30, quality: QUALITY.balanced }])
    expect(r.sent[1]).toEqual(['rs:signal-in', { id: 3, type: 'answer', sdp: 'a' }])
  })
  it('input applied only while the grant is control; View only stops it at once', async () => {
    const r = rig(ACTIVE)
    await r.ctl.tick()
    await r.ctl.onInput({ t: 'pb', b: 0, down: true, x: 0.5, y: 0.5 })
    await r.ctl.onInput({ t: 'k', key: 'a', code: 'KeyA', down: true })
    await r.ctl.onInput({ t: 'exec', cmd: 'rm' })
    expect(r.inputs).toEqual(['move 0.5 0.5', 'btn 0 true', 'key 97 true'])
    r.set({ ...ACTIVE, granted_mode: 'view' })
    await r.ctl.onInput({ t: 'pm', x: 0.1, y: 0.1 })
    expect(r.inputs.at(-1)).toBe('close')
    expect(r.ctl.stats).toEqual({ applied: 2, dropped: 2 })
  })
  it('ends: window closed and bye sent when the session ends or the server stops relaying; capture stopped ends the session', async () => {
    const r = rig(ACTIVE)
    await r.ctl.tick()
    r.ctl.chatIn('hello'); expect(r.ctl.chatOut('hi back')).toBe(true)
    expect(r.ctl.chatLog().map((l) => l.from)).toEqual(['admin', 'user'])
    r.set(null)
    await r.ctl.tick()
    expect(r.counts().closed).toBe(1)
    expect(r.posts).toContainEqual({ type: 'bye' })
    expect(r.ctl.chatLog()).toEqual([])

    const s = rig(ACTIVE)
    await s.ctl.tick()
    s.setReply({ status: 409, body: {} })
    await s.ctl.tick()
    expect(s.counts().closed).toBe(1)

    const e = rig(ACTIVE)
    await e.ctl.tick()
    await e.ctl.ended()
    expect(e.counts()).toMatchObject({ ended: 1, closed: 1 })
  })
})

describe('input mapping', () => {
  it('validates viewer messages', () => {
    expect(parseInput({ t: 'pm', x: 2, y: 0 })).toBeNull()
    expect(parseInput({ t: 'pb', b: 7, down: true, x: 0, y: 0 })).toBeNull()
    expect(parseInput({ t: 'k', key: 'x'.repeat(40), code: '', down: true })).toBeNull()
    expect(parseInput({ t: 'ax', dx: 0, dy: -1 })).toEqual({ t: 'ax', dx: 0, dy: -1 })
  })
  it('keysyms', () => {
    expect(keysym('a')).toBe(0x61); expect(keysym('Enter')).toBe(0xff0d); expect(keysym('ශ')).toBe(0x01000000 + 0x0dc1)
    expect(keysym('Unidentified')).toBeNull(); expect(keysym('F5')).toBe(0xffc2)
  })
  it('relative pointer: warp to the corner once, then deltas', () => {
    const t = new PointerTracker()
    expect(t.delta(0.5, 0.5, 100, 100)).toEqual([{ dx: -100000, dy: -100000 }, { dx: 50, dy: 50 }])
    expect(t.delta(0.6, 0.5, 100, 100)).toEqual([{ dx: 10, dy: 0 }])
  })
  it('wlroots helper backend: absolute motion, separate press/release, keysyms in hex, release on close', async () => {
    const lines: string[] = []
    let closed = false
    const b = helperBackend({ write: (l) => lines.push(l), close: () => { closed = true } })
    await applyInput(b, { t: 'pb', b: 0, down: true, x: 0.25, y: 0.5 }, { w: 1920, h: 1080 })
    await applyInput(b, { t: 'pm', x: 0.5, y: 0.5 }, { w: 1920, h: 1080 })
    await applyInput(b, { t: 'pb', b: 0, down: false, x: 0.5, y: 0.5 }, { w: 1920, h: 1080 })
    await applyInput(b, { t: 'ax', dx: 1, dy: -1 }, { w: 1, h: 1 })
    await applyInput(b, { t: 'k', key: 'Shift', code: 'ShiftLeft', down: true }, { w: 1, h: 1 })
    await applyInput(b, { t: 'k', key: 'A', code: 'KeyA', down: true }, { w: 1, h: 1 })
    await applyInput(b, { t: 'k', key: 'A', code: 'KeyA', down: false }, { w: 1, h: 1 })
    b.setRegion({ x: 1920, y: 0, w: 1280, h: 1024, layoutW: 3200, layoutH: 1080 })
    await applyInput(b, { t: 'pm', x: 0.5, y: 1 }, { w: 1280, h: 1024 })
    await b.close()
    expect(lines).toEqual(['m 480 540 1920 1080', 'b 272 1', 'm 960 540 1920 1080', 'm 960 540 1920 1080', 'b 272 0', 'a v -1', 'a h 1',
      'k ffe1 1', 'k 41 1', 'k 41 0', 'm 2560 1024 3200 1080', 'r'])
    expect(closed).toBe(true)
  })
  it('openInput: portal first, the helper when the portal has no RemoteDesktop backend', async () => {
    const lines: string[] = []
    const b = await openInput(async () => { throw new Error('org.freedesktop.DBus.Error.UnknownMethod') }, async () => ({ write: (l) => lines.push(l), close: () => {} }))
    expect(b.name).toBe('wlroots')
    await b.button(1, true)
    expect(lines).toEqual(['b 274 1'])
  })
  it('regionFor: the chosen display inside the layout; null with one display', () => {
    const ds = [{ id: 1, bounds: { x: 0, y: 0, width: 1920, height: 1080 } }, { id: 2, bounds: { x: 1920, y: 0, width: 1280, height: 1024 } }]
    expect(regionFor('2', ds)).toEqual({ x: 1920, y: 0, w: 1280, h: 1024, layoutW: 3200, layoutH: 1080 })
    expect(regionFor('1', [ds[0]])).toBeNull()
    expect(regionFor('9', ds)).toBeNull()
  })
  it('portal backend: CreateSession, SelectDevices, Start, then Notify* on that session', async () => {
    const calls: string[] = []
    const bus: PortalBus = {
      async request(m) { calls.push(m); return m === 'CreateSession' ? { session_handle: { value: '/s/1' } } : {} },
      async call(m, a) { calls.push(`${m} ${JSON.stringify(a)}`) }, close() { calls.push('close') },
    }
    const b = await portalBackend(bus)
    await b.button(0, true); await b.key(0x61, false)
    expect(calls).toEqual(['CreateSession', 'SelectDevices', 'Start', 'NotifyPointerButton ["/s/1",{},272,1]', 'NotifyKeyboardKeysym ["/s/1",{},97,0]'])
  })
})

describe('remote session follow-ups (issue #37)', () => {
  const audits = () => { const a: FileAudit[] = []; return a }

  it('incoming file: nothing written before the user accepts; chunks checked by size and SHA-256; saved without overwriting', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'ws-rs-in-'))
    writeFileSync(join(dir, 'notes.txt'), 'existing')
    const sent: Record<string, unknown>[] = [], audit = audits()
    const f = new FileTransfers({ downloadsDir: () => dir, send: (m) => { sent.push(m) }, audit: (e) => audit.push(e) })
    const data = Buffer.alloc(CHUNK + 10, 7)
    const sha = createHash('sha256').update(data).digest('hex')
    expect(await f.onMessage({ t: 'f-offer', id: 'file-001', name: '../../etc/notes.txt', size: data.length })).toBe(true)
    expect(f.list()[0]).toMatchObject({ name: 'notes.txt', state: 'offered', direction: 'to_device' })
    expect(await f.onMessage({ t: 'f-chunk', id: 'file-001', seq: 0, data: data.subarray(0, CHUNK).toString('base64') })).toBe(false)
    expect(readdirSync(dir)).toEqual(['notes.txt'])
    expect(await f.accept('file-001')).toBe(true)
    expect(sent.at(-1)).toEqual({ t: 'f-accept', id: 'file-001' })
    expect(await f.onMessage({ t: 'f-chunk', id: 'file-001', seq: 1, data: 'AAAA' })).toBe(false)          // out of order
    expect(await f.onMessage({ t: 'f-chunk', id: 'file-001', seq: 0, data: data.subarray(0, CHUNK).toString('base64') })).toBe(true)
    expect(await f.onMessage({ t: 'f-chunk', id: 'file-001', seq: 1, data: data.subarray(CHUNK).toString('base64') })).toBe(true)
    expect(await f.onMessage({ t: 'f-end', id: 'file-001', sha256: sha })).toBe(true)
    expect(sent.at(-1)).toEqual({ t: 'f-done', id: 'file-001', ok: true })
    expect(readFileSync(join(dir, 'notes (1).txt'))).toEqual(data)
    expect(readFileSync(join(dir, 'notes.txt'), 'utf8')).toBe('existing')
    expect(f.list()[0].saved_as).toBe('notes (1).txt')
    expect(audit.map((a) => a.action)).toEqual(['offered', 'accepted', 'completed'])
    expect(audit[2].sha256).toBe(sha)
  })

  it('incoming file: declined, too large, wrong hash (partial file removed)', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'ws-rs-in-'))
    const sent: Record<string, unknown>[] = [], audit = audits()
    const f = new FileTransfers({ downloadsDir: () => dir, send: (m) => { sent.push(m) }, audit: (e) => audit.push(e), limit: 100 })
    await f.onMessage({ t: 'f-offer', id: 'big-file', name: 'big.iso', size: 101 })
    expect(sent.at(-1)).toEqual({ t: 'f-reject', id: 'big-file', reason: 'too_large' })
    await f.onMessage({ t: 'f-offer', id: 'no-thanks', name: 'x.sh', size: 3 })
    expect(await f.reject('no-thanks')).toBe(true)
    expect(sent.at(-1)).toEqual({ t: 'f-reject', id: 'no-thanks', reason: 'declined' })
    await f.onMessage({ t: 'f-offer', id: 'bad-hash', name: 'y.txt', size: 3 })
    await f.accept('bad-hash')
    await f.onMessage({ t: 'f-chunk', id: 'bad-hash', seq: 0, data: Buffer.from('abc').toString('base64') })
    expect(await f.onMessage({ t: 'f-end', id: 'bad-hash', sha256: '0'.repeat(64) })).toBe(false)
    expect(sent.at(-1)).toEqual({ t: 'f-done', id: 'bad-hash', ok: false, reason: 'hash_mismatch' })
    expect(readdirSync(dir)).toEqual([])
    expect(await f.onMessage({ t: 'f-offer', id: 'x', name: 'z', size: 1 })).toBe(false)            // bad id
    expect(safeName('a\u0000b/../.hidden')).toBe('hidden')
    expect(audit.map((a) => [a.action, a.reason])).toEqual([['rejected', 'too_large'], ['offered', undefined], ['rejected', 'declined'], ['offered', undefined], ['accepted', undefined], ['failed', 'hash_mismatch']])
  })

  it('outgoing file: only what the user offered, streamed in chunks with its hash when the admin asks', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'ws-rs-out-'))
    const p = join(dir, 'log.txt')
    const data = Buffer.alloc(CHUNK * 2 + 5, 65)
    writeFileSync(p, data)
    const sent: Record<string, unknown>[] = [], audit = audits()
    const f = new FileTransfers({ downloadsDir: () => dir, send: (m) => { sent.push(m) }, audit: (e) => audit.push(e) })
    expect(await f.onMessage({ t: 'f-get', id: 'guessed-id' })).toBe(false)
    const item = (await f.offer(p))!
    expect(sent[0]).toEqual({ t: 'f-offer', id: item.id, name: 'log.txt', size: data.length })
    expect(await f.onMessage({ t: 'f-get', id: item.id })).toBe(true)
    const chunks = sent.filter((m) => m.t === 'f-chunk')
    expect(chunks.map((c) => c.seq)).toEqual([0, 1, 2])
    expect(Buffer.concat(chunks.map((c) => Buffer.from(String(c.data), 'base64')))).toEqual(data)
    expect(sent.at(-1)).toEqual({ t: 'f-end', id: item.id, sha256: createHash('sha256').update(data).digest('hex') })
    expect(await f.onMessage({ t: 'f-get', id: item.id })).toBe(false)
    expect(audit.map((a) => [a.direction, a.action])).toEqual([['to_admin', 'offered'], ['to_admin', 'completed']])
  })

  it('clipboard: nothing read or written until the user turns it on; text only, size-limited, no echo', () => {
    const c = { text: 'before', reads: 0 }
    const out: string[] = []
    const s = new ClipboardSync({ read: () => { c.reads++; return c.text }, write: (t) => { c.text = t }, send: (m) => out.push(m.text) })
    expect(s.poll()).toBe(false)
    expect(s.incoming({ t: 'clip', text: 'from admin' })).toBe(false)
    expect(c.reads).toBe(0)
    expect(c.text).toBe('before')
    s.setEnabled(true)
    expect(s.poll()).toBe(false)                       // the text already there is not sent unasked
    c.text = 'copied on device'
    expect(s.poll()).toBe(true)
    expect(s.incoming({ t: 'clip', text: 'from admin' })).toBe(true)
    expect(c.text).toBe('from admin')
    expect(s.poll()).toBe(false)                       // no echo back
    expect(s.incoming({ t: 'clip', text: 'x'.repeat(CLIP_MAX + 1) })).toBe(false)
    expect(s.incoming({ t: 'clip', text: 42 })).toBe(false)
    s.setEnabled(false)
    c.text = 'secret'
    expect(s.poll()).toBe(false)
    expect(out).toEqual(['copied on device'])
  })

  it('controller: clipboard follows the session switch; chat audited as metadata; quality and monitor from the viewer', async () => {
    const r = rig({ ...ACTIVE, granted_mode: 'view' })
    await r.ctl.tick()
    r.clip.text = 'a'
    await r.ctl.tick()
    expect(r.dc().filter((m) => m.t === 'clip')).toEqual([])
    r.set({ ...ACTIVE, granted_mode: 'view', clipboard: true })
    await r.ctl.tick()
    r.clip.text = 'device text'
    await r.ctl.tick()
    expect(r.dc().filter((m) => m.t === 'clip')).toEqual([{ t: 'clip', text: 'device text' }])
    await r.ctl.onMessage({ t: 'clip', text: 'admin text' })
    expect(r.clip.text).toBe('admin text')
    r.set({ ...ACTIVE, granted_mode: 'view', clipboard: false })
    await r.ctl.tick()
    await r.ctl.onMessage({ t: 'clip', text: 'ignored' })
    expect(r.clip.text).toBe('admin text')

    r.ctl.chatIn('hello there'); r.ctl.chatOut('hi')
    await new Promise((res) => setTimeout(res, 0))
    expect(r.events).toEqual([{ kind: 'chat', direction: 'to_device', length: 11 }, { kind: 'chat', direction: 'to_admin', length: 2 }])
    expect(JSON.stringify(r.events)).not.toContain('hello')

    await r.ctl.onMessage({ t: 'q', preset: 'low' })
    await r.ctl.onMessage({ t: 'q', preset: 'ultra' })
    expect(r.sent.filter(([c]) => c === 'rs:quality')).toEqual([['rs:quality', QUALITY.low]])
    await r.ctl.onMessage({ t: 'mon-list' })
    expect(r.dc().find((m) => m.t === 'mons')).toEqual({ t: 'mons', items: [{ id: 'screen:1', name: 'Left' }, { id: 'screen:2', name: 'Right' }], current: null })
    await r.ctl.onMessage({ t: 'mon', id: 'screen:9' })
    await r.ctl.onMessage({ t: 'mon', id: 'screen:2' })
    expect(r.sent.filter(([c]) => c === 'rs:switch')).toEqual([['rs:switch', { id: 'screen:2' }]])
    expect(downscale(3840, 2160, QUALITY.balanced)).toBe(2)
    expect(downscale(1280, 720, QUALITY.balanced)).toBe(1)
  })

  it('controller: file offers from the viewer audited; files cleared and parts removed when the session ends; fresh TURN credentials', async () => {
    const r = rig(ACTIVE)
    await r.ctl.tick()
    await r.ctl.onMessage({ t: 'f-offer', id: 'abcdef12', name: 'tool.zip', size: 4 })
    await r.ctl.files.accept('abcdef12')
    await new Promise((res) => setTimeout(res, 0))
    expect(r.events.map((e) => [e.kind, e.action, e.direction])).toEqual([['file', 'offered', 'to_device'], ['file', 'accepted', 'to_device']])
    expect(r.dc()).toContainEqual({ t: 'f-accept', id: 'abcdef12' })
    expect(readdirSync(r.dl).length).toBe(1)
    r.tickClock(31 * 60_000)
    await r.ctl.tick()
    expect(r.sent.filter(([c]) => c === 'rs:ice')).toEqual([['rs:ice', [{ urls: 'turn:fresh', username: 'u', credential: 'c' }]]])
    r.set(null)
    await r.ctl.tick()
    expect(readdirSync(r.dl)).toEqual([])
    expect(r.ctl.fileList()).toEqual([])
  })
})

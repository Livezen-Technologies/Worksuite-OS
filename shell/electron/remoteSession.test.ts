import { describe, expect, it } from 'vitest'
import { RemoteSessionController, type CaptureWindow } from './remoteSession'
import { applyInput, keysym, parseInput, PointerTracker, portalBackend, wlrBackend, type InputBackend, type PortalBus } from './rsInput'
import type { RsSession } from './remoteSupport'
import type { Exec } from './system'

const ACTIVE: RsSession = { session_id: '7d1b3c1e-4b1a-4c55-9a77-3f1d2b9e0c11', state: 'active', mode: 'control', reason: 'r', admin_name: 'A', org_name: 'O', consent: 'user', granted_mode: 'control', requested_at: 1, started_at: 2, expires_at: 9e12 }

function rig(initial: RsSession | null) {
  let s = initial
  const sent: [string, unknown][] = []
  const posts: unknown[] = []
  let closed = 0, ended = 0
  const inputs: string[] = []
  const backend: InputBackend = { name: 'fake', async move(x, y) { inputs.push(`move ${x} ${y}`) }, async button(b, d) { inputs.push(`btn ${b} ${d}`) }, async scroll() { inputs.push('scroll') }, async key(k, d) { inputs.push(`key ${k} ${d}`) }, async close() { inputs.push('close') } }
  let reply: { status: number; body: unknown } = { status: 200, body: { ice_servers: [{ urls: 'stun:x' }], messages: [{ id: 3, type: 'answer', sdp: 'a' }] } }
  const fetchFn = (async (url: string, init?: RequestInit) => {
    if (init?.method === 'POST') { posts.push(JSON.parse(String(init.body))); return new Response(null, { status: 204 }) }
    expect(url).toContain('/desktop/v1/os/remote-support/sessions/7d1b3c1e-4b1a-4c55-9a77-3f1d2b9e0c11/signal')
    expect((init?.headers as Record<string, string>)['x-ws-device']).toBe('cred')
    return new Response(JSON.stringify(reply.body), { status: reply.status })
  }) as unknown as typeof fetch
  const win: CaptureWindow = { send: (c, d) => sent.push([c, d]), close: () => { closed++ } }
  let opened = 0
  const ctl = new RemoteSessionController({
    state: async () => s, end: async () => { ended++ }, credential: () => 'cred', serverBase: () => 'https://ws.test/', fetch: fetchFn,
    openWindow: () => { opened++; return win }, openInput: async () => backend, exec: async () => ({ code: 0, stdout: '', stderr: '' }),
  })
  return { ctl, sent, posts, inputs, set: (n: RsSession | null) => { s = n }, setReply: (r: typeof reply) => { reply = r }, counts: () => ({ opened, closed, ended }) }
}

describe('remote session media (issue #19)', () => {
  it('no capture window until the session is active (consented)', async () => {
    const r = rig({ ...ACTIVE, state: 'pending', granted_mode: null, consent: null })
    await r.ctl.tick()
    expect(r.counts().opened).toBe(0)
    r.set(ACTIVE)
    await r.ctl.tick()
    expect(r.counts().opened).toBe(1)
    expect(r.sent[0]).toEqual(['rs:start', { iceServers: [{ urls: 'stun:x' }], maxFps: 30 }])
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
  it('wlroots backend: fixed argv for wlrctl and wtype', async () => {
    const calls: string[][] = []
    const exec: Exec = async (c, a) => { calls.push([c, ...a]); return { code: 0, stdout: '', stderr: '' } }
    const b = wlrBackend(exec)
    await applyInput(b, { t: 'pb', b: 2, down: false, x: 0, y: 0 }, { w: 10, h: 10 })
    await b.key(0xffe3, true); await b.key(0x63, true); await b.key(0xffe3, false); await b.key(0x2d, true)
    expect(calls).toEqual([['wlrctl', 'pointer', 'move', '-100000', '-100000'], ['wlrctl', 'pointer', 'click', 'right'],
      ['wtype', '-M', 'ctrl', 'c', '-m', 'ctrl'], ['wtype', '-k', 'minus']])
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

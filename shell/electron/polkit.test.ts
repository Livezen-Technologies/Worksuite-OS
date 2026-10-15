import { EventEmitter } from 'node:events'
import type net from 'node:net'
import { describe, expect, it, vi } from 'vitest'
import { applyAgentMessage, lineParser, startPolkitBridge, type PolkitPrompt } from './polkit'

const REQ = { type: 'request', id: 'r1', action_id: 'org.worksuite.packagekit.install', message: 'App Center wants to install "Spotify" for all users.',
  program: 'App Center', user: 'alex', user_display: 'Alex Perera', remaining: 5, locked: false, locked_until: null, deny: 5, unlock_time: 300 }

describe('polkit agent messages (G05)', () => {
  it('a request opens the prompt with the tries left', () => {
    const p = applyAgentMessage(null, REQ)!
    expect(p).toMatchObject({ id: 'r1', actionId: 'org.worksuite.packagekit.install', program: 'App Center', userDisplay: 'Alex Perera', remaining: 5, failed: false, deny: 5, unlockTime: 300 })
  })
  it('a wrong password counts down, then locks; success or done closes', () => {
    let p = applyAgentMessage(null, REQ)
    p = applyAgentMessage(p, { type: 'result', id: 'r1', ok: false, remaining: 2, locked: false, locked_until: null, deny: 5, unlock_time: 300 })
    expect(p).toMatchObject({ failed: true, remaining: 2, locked: false })
    p = applyAgentMessage(p, { type: 'result', id: 'r1', ok: false, remaining: null, locked: true, locked_until: 1_000_000, deny: 5, unlock_time: 300 })
    expect(p).toMatchObject({ locked: true, lockedUntil: 1_000_000 })
    expect(applyAgentMessage(p, { type: 'result', id: 'other', ok: true })).toBe(p)
    expect(applyAgentMessage(p, { type: 'result', id: 'r1', ok: true })).toBeNull()
    expect(applyAgentMessage(p, { type: 'done', id: 'r1' })).toBeNull()
  })
  it('PAM text (fingerprint, faillock) is shown on the prompt', () => {
    const p = applyAgentMessage(applyAgentMessage(null, REQ), { type: 'info', id: 'r1', text: 'Place your finger on the reader', error: false })
    expect(p?.info).toEqual({ text: 'Place your finger on the reader', error: false })
  })
  it('splits the stream into messages and drops junk', () => {
    const got: unknown[] = []
    const feed = lineParser((m) => got.push(m))
    feed('{"type":"done","id":"a"}\nnot json\n{"ty')
    feed('pe":"info","id":"a","text":"x"}\n[1]\n')
    expect(got).toEqual([{ type: 'done', id: 'a' }, { type: 'info', id: 'a', text: 'x' }])
  })
})

describe('polkit bridge', () => {
  it('relays the prompt to the shell and the password and cancel back to the agent', () => {
    const handlers: Record<string, (...a: string[]) => unknown> = {}
    const sent: (PolkitPrompt | null)[] = []
    const written: string[] = []
    const sock = Object.assign(new EventEmitter(), { destroyed: false, setEncoding: vi.fn(), write: (s: string) => { written.push(s); return true } })
    startPolkitBridge((c, fn) => { handlers[c] = fn }, (_c, p) => sent.push(p as PolkitPrompt | null), () => sock as unknown as net.Socket)
    sock.emit('connect')
    sock.emit('data', JSON.stringify(REQ) + '\n')
    expect(handlers['ws:polkitState']()).toMatchObject({ id: 'r1' })
    expect(handlers['ws:polkitRespond']('wrong-id', 'pw')).toBe(false)
    expect(handlers['ws:polkitRespond']('r1', 'secret')).toBe(true)
    expect(JSON.parse(written[0])).toEqual({ type: 'respond', id: 'r1', password: 'secret' })
    expect(sent.at(-1)).toMatchObject({ busy: true })
    sock.emit('data', JSON.stringify({ type: 'result', id: 'r1', ok: false, remaining: null, locked: true, locked_until: Date.now() + 60_000, deny: 5, unlock_time: 300 }) + '\n')
    expect(handlers['ws:polkitRespond']('r1', 'again')).toBe(false) // locked: nothing is sent
    expect(written).toHaveLength(1)
    expect(handlers['ws:polkitCancel']('r1')).toBe(true)
    expect(JSON.parse(written[1])).toEqual({ type: 'cancel', id: 'r1' })
    expect(sent.at(-1)).toBeNull()
  })
})

import { describe, expect, it } from 'vitest'
import { parseSession, remoteSupportBridge, type RsDeps } from './remoteSupport'

const SESSION = { session_id: '7d1b3c1e-4b1a-4c55-9a77-3f1d2b9e0c11', state: 'pending', mode: 'control', reason: 'Printer', admin_name: 'Alice', org_name: 'Org A', consent: null, granted_mode: null, requested_at: 1, started_at: null, expires_at: 2 }

function deps(files: Record<string, string>, reply: (line: string) => string = () => '{"result":null}', uid = 1000) {
  const sent: string[] = []
  const d: RsDeps = { uid, async read(p) { return files[p] ?? null }, async call(_p, line) { sent.push(line); return reply(line) } }
  return { d, sent }
}

describe('remote support bridge (issue #19)', () => {
  it('reads the published session; anything else is no session', async () => {
    expect(parseSession(JSON.stringify(SESSION))?.admin_name).toBe('Alice')
    for (const bad of [null, '', 'nope', '{}', JSON.stringify({ ...SESSION, state: 'ended' }), JSON.stringify({ ...SESSION, mode: 'root' })]) expect(parseSession(bad)).toBeNull()
    const { d } = deps({ '/r/remote-support.json': JSON.stringify(SESSION) })
    expect((await remoteSupportBridge(d, '/r').state())?.session_id).toBe(SESSION.session_id)
  })
  it('sends the seat user nonce with the decision, read in the main process', async () => {
    const { d, sent } = deps({ '/r/consent/1000': 'n0nce\n' }, () => JSON.stringify({ result: { ...SESSION, state: 'active', granted_mode: 'view', consent: 'user' } }))
    const b = remoteSupportBridge(d, '/r')
    const r = await b.decide('view')
    expect(r.ok && r.value?.state).toBe('active')
    expect(JSON.parse(sent[0])).toEqual({ method: 'Decide', params: { nonce: 'n0nce', decision: 'view' } })
    expect(await b.decide('sudo')).toEqual({ ok: false, error: 'invalid_argument' })
  })
  it('no nonce for this user = no pending request; agent errors pass through; End and RevokeControl need no nonce', async () => {
    const { d, sent } = deps({}, (l) => (l.includes('End') ? '{"result":null}' : '{"error":"BAD_NONCE"}'))
    const b = remoteSupportBridge(d, '/r')
    expect(await b.decide('control')).toEqual({ ok: false, error: 'NO_PENDING_REQUEST' })
    expect(sent).toEqual([])
    expect(await b.end()).toEqual({ ok: true, value: null })
    expect(JSON.parse(sent[0])).toEqual({ method: 'End' })
    expect(await b.revokeControl()).toEqual({ ok: false, error: 'BAD_NONCE' })
  })
  it('agent not running', async () => {
    const d: RsDeps = { uid: 1000, async read() { return 'x' }, async call() { throw new Error('ENOENT') } }
    expect(await remoteSupportBridge(d, '/r').end()).toEqual({ ok: false, error: 'service_unavailable' })
  })
})

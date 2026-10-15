import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs'
import { createServer, type Server } from 'node:net'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { brokerCall, publicAccounts } from './broker'
import { serverUrlFor } from '../src/lib/os'

describe('broker client', () => {
  let dir: string
  let server: Server
  const seen: unknown[] = []

  beforeEach(async () => {
    dir = mkdtempSync(path.join(tmpdir(), 'ws-shell-'))
    process.env.XDG_RUNTIME_DIR = dir
    mkdirSync(path.join(dir, 'worksuite'))
    server = createServer((s) => s.on('data', (d) => {
      const req = JSON.parse(String(d))
      seen.push(req)
      s.write(JSON.stringify(req.method === 'Status' ? { result: [{ id: 'a', name: 'H', server_url: 'https://x', sub: 'secret-sub', state: 'signed_in' }] } : { error: 'sign_in_timeout' }) + '\n')
    }))
    await new Promise<void>((r) => server.listen(path.join(dir, 'worksuite', 'credentials.sock'), r))
  })
  afterEach(() => { server.close(); rmSync(dir, { recursive: true, force: true }) })

  it('sends one JSON line and maps result and error replies', async () => {
    const ok = await brokerCall('Status')
    expect(ok.ok).toBe(true)
    expect(await brokerCall('SignIn', { server_url: 'https://x' })).toEqual({ ok: false, error: 'sign_in_timeout' })
    expect(seen.at(-1)).toEqual({ method: 'SignIn', params: { server_url: 'https://x' } })
  })

  it('reports an unreachable broker instead of throwing', async () => {
    server.close()
    rmSync(path.join(dir, 'worksuite', 'credentials.sock'), { force: true })
    expect(await brokerCall('Status')).toEqual({ ok: false, error: 'broker_unavailable' })
  })

  it('passes only public account fields to the renderer', async () => {
    const r = await brokerCall('Status')
    expect(r.ok && publicAccounts(r.value)).toEqual([{ id: 'a', name: 'H', server_url: 'https://x', state: 'signed_in' }])
  })
})

describe('serverUrlFor', () => {
  it('uses WorkSuite Cloud for personal mode and https for bare hosts', () => {
    expect(serverUrlFor('personal', 'ignored')).toBe('https://worksuitecloud.com')
    expect(serverUrlFor('enterprise', ' work.livezentech.com ')).toBe('https://work.livezentech.com')
    expect(serverUrlFor('enterprise', 'http://x')).toBe('http://x')
  })
})

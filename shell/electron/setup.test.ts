import { describe, expect, it } from 'vitest'
import { setupClient, type Exec } from './setup'

const fake = (reply: { code?: number; stdout?: string; stderr?: string }) => {
  const calls: string[][] = []
  const exec: Exec = async (cmd, args) => { calls.push([cmd, ...args]); return { code: 0, stdout: '', stderr: '', ...reply } }
  return { exec, calls }
}

describe('setup client', () => {
  it('treats SetAnswer’s empty reply as success: busctl prints nothing for a method with no return value', async () => {
    const f = fake({ stdout: '' })
    expect(await setupClient(f.exec).answer('keyboard', 'us')).toEqual({ ok: true, value: true })
    expect(f.calls[0].slice(-4)).toEqual(['SetAnswer', 'ss', 'keyboard', '"us"'])
  })
  it('parses JSON replies and maps errors', async () => {
    expect(await setupClient(fake({ stdout: '{"type":"s","data":["{\\"ok\\":true}"]}' }).exec).send({ type: 'NEXT' })).toEqual({ ok: true, value: { ok: true } })
    expect(await setupClient(fake({ code: 1, stderr: 'Call failed: Not authorized\n' }).exec).send({ type: 'NEXT' })).toEqual({ ok: false, error: 'not_authorized' })
    expect(await setupClient(fake({ stdout: 'garbage' }).exec).state()).toEqual({ ok: false, error: 'failed' })
  })
})

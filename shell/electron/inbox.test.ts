import { mkdtempSync, readdirSync, statSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { viaInbox } from './inbox'

describe('viaInbox (picked files reach the package service through its inbox)', () => {
  it('copies the file in under a random name, private to the person, and removes it after the call', async () => {
    const t = mkdtempSync(path.join(os.tmpdir(), 'wsi-')), inbox = mkdtempSync(path.join(os.tmpdir(), 'wsin-'))
    const src = path.join(t, 'worksuite-os-1.0.1.wsupdate'); writeFileSync(src, 'bundle')
    let seen = ''
    const r = await viaInbox(src, '.wsupdate', async (p) => { seen = p; return { ok: true, mode: statSync(p).mode & 0o777, n: readdirSync(inbox).length } }, { dir: inbox })
    expect(r).toEqual({ ok: true, mode: 0o600, n: 1 })
    expect(path.dirname(seen)).toBe(inbox)
    expect(path.basename(seen)).toMatch(/^[0-9a-f-]{36}\.wsupdate$/)
    expect(readdirSync(inbox)).toEqual([])
  })
  it('removes the copy when the call throws, and reports a failed copy without calling the service', async () => {
    const t = mkdtempSync(path.join(os.tmpdir(), 'wsi-')), inbox = mkdtempSync(path.join(os.tmpdir(), 'wsin-'))
    const src = path.join(t, 'a.deb'); writeFileSync(src, 'deb')
    await expect(viaInbox(src, '.deb', async () => { throw new Error('boom') }, { dir: inbox })).rejects.toThrow('boom')
    expect(readdirSync(inbox)).toEqual([])
    let called = false
    expect(await viaInbox(path.join(t, 'missing.deb'), '.deb', async () => { called = true }, { dir: inbox })).toEqual({ ok: false, error: 'inbox_failed' })
    expect(called).toBe(false)
  })
})

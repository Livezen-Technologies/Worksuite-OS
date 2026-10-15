// WSOS-DRV-003: Drive documents open in Office under the server file lock.
import { describe, expect, it } from 'vitest'
import { isOfficeDoc, officeLockFiles, openWithLock, type OfficeLockDeps } from './officeLock'

function deps(lockReply: { ok: true; value: unknown } | { ok: false; error: string }, opts: { exitNow?: boolean; lockFileFor?: number } = {}) {
  const calls: string[] = []
  let polls = 0
  const d: OfficeLockDeps = {
    async syncCall(m, p) { calls.push(`${m} ${String(p.path)}`); return m === 'LockFile' ? lockReply : { ok: true, value: true } },
    launch: (f) => { calls.push(`launch ${f}`); return opts.exitNow ? Promise.resolve() : new Promise(() => {}) },
    exists: (p) => p.endsWith('.~lock.Q3.docx#') && polls < (opts.lockFileFor ?? 0),
    copyReadOnly: (f) => `/tmp/ro/${f.split('/').pop()}`,
    sleep: () => new Promise<void>((r) => { polls++; setTimeout(r, 1) }),
    pollMs: 1,
  }
  return { d, calls, polls: () => polls }
}

describe('Office file lock', () => {
  it('recognises office documents and their editor lock files', () => {
    expect(['a.docx', 'b.XLSX', 'c.odp', 'd.pdf', 'e.txt'].map(isOfficeDoc)).toEqual([true, true, true, false, false])
    expect(officeLockFiles('/h/Drive/Reports/Q3.docx')).toEqual(['/h/Drive/Reports/.~lock.Q3.docx#', '/h/Drive/Reports/~$Q3.docx'])
  })
  it('holds the lock while Office runs or keeps its lock file, then releases it', async () => {
    const { d, calls } = deps({ ok: true, value: { ok: true, lock_id: 'L' } }, { exitNow: true, lockFileFor: 3 })
    const r = await openWithLock('Reports/Q3.docx', '/h/Drive/Reports/Q3.docx', d)
    expect(r.outcome).toBe('locked_and_open')
    await r.released
    expect(calls).toEqual(['LockFile Reports/Q3.docx', 'launch /h/Drive/Reports/Q3.docx', 'UnlockFile Reports/Q3.docx'])
  })
  it('never releases while our Office process is still running', async () => {
    const { d, calls, polls } = deps({ ok: true, value: { ok: true, lock_id: 'L' } })
    const r = await openWithLock('Reports/Q3.docx', '/h/Drive/Reports/Q3.docx', d)
    await new Promise((x) => setTimeout(x, 10))
    expect(polls()).toBeGreaterThan(1)
    expect(calls).not.toContain('UnlockFile Reports/Q3.docx')
    void r
  })
  it('opens a read-only copy when someone else holds the lock', async () => {
    const { d, calls } = deps({ ok: true, value: { ok: false, error: 'locked' } })
    expect((await openWithLock('Reports/Q3.docx', '/h/Drive/Reports/Q3.docx', d)).outcome).toBe('read_only_copy')
    expect(calls).toEqual(['LockFile Reports/Q3.docx', 'launch /tmp/ro/Q3.docx'])
  })
  it('opens normally when the lock cannot be taken (offline, not synced yet, no sync service)', async () => {
    for (const reply of [{ ok: true as const, value: { ok: false, error: 'offline' } }, { ok: false as const, error: 'broker_unavailable' }]) {
      const { d, calls } = deps(reply)
      expect((await openWithLock('Reports/Q3.docx', '/h/Drive/Reports/Q3.docx', d)).outcome).toBe('opened_unlocked')
      expect(calls).toEqual(['LockFile Reports/Q3.docx', 'launch /h/Drive/Reports/Q3.docx'])
    }
  })
})

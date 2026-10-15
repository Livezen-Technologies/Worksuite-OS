import { describe, expect, it } from 'vitest'
import { diffStatus, type SyncStatus } from './syncNotices'

const s = (o: Partial<SyncStatus>): SyncStatus => ({ state: 'idle', pending: 0, failed: 0, conflicts: 0, last_sync: 1, ...o })

describe('diffStatus', () => {
  it('says nothing on the first snapshot or when nothing changed', () => {
    expect(diffStatus(null, s({ state: 'offline', pending: 5 }))).toEqual([])
    expect(diffStatus(s({}), s({}))).toEqual([])
  })
  it('reports coming back online with the number of changes sent', () => {
    expect(diffStatus(s({ state: 'offline', pending: 14 }), s({ state: 'idle', pending: 0 })).map((x) => x.title)).toEqual(['Back online — 14 changes synced'])
    expect(diffStatus(s({ state: 'offline', pending: 1 }), s({ state: 'idle', pending: 0 }))[0].title).toBe('Back online — 1 change synced')
  })
  it('reports new failures, conflicts, sign-in needed and revocation once', () => {
    const titles = diffStatus(s({ failed: 1, conflicts: 0 }), s({ state: 'auth_required', failed: 3, conflicts: 1 })).map((x) => x.title)
    expect(titles).toEqual(['2 changes couldn’t be saved', '1 conflict — both versions kept', 'Sign in again to keep syncing'])
    expect(diffStatus(s({ state: 'auth_required' }), s({ state: 'auth_required' }))).toEqual([])
    expect(diffStatus(s({}), s({ state: 'device_revoked' }))[0].tone).toBe('error')
  })
})

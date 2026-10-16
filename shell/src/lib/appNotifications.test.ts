import { describe, expect, it } from 'vitest'
import { appIdOf, mergeApp, type AppNotification } from './appNotifications'

const n = (id: number, at = 1, summary = `s${id}`): AppNotification => ({ id, app: 'Mail', summary, body: 'b', actions: [], urgency: 1, at })
const sync = { id: 'failed-1-x', tone: 'error' as const, title: 'Sync', body: '', at: 0 }

describe('app notifications in the centre (WSOS-INT-007)', () => {
  it('adds new ones on top next to sync notices, drops closed ones, re-surfaces replaced ones', () => {
    let r = mergeApp([sync], [n(1), n(2)])
    expect(r.fresh.map((f) => f.id)).toEqual(['app-1', 'app-2'])
    expect(r.next.map((x) => x.id)).toEqual(['app-1', 'app-2', 'failed-1-x'])
    r = mergeApp(r.next, [n(2)])
    expect(r.fresh).toEqual([])
    expect(r.next.map((x) => x.id)).toEqual(['app-2', 'failed-1-x'])
    r = mergeApp(r.next, [n(2, 9, 'updated')])
    expect(r.fresh.map((f) => f.title)).toEqual(['updated'])
    expect(r.next.map((x) => x.id)).toEqual(['app-2', 'failed-1-x'])
    expect(r.next[0]).toMatchObject({ app: 'Mail' })
    expect(appIdOf(r.next[0])).toBe(2)
    expect(appIdOf(sync)).toBeNull()
  })
})

import { describe, expect, it } from 'vitest'
import { KEY_LENGTH, defaultSnapshot, emptyKey, fillKeyGroups, formatKey, initialChecks, initialRecovery, keyComplete, keyProblem,
  normalizeKeyChars, recoveryReducer, repairPercent, repairSummary, snapshotDesc, snapshotWhen, type CheckRow, type SnapshotInfo } from './recovery'

const KEY = '7K2QF-ABCDE-01234-56789-VWXYZ-HJKMN-PQRST-GGGGG'

describe('recovery key', () => {
  it('normalizes look-alikes and drops separators', () => {
    expect(normalizeKeyChars('7k2qf-o i l u!')).toBe('7K2QF011')
  })
  it('fills one group and moves focus when it is full', () => {
    const r = fillKeyGroups(emptyKey(), 0, '7k2qf')
    expect(r.groups[0]).toBe('7K2QF')
    expect(r.focus).toBe(1)
    expect(fillKeyGroups(emptyKey(), 2, 'ab').focus).toBe(2)
  })
  it('spreads a pasted key across all groups', () => {
    const r = fillKeyGroups(emptyKey(), 0, KEY.toLowerCase())
    expect(formatKey(r.groups)).toBe(KEY)
    expect(r.focus).toBe(7)
    expect(keyComplete(r.groups)).toBe(true)
    expect(keyProblem(r.groups)).toBeNull()
  })
  it('reports incomplete keys by count only', () => {
    expect(keyProblem(emptyKey())).toBe('Enter your recovery key.')
    const g = fillKeyGroups(emptyKey(), 0, KEY.slice(0, 11)).groups
    expect(keyProblem(g)).toBe(`The recovery key has ${KEY_LENGTH} characters. 10 entered so far.`)
    expect(keyComplete(['AAAAA'])).toBe(false)
  })
})

describe('startup repair', () => {
  const rows = (states: CheckRow['state'][]): CheckRow[] => initialChecks().map((r, i) => ({ ...r, state: states[i] }))
  it('progress counts finished checks', () => {
    expect(repairPercent(initialChecks())).toBe(0)
    expect(repairPercent(rows(['ok', 'fixed', 'active', 'wait', 'wait', 'wait']))).toBe(33)
    expect(repairPercent(rows(['ok', 'ok', 'ok', 'ok', 'unavailable', 'problem']))).toBe(100)
  })
  it('summarizes fixed and remaining problems', () => {
    expect(repairSummary(rows(['ok', 'fixed', 'ok', 'fixed', 'unavailable', 'ok'])).title).toBe('Your system is fixed')
    expect(repairSummary(rows(['ok', 'fixed', 'ok', 'fixed', 'unavailable', 'ok'])).text).toContain('fixed 2 problems')
    expect(repairSummary(rows(['ok', 'ok', 'ok', 'ok', 'ok', 'ok'])).title).toBe('No problems found')
    const bad = repairSummary(rows(['problem', 'fixed', 'ok', 'ok', 'ok', 'ok']))
    expect([bad.title, bad.problems, bad.fixed]).toEqual(['Some problems remain', 1, 1])
  })
})

describe('snapshots', () => {
  const now = new Date(2026, 9, 15, 10, 0)
  const s = (id: string, d: Date, last = false): SnapshotInfo => ({ id, title: id, created: d.getTime(), kind: 'automatic', os_version: '1.0', last_working: last })
  it('formats dates like the board', () => {
    expect(snapshotDesc(s('a', new Date(2026, 9, 15, 2, 3)), now)).toBe('Today, 02:03 · automatic')
    expect(snapshotDesc(s('a', new Date(2026, 9, 11, 3, 0)), now)).toBe('Sun 11 Oct, 03:00 · automatic')
    expect(snapshotWhen(s('a', new Date(2026, 9, 15, 2, 3)), now)).toBe('02:03 today')
    expect(snapshotWhen(s('a', new Date(2026, 9, 8, 14, 22)), now)).toBe('8 Oct')
  })
  it('preselects the last working snapshot, else the newest', () => {
    expect(defaultSnapshot([s('old', new Date(2026, 0, 1)), s('lw', new Date(2025, 0, 1), true)])).toBe('lw')
    expect(defaultSnapshot([s('old', new Date(2026, 0, 1)), s('new', new Date(2026, 5, 1))])).toBe('new')
    expect(defaultSnapshot([])).toBeNull()
  })
})

describe('screen state', () => {
  it('opens tools from the menu only and finishes into done', () => {
    let st = recoveryReducer(initialRecovery, { type: 'open', screen: 'repair' })
    expect(st.screen).toBe('repair')
    expect(recoveryReducer(st, { type: 'open', screen: 'reset' }).screen).toBe('repair')
    st = recoveryReducer(st, { type: 'finish', done: { title: 't', text: '', ok: true, rows: [] } })
    expect(st.screen).toBe('done')
    expect(recoveryReducer(st, { type: 'back' })).toEqual(initialRecovery)
    expect(recoveryReducer(initialRecovery, { type: 'finish', done: { title: 't', text: '', ok: true, rows: [] } })).toBe(initialRecovery)
  })
})

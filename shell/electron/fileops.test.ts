import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { freeName, jobs, mkdirIn, recent, renameIn, search, setStar, starredHits, trash, trashDelete, trashList, trashRestore, type JobEvent } from './fileops'

describe('fileops', () => {
  let home: string
  const env = () => ({ home, user: 'nobody-test' })
  beforeEach(() => {
    home = mkdtempSync(path.join(tmpdir(), 'ws-fo-'))
    mkdirSync(path.join(home, 'Documents', 'Projects'), { recursive: true })
    mkdirSync(path.join(home, 'Backup'))
    writeFileSync(path.join(home, 'Documents', 'Budget 2027.xlsx'), 'new!')
    writeFileSync(path.join(home, 'Documents', 'Projects', 'Marketing budget.xlsx'), 'm')
    writeFileSync(path.join(home, 'Documents', 'notes.md'), 'n')
    writeFileSync(path.join(home, 'Backup', 'Budget 2027.xlsx'), 'old')
  })
  afterEach(() => rmSync(home, { recursive: true, force: true }))

  it('searches names below a folder, with type filters', async () => {
    const r = await search(env(), 'home', '', 'budget', 'any', 0)
    expect(r.ok && r.value.hits.map((h) => [h.name, h.where]).sort()).toEqual([['Budget 2027.xlsx', '~/Backup'], ['Budget 2027.xlsx', '~/Documents'], ['Marketing budget.xlsx', '~/Documents/Projects']])
    const d = await search(env(), 'home', 'Documents', 'budget', 'documents', 0)
    expect(d.ok && d.value.hits).toEqual([])
  })

  it('creates and renames inside the root only', async () => {
    expect(mkdirIn(env(), 'home', 'Documents', 'Invoices')).toEqual({ ok: true, value: 'Documents/Invoices' })
    expect(mkdirIn(env(), 'home', 'Documents', '../x').ok).toBe(false)
    expect(await renameIn(env(), 'home', 'Documents/notes.md', 'Meeting notes.md')).toEqual({ ok: true, value: 'Documents/Meeting notes.md' })
    expect((await renameIn(env(), 'home', 'Documents/Meeting notes.md', 'Budget 2027.xlsx')).ok).toBe(false)
  })

  it('moves to the freedesktop Trash, lists, restores and deletes', async () => {
    expect(await trash(env(), 'home', ['Documents/notes.md', 'Documents/Projects'])).toEqual({ ok: true, value: 2 })
    expect(existsSync(path.join(home, 'Documents', 'notes.md'))).toBe(false)
    const items = await trashList(env())
    expect(items.map((i) => [i.name, i.where, i.dir]).sort()).toEqual([['Projects', '~/Documents', true], ['notes.md', '~/Documents', false]])
    expect(readFileSync(path.join(home, '.local/share/Trash/info/notes.md.trashinfo'), 'utf8')).toMatch(/^\[Trash Info\]\nPath=.*\/Documents\/notes.md\nDeletionDate=\d{4}-/)
    expect(await trashRestore(env(), ['notes.md'])).toEqual({ ok: true, value: { restored: 1, skipped: 0 } })
    expect(readFileSync(path.join(home, 'Documents', 'notes.md'), 'utf8')).toBe('n')
    expect(await trashDelete(env(), 'all')).toEqual({ ok: true, value: 1 })
    expect(await trashList(env())).toEqual([])
  })

  it('stars items and reads Recent from recently-used.xbel', () => {
    setStar(env(), 'home', 'Documents/notes.md', true)
    expect(starredHits(env()).map((h) => h.name)).toEqual(['notes.md'])
    mkdirSync(path.join(home, '.local/share'), { recursive: true })
    writeFileSync(path.join(home, '.local/share/recently-used.xbel'), `<xbel><bookmark href="file://${encodeURI(path.join(home, 'Documents/Budget 2027.xlsx'))}" modified="2026-10-15T10:00:00Z"/><bookmark href="file:///etc/passwd" modified="2026-10-15T11:00:00Z"/></xbel>`)
    expect(recent(env()).map((h) => [h.rel, h.where])).toEqual([['Documents/Budget 2027.xlsx', '~/Documents']])
  })

  it('copies with a conflict prompt; "keep both" picks a free name', async () => {
    expect(freeName(path.join(home, 'Backup'), 'Budget 2027.xlsx')).toBe('Budget 2027 (2).xlsx')
    const events: JobEvent[] = []
    const done = new Promise<void>((resolve) => {
      const j = jobs(env(), (e) => {
        events.push(e)
        if (e.state === 'conflict') j.resolve(e.id, 'keep', false)
        if (e.state === 'done') resolve()
      })
      j.start('copy', 'home', ['Documents/Budget 2027.xlsx', 'Documents/notes.md'], 'home', 'Backup')
    })
    await done
    const c = events.find((e) => e.state === 'conflict')
    expect(c?.conflict).toMatchObject({ name: 'Budget 2027.xlsx', incoming: { size: 4 }, existing: { size: 3 }, remaining: 0 })
    expect(readFileSync(path.join(home, 'Backup', 'Budget 2027.xlsx'), 'utf8')).toBe('old')
    expect(readFileSync(path.join(home, 'Backup', 'Budget 2027 (2).xlsx'), 'utf8')).toBe('new!')
    expect(events.at(-1)).toMatchObject({ state: 'done', done: 2, total: 2 })
  })
})

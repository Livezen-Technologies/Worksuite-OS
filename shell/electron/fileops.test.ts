import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { deviceInfo, errCode, freeName, jobs, mkdirIn, removeIn, recent, renameIn, search, setStar, starredHits, trash, trashDelete, trashList, trashRestore, type JobEvent } from './fileops'

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

  it('Undo after Delete restores from the .trashinfo files, whatever else is in the Trash', async () => {
    writeFileSync(path.join(home, 'Documents', 'ශ්‍රී 100% #1.txt'), 's')
    const r = await trash(env(), 'home', ['Documents/ශ්‍රී 100% #1.txt', 'Documents/Projects'])
    expect(r.ok).toBe(true)
    const ids = r.ok ? r.value.ids : []
    // Another app's broken entry (unreadable info, a folder where a file should be) used to make the whole restore fail.
    mkdirSync(path.join(home, '.local/share/Trash/info/broken.trashinfo'))
    writeFileSync(path.join(home, '.local/share/Trash/info/nofile.trashinfo'), '[Trash Info]\nPath=/etc/passwd\n')
    expect(await trashRestore(env(), ids)).toEqual({ ok: true, value: { restored: 2, skipped: 0 } })
    expect(readFileSync(path.join(home, 'Documents', 'ශ්‍රී 100% #1.txt'), 'utf8')).toBe('s')
    expect(readFileSync(path.join(home, 'Documents', 'Projects', 'Marketing budget.xlsx'), 'utf8')).toBe('m')
    expect(existsSync(path.join(home, '.local/share/Trash/info/Projects.trashinfo'))).toBe(false)
    // Same name trashed twice: each Undo restores its own copy, and never over a file that came back meanwhile.
    const a = await trash(env(), 'home', ['Documents/notes.md'])
    writeFileSync(path.join(home, 'Documents', 'notes.md'), 'second')
    const b = await trash(env(), 'home', ['Documents/notes.md'])
    expect(a.ok && b.ok && a.value.ids[0] !== b.value.ids[0]).toBe(true)
    expect(await trashRestore(env(), b.ok ? b.value.ids : [])).toEqual({ ok: true, value: { restored: 1, skipped: 0 } })
    expect(readFileSync(path.join(home, 'Documents', 'notes.md'), 'utf8')).toBe('second')
    expect(await trashRestore(env(), a.ok ? a.value.ids : [])).toEqual({ ok: true, value: { restored: 0, skipped: 1 } })
    // Outside the places Files writes to, or a made-up id: skipped.
    writeFileSync(path.join(home, '.local/share/Trash/files/nofile'), 'x')
    expect(await trashRestore(env(), ['nofile', '../x', 'missing'])).toEqual({ ok: true, value: { restored: 0, skipped: 3 } })
  })

  it('moves to the freedesktop Trash, lists, restores and deletes', async () => {
    expect(await trash(env(), 'home', ['Documents/notes.md', 'Documents/Projects'])).toEqual({ ok: true, value: { count: 2, ids: ['notes.md', 'Projects'] } })
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

  it('pauses and resumes a job, and reports the source, free space and the file being copied', async () => {
    const events: JobEvent[] = []
    let paused = false
    const done = new Promise<void>((resolve) => {
      const j = jobs(env(), (e) => {
        events.push(e)
        if (e.state === 'conflict') j.resolve(e.id, 'skip', false)
        if (e.state === 'paused' && !paused) { paused = true; setTimeout(() => j.resolve(e.id, 'resume', false), 20) }
        if (e.state === 'done') resolve()
      })
      const r = j.start('copy', 'home', ['Documents/Budget 2027.xlsx', 'Documents/notes.md'], 'home', 'Backup')
      if (r.ok) j.resolve(r.value, 'pause', false)
    })
    await done
    expect(paused).toBe(true)
    expect(events[0]).toMatchObject({ src: '~/Documents', dest: '~/Backup', error: null })
    expect(typeof events[0].free).toBe('number')
    expect(events.at(-1)).toMatchObject({ state: 'done', current: null })
    expect(readFileSync(path.join(home, 'Backup', 'notes.md'), 'utf8')).toBeTruthy()
  })

  it('cancels a paused job', async () => {
    const last = await new Promise<JobEvent>((resolve) => {
      const j = jobs(env(), (e) => { if (e.state === 'paused') j.resolve(e.id, 'cancel', false); if (e.state === 'cancelled') resolve(e) })
      const r = j.start('copy', 'home', ['Documents/notes.md'], 'home', 'Backup')
      if (r.ok) j.resolve(r.value, 'pause', false)
    })
    expect(last.state).toBe('cancelled')
  })

  it('deletes permanently inside a root only', async () => {
    expect(await removeIn(env(), 'home', ['Documents/notes.md'])).toEqual({ ok: true, value: 1 })
    expect(existsSync(path.join(home, 'Documents/notes.md'))).toBe(false)
    expect(await removeIn(env(), 'home', ['../../etc/passwd', ''])).toEqual({ ok: false, error: 'not_found' })
  })

  it('maps errno codes to the reasons Files explains', () => {
    const e = (code: string) => Object.assign(new Error(code), { code })
    expect(['ENOSPC', 'EACCES', 'EROFS', 'EIO', 'EBUSY', 'ENOENT', 'EXDEV'].map((c) => errCode(e(c)))).toEqual(['no_space', 'permission', 'permission', 'io', 'busy', 'missing', 'failed'])
  })
})

describe('storage card device name', () => {
  it('marks a LUKS mapping as encrypted instead of showing luks-<uuid>', () => {
    const d = deviceInfo('/dev/mapper/luks-3f1c9a', {}, (p) => p)
    expect(d.encrypted).toBe(true)
    expect(d.label).toBe('')
  })
  it('uses the filesystem label when there is one', () => {
    expect(deviceInfo('/dev/vda2', { '/dev/vda2': 'WORKSUITE' }, (p) => p)).toEqual({ device: 'vda2', label: 'WORKSUITE', encrypted: false })
  })
})

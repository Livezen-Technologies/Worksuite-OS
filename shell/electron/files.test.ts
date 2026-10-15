import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { list, resolveIn, type FileEnv } from './files'

describe('files', () => {
  let home: string, outside: string
  let states: { name: string; state: string }[] | null
  const env = (): FileEnv => ({ home, user: 'nobody-test', fileStates: async () => states })

  beforeEach(() => {
    home = mkdtempSync(path.join(tmpdir(), 'ws-home-'))
    outside = mkdtempSync(path.join(tmpdir(), 'ws-out-'))
    writeFileSync(path.join(outside, 'secret'), 'x')
    mkdirSync(path.join(home, 'WorkSuite Drive', 'Tenders'), { recursive: true })
    writeFileSync(path.join(home, 'WorkSuite Drive', 'Tenders', 'proposal.docx'), 'abc')
    writeFileSync(path.join(home, 'WorkSuite Drive', 'Tenders', 'new.txt'), 'n')
    writeFileSync(path.join(home, '.hidden'), 'h')
    symlinkSync(outside, path.join(home, 'escape'))
    states = [{ name: 'proposal.docx', state: 'syncing' }, { name: 'tender.pdf', state: 'online-only' }]
  })
  afterEach(() => { rmSync(home, { recursive: true, force: true }); rmSync(outside, { recursive: true, force: true }) })

  it('refuses paths that leave the root, including through symlinks', () => {
    expect(resolveIn(env(), 'home', '../etc')).toBeNull()
    expect(resolveIn(env(), 'home', 'escape')).toBeNull()
    expect(resolveIn(env(), 'nope', '')).toBeNull()
    expect(resolveIn(env(), 'drive', 'Tenders')?.full).toBe(path.join(home, 'WorkSuite Drive', 'Tenders'))
  })

  it('merges Drive files on disk with their sync states and adds online-only items', async () => {
    const r = await list(env(), 'drive', 'Tenders')
    expect(r.ok && r.value.map((e) => [e.name, e.state, e.local])).toEqual([
      ['new.txt', 'pending', true], ['proposal.docx', 'syncing', true], ['tender.pdf', 'online-only', false],
    ])
  })

  it('marks Drive files "unknown" when the sync service is not running, and hides dotfiles at home', async () => {
    states = null
    const r = await list(env(), 'drive', 'Tenders')
    expect(r.ok && r.value.every((e) => e.state === 'unknown')).toBe(true)
    const h = await list(env(), 'home', '')
    const names = h.ok ? h.value.map((e) => e.name) : []
    expect(names).toContain('WorkSuite Drive')
    expect(names).not.toContain('.hidden')
    // A symlink is listed but not followed: it is not a folder you can enter.
    expect(h.ok && h.value.find((e) => e.name === 'escape')?.dir).toBe(false)
  })
})

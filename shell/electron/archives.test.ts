import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { spawn as realSpawn, spawnSync, type SpawnOptions } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { archiveJobs, archiveKind, findTools, listIn, locate, parse7z, parseTarList, stemOf, unescapeTar, unsafeEntry, unsafeTree, type ArchEntry, type ArchiveJobEvent, type Tools } from './archives'

let tools: Tools
const has = (b: keyof Tools) => !!tools?.[b]

describe('archives', () => {
  let home: string
  const env = () => ({ home, user: 'nobody-test' })
  const argvs: string[][] = []
  const spawn = (cmd: string, args: string[], opts: SpawnOptions) => { argvs.push([cmd, ...args]); return realSpawn(cmd, args, opts) }
  beforeEach(async () => {
    tools = await findTools()
    argvs.length = 0
    home = mkdtempSync(path.join(tmpdir(), 'ws-arc-'))
    mkdirSync(path.join(home, 'Documents', 'Project', 'sub'), { recursive: true })
    writeFileSync(path.join(home, 'Documents', 'Project', 'a.txt'), 'alpha\n')
    writeFileSync(path.join(home, 'Documents', 'Project', 'sub', 'b.txt'), 'beta\n'.repeat(1000))
    writeFileSync(path.join(home, 'Documents', 'notes.md'), '# notes\n')
  })
  afterEach(() => rmSync(home, { recursive: true, force: true }))

  /** Run a job to its end, answering prompts with `answer`. */
  const runJob = (start: (j: ReturnType<typeof archiveJobs>) => { ok: boolean; value?: string }, answer: (e: ArchiveJobEvent, j: ReturnType<typeof archiveJobs>) => void = () => undefined, limits = {}) =>
    new Promise<ArchiveJobEvent[]>((resolve) => {
      const seen: ArchiveJobEvent[] = []
      const j = archiveJobs(env(), (e) => {
        seen.push(e)
        if (['done', 'failed', 'cancelled'].includes(e.state)) resolve(seen)
        else if (['conflict', 'password', 'confirm'].includes(e.state)) setTimeout(() => answer(e, j), 0)
      }, { spawn, limits, pollMs: 20 })
      const r = start(j)
      expect(r.ok).toBe(true)
    })
  const last = (evs: ArchiveJobEvent[]) => evs[evs.length - 1]

  it('knows archive kinds and stems', () => {
    expect(['a.zip', 'b.7z', 'c.RAR', 'd.tar.gz', 'e.tgz', 'f.tar.zst', 'g.gz', 'h.xz', 'i.bz2', 'j.zst', 'k.txt', '.zip'].map(archiveKind))
      .toEqual(['zip', '7z', 'rar', 'tar.gz', 'tar.gz', 'tar.zst', 'gz', 'xz', 'bz2', 'zst', null, null])
    expect(stemOf('Report 2027.tar.gz')).toBe('Report 2027')
    expect(stemOf('log.txt.gz')).toBe('log.txt')
  })

  it('parses tool listings', () => {
    expect(parseTarList('-rw-r--r-- 0/0               6 2026-10-16 00:10 dir/a\\303\\251 b.txt\nlrwxrwxrwx 0/0 0 2026-10-16 00:10 l -> ../x\nhrw-r--r-- 0/0 0 2026-10-16 00:10 h link to dir/a\n', true)
      .map((e) => [e.path, e.type, e.size, e.link])).toEqual([['dir/aé b.txt', 'file', 6, null], ['l', 'symlink', 0, '../x'], ['h', 'hardlink', 0, 'dir/a']])
    expect(parseTarList('drwxr-xr-x  0 0      0           0 Oct 16 00:13 src/\n-rw-r--r--  0 0      0     3000000 Oct 16 00:13 src/big\n', false).map((e) => [e.path, e.type, e.size]))
      .toEqual([['src', 'dir', 0], ['src/big', 'file', 3000000]])
    expect(parse7z('x\n----------\nPath = a.txt\nFolder = -\nSize = 6\nEncrypted = +\nAttributes = A -rw-r--r--\n\nPath = d\nFolder = +\nSize = 0\n')
      .map((e) => [e.path, e.type, e.size, e.encrypted])).toEqual([['a.txt', 'file', 6, true], ['d', 'dir', 0, false]])
    expect(unescapeTar('a\\nb\\\\c')).toBe('a\nb\\c')
  })

  it('refuses zip-slip entries and links that leave the folder', () => {
    const e = (p: string, type: ArchEntry['type'] = 'file', link: string | null = null): ArchEntry => ({ path: p, type, size: 1, link, modified: null, encrypted: false })
    expect(unsafeEntry([e('a/b.txt'), e('a'), e('l', 'symlink', 'a/b.txt')])).toBeNull()
    expect(unsafeEntry([e('../evil')])).toBe('../evil')
    expect(unsafeEntry([e('a/../../evil')])).toBe('a/../../evil')
    expect(unsafeEntry([e('/etc/passwd')])).toBe('/etc/passwd')
    expect(unsafeEntry([e('l', 'symlink', '/etc')])).toBe('l')
    expect(unsafeEntry([e('a/l', 'symlink', '../../x')])).toBe('a/l')
    expect(unsafeEntry([e('l', 'symlink', 'a'), e('l/x')])).toBe('l/x')
    expect(unsafeEntry([e('dev', 'other')])).toBe('dev')
    const t = mkdtempSync(path.join(tmpdir(), 'ws-tree-'))
    mkdirSync(path.join(t, 'd')); symlinkSync('../d', path.join(t, 'd', 'ok'))
    expect(unsafeTree(t)).toBeNull()
    symlinkSync('../../etc', path.join(t, 'd', 'bad'))
    expect(unsafeTree(t)).toBe('d/bad')
    rmSync(t, { recursive: true, force: true })
  })

  for (const format of ['zip', '7z', 'tar.gz', 'tar.xz'] as const) {
    it(`compresses files and folders to ${format} and extracts them back`, async (ctx) => {
      if (format === '7z' && !has('sevenZ')) return ctx.skip()
      if (format === 'zip' && !has('sevenZ') && !has('zip')) return ctx.skip()
      if (format.startsWith('tar') && (!has('tar') || !has(format === 'tar.gz' ? 'gzip' : 'xz'))) return ctx.skip()
      const c = await runJob((j) => j.compress('home', ['Documents/Project', 'Documents/notes.md'], { format, name: 'Bundle', level: 5 }))
      expect(last(c)).toMatchObject({ state: 'done', error: null })
      expect(last(c).bytes_done).toBe(last(c).bytes_total)
      expect(existsSync(path.join(home, 'Documents', `Bundle.${format}`))).toBe(true)
      expect(readdirSync(path.join(home, 'Documents')).filter((n) => n.startsWith('.'))).toEqual([])
      const l = await listIn(env(), 'home', `Documents/Bundle.${format}`, null)
      expect(l.ok && l.value.entries.filter((e) => e.type === 'file').map((e) => e.path).sort()).toEqual(['Project/a.txt', 'Project/sub/b.txt', 'notes.md'])
      const x = await runJob((j) => j.extract('home', `Documents/Bundle.${format}`, 'folder', [], null))
      expect(last(x).state).toBe('done')
      expect(readFileSync(path.join(home, 'Documents', 'Bundle', 'Project', 'sub', 'b.txt'), 'utf8')).toBe('beta\n'.repeat(1000))
      expect(readdirSync(path.join(home, 'Documents')).filter((n) => n.startsWith('.'))).toEqual([])
      // One item only.
      const one = await runJob((j) => j.extract('home', `Documents/Bundle.${format}`, 'here', ['Project/sub'], null), (e, j) => j.resolve(e.id, 'replace', true))
      expect(last(one)).toMatchObject({ state: 'done', total: 1 })
      expect(one.filter((e) => e.state === 'conflict')).toHaveLength(1)
      expect(existsSync(path.join(home, 'Documents', 'Project', 'sub', 'b.txt'))).toBe(true)
    })
  }

  it('asks on conflicts when extracting: replace, skip and keep both', async (ctx) => {
    if (!has('tar') || !has('gzip')) return ctx.skip()
    spawnSync('tar', ['-czf', path.join(home, 'Documents', 'p.tar.gz'), '-C', path.join(home, 'Documents'), 'Project'])
    writeFileSync(path.join(home, 'Documents', 'Project', 'a.txt'), 'local')
    const keep = await runJob((j) => j.extract('home', 'Documents/p.tar.gz', 'here', [], null), (e, j) => j.resolve(e.id, e.conflict?.name === 'a.txt' ? 'keep' : 'replace', false))
    expect(last(keep).state).toBe('done')
    expect(readFileSync(path.join(home, 'Documents', 'Project', 'a.txt'), 'utf8')).toBe('local')
    expect(readFileSync(path.join(home, 'Documents', 'Project', 'a (2).txt'), 'utf8')).toBe('alpha\n')
    const skip = await runJob((j) => j.extract('home', 'Documents/p.tar.gz', 'here', [], null), (e, j) => j.resolve(e.id, 'skip', true))
    expect(skip.filter((e) => e.state === 'conflict')).toHaveLength(1)
    expect(last(skip).state).toBe('done')
  })

  it('refuses archives with traversal entries and cleans up', async (ctx) => {
    if (!has('tar')) return ctx.skip()
    const evil = path.join(home, 'Documents', 'evil.tar')
    writeFileSync(path.join(home, 'x.txt'), 'outside')
    spawnSync('tar', ['-cf', evil, '-C', path.join(home, 'Documents'), '--transform', 's,^notes.md,../../pwned.txt,', '-P', 'notes.md'])
    const r = await runJob((j) => j.extract('home', 'Documents/evil.tar', 'here', [], null))
    expect(last(r)).toMatchObject({ state: 'failed', error: 'unsafe' })
    expect(existsSync(path.join(home, 'pwned.txt'))).toBe(false)
    expect(existsSync(path.join(path.dirname(home), 'pwned.txt'))).toBe(false)
    // A link out of the folder, then a file through it.
    const ln = path.join(home, 'stage'); mkdirSync(ln); symlinkSync(home, path.join(ln, 'out'))
    spawnSync('tar', ['-cf', path.join(home, 'Documents', 'link.tar'), '-C', ln, 'out'])
    expect(last(await runJob((j) => j.extract('home', 'Documents/link.tar', 'here', [], null)))).toMatchObject({ state: 'failed', error: 'unsafe' })
    expect(readdirSync(path.join(home, 'Documents')).filter((n) => n.startsWith('.'))).toEqual([])
  })

  it('asks before an archive bomb and stops when declined', async (ctx) => {
    if (!has('tar') || !has('gzip')) return ctx.skip()
    writeFileSync(path.join(home, 'Documents', 'zeros.bin'), Buffer.alloc(4 * 1024 * 1024))
    spawnSync('tar', ['-czf', path.join(home, 'Documents', 'z.tar.gz'), '-C', path.join(home, 'Documents'), 'zeros.bin'])
    rmSync(path.join(home, 'Documents', 'zeros.bin'))
    const limits = { bytes: 1024 * 1024, ratio: 100, ratioFrom: 1024 }
    const no = await runJob((j) => j.extract('home', 'Documents/z.tar.gz', 'here', [], null), (e, j) => j.resolve(e.id, 'cancel', false), limits)
    expect(no.some((e) => e.state === 'confirm' && e.ask?.bytes === 4 * 1024 * 1024)).toBe(true)
    expect(last(no).state).toBe('cancelled')
    expect(existsSync(path.join(home, 'Documents', 'zeros.bin'))).toBe(false)
    const yes = await runJob((j) => j.extract('home', 'Documents/z.tar.gz', 'here', [], null), (e, j) => j.resolve(e.id, 'continue', false), limits)
    expect(last(yes).state).toBe('done')
    // A single gzip stream has no declared size: it is paused past the limit.
    spawnSync('sh', ['-c', `head -c 8388608 /dev/zero | gzip -c > "${path.join(home, 'Documents', 'big.gz')}"`])
    const s = await runJob((j) => j.extract('home', 'Documents/big.gz', 'here', [], null), (e, j) => j.resolve(e.id, 'cancel', false), limits)
    expect(s.some((e) => e.state === 'confirm' && e.ask?.bytes === null)).toBe(true)
    expect(last(s).state).toBe('cancelled')
    expect(existsSync(path.join(home, 'Documents', 'big'))).toBe(false)
  })

  for (const format of ['zip', '7z'] as const) {
    it(`encrypts ${format} with a password that never reaches argv, and asks for it on extraction`, async (ctx) => {
      if (!has('sevenZ')) return ctx.skip()
      const secret = format === 'zip' ? 'S3cr3t pass-word!' : 'S3cr3t-pässword'
      if (format === 'zip') expect(last(await runJob((j) => j.compress('home', ['Documents/Project'], { format, name: 'X', level: 3, password: 'pässword' })))).toMatchObject({ state: 'failed', error: 'password_ascii' })
      const c = await runJob((j) => j.compress('home', ['Documents/Project'], { format, name: 'Locked', level: 3, password: secret }))
      expect(last(c)).toMatchObject({ state: 'done', error: null })
      expect(JSON.stringify(c)).not.toContain(secret)
      const l = await listIn(env(), 'home', `Documents/Locked.${format}`, null, { spawn })
      if (format === '7z') expect(l).toEqual({ ok: false, error: 'password' })       // encrypted headers
      else expect(l.ok && l.value.encrypted).toBe(true)
      let asked = 0
      const x = await runJob((j) => j.extract('home', `Documents/Locked.${format}`, 'folder', [], null), (e, j) => { if (e.state === 'password') { asked++; j.password(e.id, asked === 1 ? 'wrong' : secret) } })
      expect(last(x).state).toBe('done')
      expect(asked).toBe(2)
      expect(x.filter((e) => e.state === 'password').map((e) => e.ask?.wrong)).toEqual([false, true])
      expect(readFileSync(path.join(home, 'Documents', 'Locked', 'Project', 'a.txt'), 'utf8')).toBe('alpha\n')
      expect(argvs.length).toBeGreaterThan(2)
      for (const a of argvs) expect(a.join(' ')).not.toContain(secret)
      expect(JSON.stringify(x)).not.toContain(secret)
    })
  }

  it('cancels a running compression and removes the partial file', async (ctx) => {
    if (!has('tar') || !has('xz')) return ctx.skip()
    const big = Buffer.alloc(48 * 1024 * 1024)
    for (let i = 0; i < big.length; i += 4) big.writeUInt32LE((i * 2654435761) >>> 0, i)
    writeFileSync(path.join(home, 'Documents', 'big.bin'), big)
    let sent = false
    const r = await new Promise<ArchiveJobEvent[]>((resolve) => {
      const seen: ArchiveJobEvent[] = []
      const j = archiveJobs(env(), (e) => {
        seen.push(e)
        if (e.state === 'running' && !sent) { sent = true; setTimeout(() => j.resolve(e.id, 'cancel', false), 200) }
        if (['done', 'failed', 'cancelled'].includes(e.state)) resolve(seen)
      }, { spawn })
      j.compress('home', ['Documents/big.bin'], { format: 'tar.xz', name: 'big', level: 9 })
    })
    expect(last(r).state).toBe('cancelled')
    expect(readdirSync(path.join(home, 'Documents')).filter((n) => n.startsWith('.') || n.startsWith('big.tar'))).toEqual([])
  }, 30_000)

  it('locates archives under a root for "open with Files"', () => {
    writeFileSync(path.join(home, 'Documents', 'x.zip'), '')
    expect(locate(env(), path.join(home, 'Documents', 'x.zip'))).toEqual({ root: 'home', rel: 'Documents/x.zip' })
    expect(locate(env(), '/etc/passwd')).toBeNull()
    expect(locate(env(), path.join(home, 'Documents', 'notes.md'))).toBeNull()
    expect(locate(env(), 'Documents/x.zip')).toBeNull()
  })
})

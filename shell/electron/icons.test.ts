import { mkdirSync, mkdtempSync, readFileSync, statSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { currentTheme, dirDistance, dirMatches, iconDataUrl, IconCache, iconName, insideAny, lookupIcon, parseIndexTheme, themeChain, type IconEnv } from './icons'

const PNG = Buffer.from('89504e470d0a1a0a0000000d49484452', 'hex')
const SVG = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1 1"/>'

/** A fake icon tree on disk: files maps relative paths under root to content. */
function tree(files: Record<string, string | Buffer>) {
  const root = mkdtempSync(path.join(tmpdir(), 'ws-icons-'))
  for (const [rel, body] of Object.entries(files)) {
    const f = path.join(root, rel)
    mkdirSync(path.dirname(f), { recursive: true })
    writeFileSync(f, body)
  }
  const env: IconEnv = { bases: [path.join(root, 'icons')], pixmaps: [path.join(root, 'pixmaps')], theme: 'Papirus' }
  return { root, env }
}
const index = (dirs: string, groups: string, inherits = '') => `[Icon Theme]\nName=T\n${inherits ? `Inherits=${inherits}\n` : ''}Directories=${dirs}\n\n${groups}`
const HICOLOR = index('48x48/apps,scalable/apps', '[48x48/apps]\nSize=48\nType=Threshold\n\n[scalable/apps]\nSize=128\nMinSize=8\nMaxSize=512\nType=Scalable\n')

describe('parseIndexTheme', () => {
  it('reads directories, sizes, types and inherits; drops unsafe dirs', () => {
    const t = parseIndexTheme(index('16x16/apps,scalable/apps,../x,/abs', '[16x16/apps]\nSize=16\nType=Fixed\n\n[scalable/apps]\nSize=48\nMinSize=16\nMaxSize=256\nType=Scalable\n\n[../x]\nSize=1\n\n[/abs]\nSize=1\n', 'breeze,hicolor'))
    expect(t.inherits).toEqual(['breeze', 'hicolor'])
    expect(t.dirs.map((d) => [d.dir, d.type, d.min, d.max])).toEqual([['16x16/apps', 'Fixed', 16, 16], ['scalable/apps', 'Scalable', 16, 256]])
  })
})

describe('size matching (spec DirectoryMatchesSize / DirectorySizeDistance)', () => {
  const fixed = { dir: 'a', size: 32, scale: 1, type: 'Fixed' as const, min: 32, max: 32, threshold: 2 }
  const scal = { dir: 'b', size: 48, scale: 1, type: 'Scalable' as const, min: 16, max: 256, threshold: 2 }
  const thr = { dir: 'c', size: 48, scale: 1, type: 'Threshold' as const, min: 48, max: 48, threshold: 2 }
  it('matches', () => {
    expect(dirMatches(fixed, 32, 1)).toBe(true)
    expect(dirMatches(fixed, 32, 2)).toBe(false)
    expect(dirMatches(scal, 100, 1)).toBe(true)
    expect(dirMatches(thr, 46, 1)).toBe(true)
    expect(dirMatches(thr, 45, 1)).toBe(false)
  })
  it('measures distance in device pixels', () => {
    expect(dirDistance(fixed, 24, 2)).toBe(16)
    expect(dirDistance(scal, 300, 1)).toBe(44)
    expect(dirDistance(scal, 64, 2)).toBe(0)
  })
})

describe('themeChain', () => {
  it('follows Inherits once each, then hicolor; skips missing themes', () => {
    const idx: Record<string, ReturnType<typeof parseIndexTheme>> = {
      Papirus: { inherits: ['breeze', 'missing', 'hicolor'], dirs: [] }, breeze: { inherits: ['Papirus'], dirs: [] }, hicolor: { inherits: [], dirs: [] },
    }
    expect(themeChain('Papirus', (t) => idx[t] ?? null)).toEqual(['Papirus', 'breeze', 'hicolor'])
    expect(themeChain('nope', (t) => idx[t] ?? null)).toEqual(['hicolor'])
  })
})

describe('lookupIcon', () => {
  it('prefers the current theme, then hicolor, then pixmaps', () => {
    const { env } = tree({
      'icons/Papirus/index.theme': index('48x48/apps', '[48x48/apps]\nSize=48\nType=Fixed\n'),
      'icons/Papirus/48x48/apps/firefox.png': PNG,
      'icons/hicolor/index.theme': HICOLOR,
      'icons/hicolor/48x48/apps/firefox.png': PNG,
      'icons/hicolor/48x48/apps/celluloid.png': PNG,
      'pixmaps/xterm.png': PNG,
    })
    expect(lookupIcon('firefox', 48, 1, env)).toContain('/Papirus/48x48/apps/firefox.png')
    expect(lookupIcon('celluloid', 48, 1, env)).toContain('/hicolor/48x48/apps/celluloid.png')
    expect(lookupIcon('xterm', 48, 1, env)).toContain('/pixmaps/xterm.png')
    expect(lookupIcon('nothing-here', 48, 1, env)).toBeNull()
  })
  it('takes the exact size, else the closest, with scalable SVG winning a tie', () => {
    const { env } = tree({
      'icons/Papirus/index.theme': index('16x16/apps,64x64/apps,scalable/apps', '[16x16/apps]\nSize=16\nType=Fixed\n\n[64x64/apps]\nSize=64\nType=Fixed\n\n[scalable/apps]\nSize=48\nMinSize=32\nMaxSize=256\nType=Scalable\n'),
      'icons/Papirus/16x16/apps/a.png': PNG,
      'icons/Papirus/64x64/apps/a.png': PNG,
      'icons/Papirus/scalable/apps/a.svg': SVG,
      'icons/Papirus/16x16/apps/b.png': PNG,
      'icons/Papirus/64x64/apps/b.png': PNG,
    })
    expect(lookupIcon('a', 44, 1, env)).toContain('/scalable/apps/a.svg')
    expect(lookupIcon('a', 64, 1, env)).toMatch(/64x64\/apps\/a\.png|scalable\/apps\/a\.svg/)
    expect(lookupIcon('a', 16, 1, env)).toContain('/16x16/apps/a.png')
    expect(lookupIcon('b', 44, 1, env)).toContain('/64x64/apps/b.png')
    expect(lookupIcon('b', 22, 1, env)).toContain('/16x16/apps/b.png')
  })
  it('prefers SVG over PNG in the same matching directory', () => {
    const { env } = tree({ 'icons/hicolor/index.theme': HICOLOR, 'icons/hicolor/scalable/apps/c.svg': SVG, 'icons/hicolor/48x48/apps/c.png': PNG })
    expect(lookupIcon('c', 48, 1, env)).toContain('c.svg')
  })
  it('accepts names with an extension, rejects path-like names', () => {
    const { env } = tree({ 'icons/hicolor/index.theme': HICOLOR, 'icons/hicolor/48x48/apps/d.png': PNG, 'secret.png': PNG })
    expect(lookupIcon('d.png', 48, 1, env)).toContain('d.png')
    expect(iconName('../../secret')).toBeNull()
    expect(iconName('a/b')).toBeNull()
    expect(lookupIcon('../secret', 48, 1, env)).toBeNull()
  })
  it('allows an absolute Icon= only inside an icon directory', () => {
    const { root, env } = tree({ 'pixmaps/e.png': PNG, 'etc/shadow.png': PNG, 'pixmaps/f.txt': 'x' })
    expect(lookupIcon(path.join(root, 'pixmaps/e.png'), 48, 1, env)).toBe(path.join(root, 'pixmaps/e.png'))
    expect(lookupIcon(path.join(root, 'etc/shadow.png'), 48, 1, env)).toBeNull()
    expect(lookupIcon(path.join(root, 'pixmaps/../etc/shadow.png'), 48, 1, env)).toBeNull()
    expect(lookupIcon(path.join(root, 'pixmaps/f.txt'), 48, 1, env)).toBeNull()
  })
})

describe('iconDataUrl', () => {
  it('returns PNG and SVG data URLs', () => {
    const { root, env } = tree({ 'pixmaps/a.png': PNG, 'pixmaps/b.svg': SVG })
    expect(iconDataUrl(path.join(root, 'pixmaps/a.png'), env)).toBe(`data:image/png;base64,${PNG.toString('base64')}`)
    expect(iconDataUrl(path.join(root, 'pixmaps/b.svg'), env)).toMatch(/^data:image\/svg\+xml;base64,/)
  })
  it('refuses a symlink that leads outside the icon directories', () => {
    const { root, env } = tree({ 'outside/x.png': PNG, 'pixmaps/.keep': '' })
    symlinkSync(path.join(root, 'outside/x.png'), path.join(root, 'pixmaps/evil.png'))
    expect(iconDataUrl(path.join(root, 'pixmaps/evil.png'), env)).toBeNull()
  })
  it('refuses files that are not what their extension says, empty or too big', () => {
    const { root, env } = tree({ 'pixmaps/fake.png': 'not a png', 'pixmaps/fake.svg': 'hello', 'pixmaps/empty.png': '', 'pixmaps/big.png': Buffer.concat([PNG, Buffer.alloc(1024 * 1024)]) })
    for (const f of ['fake.png', 'fake.svg', 'empty.png', 'big.png']) expect(iconDataUrl(path.join(root, 'pixmaps', f), env)).toBeNull()
  })
  it('insideAny is strict', () => {
    expect(insideAny('/usr/share/icons/a.png', ['/usr/share/icons'])).toBe(true)
    expect(insideAny('/usr/share/icons', ['/usr/share/icons'])).toBe(false)
    expect(insideAny('/usr/share/icons-evil/a.png', ['/usr/share/icons'])).toBe(false)
  })
})

describe('IconCache', () => {
  it('resolves, falls back to null, caches and ignores bad input', () => {
    const { env } = tree({ 'icons/hicolor/index.theme': HICOLOR, 'icons/hicolor/48x48/apps/g.png': PNG })
    let lookups = 0
    const fs = { isFile: (p: string) => { lookups++; try { return statSync(p).isFile() } catch { return false } }, readText: (p: string) => { try { return readFileSync(p, 'utf8') } catch { return null } } }
    const c = new IconCache(() => env, fs)
    const r = c.resolve(['g', 'none', 42, '../x'], 48, 1)
    expect(r.g).toMatch(/^data:image\/png/)
    expect(r.none).toBeNull()
    expect(r['../x']).toBeNull()
    expect(Object.keys(r)).not.toContain('42')
    const n = lookups
    c.resolve(['g'], 48, 1)
    expect(lookups).toBe(n)
    expect(c.resolve('g', 48, 1)).toEqual({})
  })
})

describe('currentTheme', () => {
  it('uses WS_ICON_THEME, then GTK settings, then Adwaita', () => {
    const read = (f: string) => (f.endsWith('gtk-3.0/settings.ini') ? '[Settings]\ngtk-icon-theme-name=Papirus-Dark\n' : null)
    expect(currentTheme({ WS_ICON_THEME: 'breeze' }, '/c', read)).toBe('breeze')
    expect(currentTheme({}, '/c', read)).toBe('Papirus-Dark')
    expect(currentTheme({}, '/c', () => null)).toBe('Adwaita')
    expect(currentTheme({ WS_ICON_THEME: '../../etc' }, '/c', () => null)).toBe('Adwaita')
  })
})

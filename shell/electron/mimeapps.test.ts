import { mkdtempSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { currentDefault, defaultApps, lookupFiles, parseDefaults, setDefaultApp, setDefaults } from './mimeapps'
import type { DesktopEntry } from './xdg'

const app = (id: string, mimes: string[]): DesktopEntry => ({ id, name: id.toUpperCase(), generic_name: null, comment: null, icon: null, categories: [], keywords: [], exec: id, mime_types: mimes })

describe('mimeapps.list', () => {
  it('reads [Default Applications] only', () => {
    const m = parseDefaults('[Added Associations]\ntext/plain=a.desktop;\n\n[Default Applications]\n# c\ntext/plain=b.desktop;c.desktop;\n')
    expect(m.get('text/plain')).toEqual(['b.desktop', 'c.desktop'])
  })

  it('replaces existing keys, adds missing ones and keeps other groups and comments', () => {
    const before = '# mine\n[Default Applications]\ntext/plain=old.desktop;\n\n[Added Associations]\nimage/png=x.desktop;\n'
    const after = setDefaults(before, ['text/plain', 'text/markdown'], 'new.desktop')
    expect(after).toBe('# mine\n[Default Applications]\ntext/plain=new.desktop;\ntext/markdown=new.desktop;\n\n[Added Associations]\nimage/png=x.desktop;\n')
    expect(setDefaults('', ['application/pdf'], 'p.desktop')).toBe('[Default Applications]\napplication/pdf=p.desktop;\n')
  })

  it('looks up user config first, desktop-specific before generic, then data dirs', () => {
    const f = lookupFiles({ HOME: '/h', XDG_CURRENT_DESKTOP: 'WorkSuite:wlroots', XDG_CONFIG_DIRS: '/etc/xdg', XDG_DATA_DIRS: '/usr/share' })
    expect(f.slice(0, 4)).toEqual(['/h/.config/worksuite-mimeapps.list', '/h/.config/wlroots-mimeapps.list', '/h/.config/mimeapps.list', '/etc/xdg/worksuite-mimeapps.list'])
    expect(f.at(-1)).toBe('/usr/share/applications/mimeapps.list')
  })

  it('skips ids that are not installed', () => {
    const files: Record<string, string> = { a: '[Default Applications]\ntext/plain=gone.desktop;\n', b: '[Default Applications]\ntext/plain=gedit.desktop;\n' }
    expect(currentDefault('text/plain', new Set(['gedit']), ['a', 'b'], (f) => files[f] ?? null)).toBe('gedit')
    expect(currentDefault('text/plain', new Set(), ['a', 'b'], (f) => files[f] ?? null)).toBeNull()
  })

  it('writes the choice to the user file, which then wins, and refuses non-candidates', () => {
    const home = mkdtempSync(path.join(tmpdir(), 'mime-'))
    const env = { HOME: home, XDG_CONFIG_DIRS: path.join(home, 'etc'), XDG_DATA_DIRS: path.join(home, 'usr'), XDG_CURRENT_DESKTOP: 'WorkSuite' }
    mkdirSync(path.join(home, 'usr/applications'), { recursive: true })
    writeFileSync(path.join(home, 'usr/applications/worksuite-mimeapps.list'), '[Default Applications]\napplication/pdf=evince.desktop;\n')
    const entries = [app('evince', ['application/pdf']), app('okular', ['application/pdf']), app('gedit', ['text/plain'])]
    const pdf = () => defaultApps(entries, env).find((c) => c.category === 'pdf')!
    expect(pdf()).toEqual({ category: 'pdf', current: 'evince', candidates: [{ id: 'evince', name: 'EVINCE' }, { id: 'okular', name: 'OKULAR' }] })
    expect(setDefaultApp('pdf', 'gedit', entries, env)).toEqual({ ok: false, error: 'not_a_candidate' })
    expect(setDefaultApp('pdf', '-x', entries, env)).toEqual({ ok: false, error: 'invalid_argument' })
    expect(setDefaultApp('pdf', 'okular', entries, env)).toEqual({ ok: true, value: true })
    expect(readFileSync(path.join(home, '.config/mimeapps.list'), 'utf8')).toContain('application/pdf=okular.desktop;')
    expect(pdf().current).toBe('okular')
  })

  it('also updates a user desktop-specific file that would otherwise shadow the choice', () => {
    const home = mkdtempSync(path.join(tmpdir(), 'mime-'))
    mkdirSync(path.join(home, '.config'))
    writeFileSync(path.join(home, '.config/worksuite-mimeapps.list'), '[Default Applications]\ntext/plain=a.desktop;\n')
    const env = { HOME: home, XDG_CURRENT_DESKTOP: 'WorkSuite', XDG_CONFIG_DIRS: '/nonexistent', XDG_DATA_DIRS: '/nonexistent' }
    const entries = [app('a', ['text/plain']), app('b', ['text/plain'])]
    expect(setDefaultApp('text', 'b', entries, env).ok).toBe(true)
    expect(defaultApps(entries, env).find((c) => c.category === 'text')!.current).toBe('b')
  })
})

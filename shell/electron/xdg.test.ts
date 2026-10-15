import { afterEach, describe, expect, it } from 'vitest'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { execProgram, findOffice, findWorkSuiteDesktop, installedApps, parseDesktopFile, toEntry } from './xdg'

const entry = (extra = '') => `[Desktop Entry]\nType=Application\nName=Foo\nName[si]=ෆූ\nExec=/usr/bin/foo %U\nCategories=Utility;\n${extra}\n[Desktop Action new]\nName=Other\n`

describe('desktop entries', () => {
  let dir = ''
  afterEach(() => { if (dir) rmSync(dir, { recursive: true, force: true }) })
  it('parses the main group and localised names', () => {
    expect(parseDesktopFile(entry()).Name).toBe('Foo')
    expect(parseDesktopFile(entry(), 'si_LK')['Name@l']).toBe('ෆූ')
  })
  it('hides NoDisplay, Hidden, OnlyShowIn/NotShowIn and non-applications', () => {
    const e = (x: string) => toEntry('foo', parseDesktopFile(entry(x)), ['WorkSuite'])
    expect(e('')?.name).toBe('Foo')
    expect(e('NoDisplay=true')).toBeNull()
    expect(e('Hidden=true')).toBeNull()
    expect(e('OnlyShowIn=GNOME;')).toBeNull()
    expect(e('OnlyShowIn=GNOME;WorkSuite;')?.name).toBe('Foo')
    expect(e('NotShowIn=WorkSuite;')).toBeNull()
    expect(toEntry('l', { Type: 'Link', Name: 'x' }, [])).toBeNull()
  })
  it('reads XDG dirs with user entries shadowing system ones', () => {
    dir = mkdtempSync(path.join(tmpdir(), 'ws-xdg-'))
    const home = path.join(dir, 'home/applications')
    const sys = path.join(dir, 'sys/applications')
    mkdirSync(home, { recursive: true })
    mkdirSync(path.join(sys, 'kde'), { recursive: true })
    writeFileSync(path.join(sys, 'foo.desktop'), entry())
    writeFileSync(path.join(sys, 'bar.desktop'), entry().replace('Name=Foo', 'Name=Bar'))
    writeFileSync(path.join(home, 'bar.desktop'), entry('NoDisplay=true'))
    writeFileSync(path.join(sys, 'kde/k.desktop'), entry().replace('Name=Foo', 'Name=Kay'))
    const apps = installedApps({ XDG_DATA_HOME: path.join(dir, 'home'), XDG_DATA_DIRS: path.join(dir, 'sys'), XDG_CURRENT_DESKTOP: 'WorkSuite' })
    expect(apps.map((a) => a.id)).toEqual(['foo', 'kde-k'])
  })
  it('detects WorkSuite Office by id, Name or Exec', () => {
    const mk = (id: string, name: string, exec: string) => ({ id, name, exec, generic_name: null, comment: null, icon: null, categories: [], keywords: [], mime_types: [] })
    expect(findOffice([mk('firefox-esr', 'Firefox', 'firefox'), mk('worksuite-office', 'WorkSuite Office', '/usr/bin/worksuite-office %U')])?.id).toBe('worksuite-office')
    expect(findOffice([mk('x', 'Editors', '/opt/worksuite/desktopeditors/DesktopEditors %U')])?.id).toBe('x')
    expect(findOffice([mk('libreoffice-writer', 'LibreOffice Writer', 'libreoffice --writer')])).toBeNull()
    expect(execProgram('"/opt/a b/x" %U')).toBe('/opt/a b/x')
    expect(execProgram('env FOO=1 x')).toBeNull()
    // WSOS-LCH-001: an Exec line is never handed to a shell; shells and field codes are refused as programs.
    expect(execProgram('sh -c "rm -rf ~"')).toBeNull()
    expect(execProgram('/bin/bash -c x')).toBeNull()
    expect(execProgram('%U')).toBeNull()
  })
})

describe('findWorkSuiteDesktop', () => {
  const e = (id: string, exec: string | null) => ({ id, name: id, generic_name: null, comment: null, icon: null, categories: [], keywords: [], exec, mime_types: [] })
  it('finds the worksuite-desktop package entry by id or program', () => {
    expect(findWorkSuiteDesktop([e('foot', 'foot'), e('worksuite', '/opt/WorkSuite/worksuite %U')])?.id).toBe('worksuite')
    expect(findWorkSuiteDesktop([e('lk.worksuite.desktop', '"/opt/WorkSuite/worksuite" %U')])?.id).toBe('lk.worksuite.desktop')
  })
  it('does not take the web app windows or Office for it', () => {
    expect(findWorkSuiteDesktop([e('worksuite-mail', 'worksuite-app mail'), e('worksuite-url-handler', 'worksuite-app %u'), e('worksuite-office', '/opt/worksuite-office/desktopeditors')])).toBeNull()
  })
})

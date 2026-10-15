import { spawnSync } from 'node:child_process'
import { chmodSync, existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { fileHead, isWindowsProgram } from './winexe'
import { parseDefaults } from './mimeapps'
import { parseDesktopFile } from './xdg'

const APPS = path.join(__dirname, '..', 'apps')
const defaults = parseDefaults(readFileSync(path.join(APPS, 'worksuite-mimeapps.list'), 'utf8'))

describe('Windows programs (WSOS-LCH-003)', () => {
  it('are recognised by extension or by the MZ header', () => {
    expect(isWindowsProgram('setup.EXE', null)).toBe(true)
    expect(isWindowsProgram('tool.msi', null)).toBe(true)
    expect(isWindowsProgram('/dl/installer', Buffer.from('MZ\x90\x00'))).toBe(true)
    expect(isWindowsProgram('notes.txt', Buffer.from('MZ notes'))).toBe(false)
    expect(isWindowsProgram('report.pdf', Buffer.from('%PDF'))).toBe(false)
    expect(isWindowsProgram('README', null)).toBe(false)
  })

  it('reads the header from disk', () => {
    const d = mkdtempSync(path.join(os.tmpdir(), 'exe-'))
    writeFileSync(path.join(d, 'a'), 'MZrest')
    expect(fileHead(path.join(d, 'a'))?.toString()).toBe('MZ')
    expect(fileHead(path.join(d, 'missing'))).toBeNull()
  })

  it('every Windows type defaults to the explanation handler', () => {
    const entry = parseDesktopFile(readFileSync(path.join(APPS, 'worksuite-windows-app.desktop'), 'utf8'))
    const types = entry.MimeType.split(';').filter(Boolean)
    expect(types).toContain('application/x-ms-dos-executable')
    expect(types).toContain('application/x-msi')
    for (const t of types) expect(defaults.get(t)).toEqual(['worksuite-windows-app.desktop'])
    expect(entry.Exec).toBe('/usr/lib/worksuite/shell/worksuite-windows-app %f')
  })

  it('the handler explains and never runs the file', () => {
    const d = mkdtempSync(path.join(os.tmpdir(), 'exe-'))
    const marker = path.join(d, 'ran')
    const exe = path.join(d, 'setup.exe')
    writeFileSync(exe, `#!/bin/sh\ntouch ${marker}\n`)
    chmodSync(exe, 0o755)
    const r = spawnSync('sh', [path.join(__dirname, '..', 'bin', 'worksuite-windows-app'), exe], { env: { PATH: '/usr/bin:/bin', LANG: 'en_US.UTF-8' }, encoding: 'utf8' })
    expect(r.status).toBe(0)
    expect(r.stderr).toContain("Windows programs can't run here")
    expect(r.stderr).toContain('setup.exe is a Windows program')
    expect(existsSync(marker)).toBe(false)
  })
})

describe('worksuite:// links (WSOS-DSK-010)', () => {
  it('are handled by WorkSuite (Desktop first, else the web app windows), which resolve them on the server', () => {
    const entry = parseDesktopFile(readFileSync(path.join(APPS, 'worksuite-url-handler.desktop'), 'utf8'))
    expect(entry.MimeType).toBe('x-scheme-handler/worksuite;')
    expect(entry.Exec).toBe('worksuite-app %u')
    expect(defaults.get('x-scheme-handler/worksuite')).toEqual(['worksuite.desktop', 'worksuite-url-handler.desktop'])
  })
})

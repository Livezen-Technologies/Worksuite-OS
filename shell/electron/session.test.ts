import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { appLaunchCommand, scopeCommand, effectiveLockTimeout, logoutCommand, readLockSettings, writeLockTimeout, type LockPaths } from './session'

describe('appLaunchCommand (WSOS-SES-004, WSOS-REL-004)', () => {
  it('starts each app in its own transient scope under app.slice, not in the shell cgroup', () => {
    const [cmd, args] = appLaunchCommand('org.mozilla.firefox', 'ab12cd34')!
    expect(cmd).toBe('systemd-run')
    expect(args).toEqual(['--user', '--scope', '--collect', '--quiet', '--slice=app.slice',
      '--unit=app-worksuite-org.mozilla.firefox-ab12cd34.scope', '--description=org.mozilla.firefox', '--', 'gtk-launch', 'org.mozilla.firefox'])
  })
  it('uses a fresh unit name per launch', () => {
    expect(appLaunchCommand('a')![1][5]).not.toBe(appLaunchCommand('a')![1][5])
  })
  it('refuses ids that are not plain desktop ids', () => {
    for (const bad of ['', '../x', 'a b', '--help', '-x', 'x;rm', 'a/b']) expect(appLaunchCommand(bad)).toBeNull()
  })
})

describe('scopeCommand', () => {
  it('puts a directly started program in its own app scope', () => {
    expect(scopeCommand('libreoffice-writer', ['/usr/bin/libreoffice', '--writer'], 'r1')).toEqual(['systemd-run', ['--user', '--scope', '--collect', '--quiet', '--slice=app.slice',
      '--unit=app-worksuite-libreoffice-writer-r1.scope', '--description=libreoffice-writer', '--', '/usr/bin/libreoffice', '--writer']])
    expect(scopeCommand('-x', ['a'])).toBeNull()
  })
})

describe('logoutCommand (WSOS-SES-003)', () => {
  it('runs the full worksuite-session cleanup outside the shell cgroup', () => {
    expect(logoutCommand()).toEqual(['systemd-run', ['--user', '--collect', '--quiet', '--unit=worksuite-logout', '--', '/usr/bin/worksuite-session', '--logout']])
  })
})

describe('lock timeout (WSOS-LOCK-003)', () => {
  let dir: string, p: LockPaths
  beforeEach(() => { dir = mkdtempSync(path.join(tmpdir(), 'ws-lock-')); p = { user: path.join(dir, 'cfg', 'worksuite', 'lock.conf'), policy: path.join(dir, 'lock-policy.conf') } })
  afterEach(() => rmSync(dir, { recursive: true, force: true }))

  it('matches worksuite-idle: user choice capped by policy, no "never" under a maximum', () => {
    expect(effectiveLockTimeout(null, null)).toBe(300)
    expect(effectiveLockTimeout(0, null)).toBe(0)
    expect(effectiveLockTimeout(120, 600)).toBe(120)
    expect(effectiveLockTimeout(3600, 600)).toBe(600)
    expect(effectiveLockTimeout(0, 600)).toBe(600)
  })
  it('offers every choice without a policy and saves one', () => {
    expect(readLockSettings(p)).toEqual({ timeout_s: 300, max_s: null, choices: [60, 120, 300, 600, 900, 1800, 3600, 0] })
    const r = writeLockTimeout(p, 0)
    expect(r).toEqual({ ok: true, value: { timeout_s: 0, max_s: null, choices: [60, 120, 300, 600, 900, 1800, 3600, 0] } })
    expect(readFileSync(p.user, 'utf8')).toBe('LOCK_TIMEOUT_S=0\n')
  })
  it('only offers choices within the policy maximum and refuses others', () => {
    writeFileSync(p.policy, 'LOCK_TIMEOUT_MAX_S=450\n')
    expect(readLockSettings(p)).toEqual({ timeout_s: 300, max_s: 450, choices: [60, 120, 300, 450] })
    expect(writeLockTimeout(p, 600)).toEqual({ ok: false, error: 'above_policy_maximum' })
    expect(writeLockTimeout(p, 0)).toEqual({ ok: false, error: 'above_policy_maximum' })
    expect(writeLockTimeout(p, 450)).toMatchObject({ ok: true, value: { timeout_s: 450 } })
  })
  it('a stricter policy arriving later caps an earlier choice', () => {
    writeLockTimeout(p, 3600)
    writeFileSync(p.policy, 'LOCK_TIMEOUT_MAX_S=600\n')
    expect(readLockSettings(p).timeout_s).toBe(600)
  })
  it('rejects values that are not offered', () => {
    expect(writeLockTimeout(p, 61)).toEqual({ ok: false, error: 'invalid_argument' })
    expect(writeLockTimeout(p, Number.NaN)).toEqual({ ok: false, error: 'invalid_argument' })
  })
})

import { describe, expect, it } from 'vitest'
import { APP_SCOPES_ARGS, NRESTARTS_ARGS, REPORT_JOURNAL_ARGS, countAppScopes, parseRestarts, reportName, reportText, restartPending } from './desktopHost'

describe('problem report (WSOS-SES-005)', () => {
  const now = new Date('2026-10-15T08:30:05Z')
  it('is named by time and holds the shell and session log', () => {
    expect(reportName(now)).toBe('WorkSuite problem report 2026-10-15-08-30-05.txt')
    const text = reportText('line one\nline two\n', now, '1.2.3')
    expect(text).toContain('Shell version: 1.2.3')
    expect(text).toContain('line one\nline two')
    expect(reportText(null, now, '1')).toContain('(The log could not be read.)')
  })
  it('reads only this boot’s shell, session and bridge units, user journal, fixed argv', () => {
    expect(REPORT_JOURNAL_ARGS).toEqual(expect.arrayContaining(['--user', '-b', '-u', 'worksuite-shell.service', '-u', 'worksuite-session.target']))
    expect(REPORT_JOURNAL_ARGS.some((a) => a.includes(' '))).toBe(false)
  })
})

describe('shell restarted notice (G12)', () => {
  it('reads the systemd restart count and the app scopes still running', () => {
    expect(parseRestarts('2\n')).toBe(2)
    expect(parseRestarts('')).toBeNull()
    expect(parseRestarts(null)).toBeNull()
    expect(countAppScopes('app-worksuite-org.gnome.TextEditor-1a2b.scope loaded active running org.gnome.TextEditor\napp-worksuite-firefox-9f.scope loaded active running firefox\n')).toBe(2)
    expect(countAppScopes('')).toBe(0)
    expect(countAppScopes(null)).toBeNull()
  })
  it('shows once per restart', () => {
    expect(restartPending(0, null)).toBe(false)
    expect(restartPending(1, null)).toBe(true)
    expect(restartPending(1, 1)).toBe(false)
    expect(restartPending(2, 1)).toBe(true)
    expect(restartPending(null, null)).toBe(false)
  })
  it('uses fixed systemctl argv', () => {
    expect(NRESTARTS_ARGS).toEqual(['--user', 'show', 'worksuite-shell.service', '-p', 'NRestarts', '--value'])
    expect(APP_SCOPES_ARGS[0]).toBe('--user')
  })
})

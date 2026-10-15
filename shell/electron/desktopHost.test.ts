import { describe, expect, it } from 'vitest'
import { REPORT_JOURNAL_ARGS, reportName, reportText } from './desktopHost'

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

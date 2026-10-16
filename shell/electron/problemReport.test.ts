import { describe, expect, it } from 'vitest'
import { collectReport, finalReport, redact, reportText, sendReport, type Exec } from './problemReport'

describe('§11.6-d problem report', () => {
  it('redacts tokens, passwords, keys, emails and the home path', () => {
    const s = redact('Authorization: Bearer abc.def.ghi password=hunter2 token: "x y" ana@a.test /home/ana/x eyJhbGciOiJI.eyJzdWIiOiIx.sig ' + 'a'.repeat(64), '/home/ana')
    expect(s).not.toMatch(/hunter2|abc\.def|ana@a\.test|\/home\/ana|eyJhbGci|aaaaaaaa/)
    expect(s).toContain('~/x')
  })

  it('collects every section, marks tools that fail as unavailable, never invents text', async () => {
    const exec: Exec = async (cmd, args) => {
      if (cmd === 'uname') return { code: 0, stdout: 'Linux 6.12 x86_64\n', stderr: '' }
      if (cmd === 'journalctl' && !args.includes('--user')) return { code: 1, stdout: '', stderr: 'No journal files were opened due to insufficient permissions.' }
      if (cmd === 'dpkg-query') return { code: 1, stdout: '', stderr: '', missing: true }
      if (cmd === 'systemctl' && args.includes('--user')) return { code: 0, stdout: '', stderr: '' }
      return { code: 0, stdout: 'foo.service failed token=s3cret\n', stderr: '' }
    }
    const r = await collectReport({ exec, readFile: () => 'PRETTY_NAME="WorkSuite OS 1.0"\nVERSION_ID="1.0"\n', home: '/home/ana', now: () => new Date('2026-10-16T00:00:00Z') })
    const by = Object.fromEntries(r.sections.map((s) => [s.id, s]))
    expect(by.system.text).toContain('WorkSuite OS 1.0')
    expect(by.system.text).toContain('Linux 6.12')
    expect(by.system_log.available).toBe(false)
    expect(by.packages).toEqual({ id: 'packages', text: '', available: false })
    expect(by.session_services.text).toBe('No failed session services.')
    expect(by.services.text).not.toContain('s3cret')
  })

  it('only kept, available sections leave the computer', async () => {
    const r = { id: 'r1', created_at: 'now', sections: [{ id: 'system' as const, text: 'S', available: true }, { id: 'session_log' as const, text: 'L', available: true }, { id: 'packages' as const, text: '', available: false }] }
    const f = finalReport(r, ['system', 'packages'], 'Wi-Fi drops, my password=abc')
    expect(f.sections).toEqual([{ id: 'system', text: 'S' }])
    expect(f.description).not.toContain('abc')
    expect(reportText(f)).toContain('== system ==')
  })

  it('sends with the user token to the org server; reports offline and sign-in problems', async () => {
    const f = finalReport({ id: 'r1', created_at: 'now', sections: [] }, [], 'x')
    const seen: { url: string; headers: Record<string, string> }[] = []
    expect(await sendReport(f, { token: 'T', apiBase: 'https://ws.test/' }, async (url, init) => { seen.push({ url, headers: init.headers }); return { ok: true, status: 202 } }, 'dev')).toEqual({ ok: true })
    expect(seen[0].url).toBe('https://ws.test/desktop/v1/problem-reports')
    expect(seen[0].headers).toMatchObject({ authorization: 'Bearer T', 'idempotency-key': 'r1', 'x-ws-device': 'dev' })
    expect(await sendReport(f, null, async () => ({ ok: true, status: 202 }))).toEqual({ ok: false, error: 'not_signed_in' })
    expect(await sendReport(f, { token: 'T', apiBase: 'https://ws.test/' }, async () => { throw new Error('net') })).toEqual({ ok: false, error: 'offline' })
    expect(await sendReport(f, { token: 'T', apiBase: 'https://ws.test/' }, async () => ({ ok: false, status: 401 }))).toEqual({ ok: false, error: 'auth_required' })
  })
})

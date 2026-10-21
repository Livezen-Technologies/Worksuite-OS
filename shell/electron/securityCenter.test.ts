import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { agentError, pollInterval, readSecurity, securityNotices, type SecurityStatus } from './securityCenter'

const base: SecurityStatus = {
  overall: 'protected', issues: [], managed: true, scanning: false,
  firewall: { active: true, policy_rules: 0, log_blocked: false }, isolation: null,
  antivirus: { enabled: true, installed: true, engine: '1.0.7', signatures: 1, signatures_at: 1, signatures_age_days: 0, updates: 'active', schedule: 'weekly', exclusions: 0, last_scan: null, last_full_scan: null },
  threats: { active: 0, quarantined: 0 }, history: [], firewall_alerts: [], retention_days: 90,
}

describe('WorkSuite Security notices', () => {
  it('nothing on the first read', () => {
    expect(securityNotices(null, { ...base, threats: { active: 3, quarantined: 0 } })).toEqual([])
  })
  it('threat detected / quarantined, firewall alert, protection off, outdated definitions, isolation', () => {
    const next: SecurityStatus = {
      ...base, issues: ['signatures_outdated'], firewall: { ...base.firewall, active: false }, isolation: { since: 1, until: 2 },
      history: [{ id: 'a', at: 1, path: '/home/u/x', signature: 'S', action: 'quarantined' }, { id: 'b', at: 1, path: '/home/u/y', signature: 'S', action: 'detected' }],
      firewall_alerts: [{ at: 5, dst: '198.51.100.7', dport: 443, proto: 'TCP' }],
    }
    expect(securityNotices(base, next).map((n) => n.kind)).toEqual(['threat_detected', 'threat_quarantined', 'firewall_alert', 'protection_disabled', 'signatures_outdated', 'isolated'])
    expect(securityNotices(next, next)).toEqual([])
    expect(securityNotices(next, { ...next, isolation: null }).map((n) => n.kind)).toEqual(['isolation_ended'])
  })
  it('#38: blocks and suspended programs notify once; report-only events and real-time stopping', () => {
    const ev = (id: string, kind: string, enforced = true) => ({ id, at: 1, kind, path: `/home/u/Documents/${id}`, exe: '/usr/bin/python3', signature: null, enforced, resolved: null }) as NonNullable<SecurityStatus['events']>[number]
    const prev: SecurityStatus = { ...base, events: [] }
    const one = { ...prev, events: [ev('a', 'write_blocked')] }
    expect(securityNotices(prev, one)).toEqual([{ kind: 'blocked', title: 'WorkSuite Security blocked a threat', body: 'python3 was not allowed to change a in a protected folder.' }])
    expect(securityNotices(one, one)).toEqual([])
    const many = { ...prev, events: [ev('a', 'exec_blocked'), ev('b', 'download_threat'), ev('c', 'ransomware_suspended'), ev('d', 'write_blocked', false)] }
    expect(securityNotices(prev, many).map((n) => n.kind)).toEqual(['process_suspended', 'blocked'])
    expect(securityNotices(prev, many)[1].body).toBe('2 actions were blocked. Open WorkSuite Security to review.')
    expect(securityNotices(prev, { ...prev, issues: ['realtime_off'] }).map((n) => n.body)).toEqual(['Real-time protection is not running.'])
  })
  it('refuses malformed quarantine and process actions before reaching the bus', async () => {
    const { securityAction } = await import('./securityCenter')
    expect(await securityAction('RestoreQuarantined', ['../../etc/passwd'])).toEqual({ ok: false, error: 'invalid_argument' })
    expect(await securityAction('ResolveSuspendedProcess', ['0f0e0d0c-0b0a-4908-8706-050403020100', 'kill'])).toEqual({ ok: false, error: 'invalid_argument' })
    expect(await securityAction('RunShell', [])).toEqual({ ok: false, error: 'invalid_argument' })
  })
  it('#64: agent errors become reasons Settings can show; scans are followed every 2 s', async () => {
    expect(agentError({ type: 'lk.worksuite.Error.Failed', text: 'NO_SIGNATURES' })).toBe('no_signatures')
    expect(agentError({ type: 'lk.worksuite.Error.Failed', text: 'ANTIVIRUS_MISSING' })).toBe('missing')
    expect(agentError({ type: 'lk.worksuite.Error.NotAuthorized', text: 'NotAuthorized' })).toBe('auth_cancelled')
    expect(agentError({ type: 'lk.worksuite.Error.Failed', text: 'FAILED' })).toBe('failed')
    // The agent is not on the bus (not running): the service name is unknown.
    expect(agentError({ type: 'org.freedesktop.DBus.Error.ServiceUnknown', text: 'The name is not activatable' })).toBe('agent_unavailable')
    expect(pollInterval({ ...base, scanning: true })).toBe(2_000)
    expect(pollInterval(base)).toBe(30_000)
    const { securityAction } = await import('./securityCenter')
    expect(await securityAction('CancelSecurityScan', ['x'])).toEqual({ ok: false, error: 'invalid_argument' })
  })
  it('reads the agent file; anything else is unavailable', () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'ws-sec-'))
    try {
      const f = path.join(dir, 'security.json')
      expect(readSecurity(f)).toBeNull()
      writeFileSync(f, '{"nope":1}'); expect(readSecurity(f)).toBeNull()
      writeFileSync(f, JSON.stringify(base)); expect(readSecurity(f)?.overall).toBe('protected')
    } finally { rmSync(dir, { recursive: true, force: true }) }
  })
})

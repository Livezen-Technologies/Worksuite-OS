import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { readSecurity, securityNotices, type SecurityStatus } from './securityCenter'

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

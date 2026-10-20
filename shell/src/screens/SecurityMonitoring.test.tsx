// @vitest-environment jsdom
// Settings › Privacy & security › WorkSuite Security (#20) and Employee monitoring (#22), and the taskbar monitoring
// indicator with its first-run disclosure, from fixed data (no bridge).
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, describe, expect, it } from 'vitest'
import type { ActivityStatus, SecurityStatus } from '../lib/os'
import { SecuritySection } from './settings/Security'
import { MonitoringSection } from './settings/Monitoring'
import { MonitoringIndicator } from '../components/MonitoringNotice'

const g = globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }
g.IS_REACT_ACT_ENVIRONMENT = true
let root: Root | null = null, host: HTMLDivElement | null = null
async function render(el: React.ReactElement) {
  host = document.createElement('div'); document.body.append(host)
  root = createRoot(host)
  await act(async () => { root!.render(el) })
  return host
}
afterEach(() => { act(() => root?.unmount()); host?.remove(); root = null })

const sec: SecurityStatus = {
  overall: 'at_risk', issues: ['threats_need_action'], managed: true, scanning: false,
  firewall: { active: true, policy_rules: 2, log_blocked: true }, isolation: null,
  antivirus: { enabled: true, installed: true, engine: '1.0.7', signatures: 27431, signatures_at: 0, signatures_age_days: 1, updates: 'active', schedule: 'weekly', exclusions: 0,
    last_scan: { kind: 'quick', trigger: 'schedule', started: 0, finished: Date.now() - 60_000, files: 1200, detections: 1 }, last_full_scan: null },
  threats: { active: 1, quarantined: 1 },
  history: [{ id: 'a', at: Date.now(), path: '/home/u/Downloads/x.exe', signature: 'Win.Trojan.Agent', action: 'detected' }],
  firewall_alerts: [], retention_days: 30,
}
const info = { agent: true, device: null, managed: true, org_name: 'Livezen', server: null, last_check_in: null, policies: null }

describe('WorkSuite Security section', () => {
  it('shows status, firewall, scan buttons, history and the managing organization', async () => {
    const el = await render(<SecuritySection info={info} initial={sec} />)
    expect(el.textContent).toContain('At risk')
    expect(el.textContent).toContain('2 destinations blocked by your organization')
    expect(el.textContent).toContain('ClamAV 1.0.7')
    expect(el.textContent).toContain('1 need action · 1 in quarantine')
    expect(el.textContent).toContain('Win.Trojan.Agent')
    expect(el.textContent).toContain('managed by Livezen')
    expect([...el.querySelectorAll('button')].map((b) => b.textContent)).toEqual(['Quick scan', 'Full scan'])
  })
  it('says when status is unavailable', async () => {
    const el = await render(<SecuritySection info={null} initial={null} />)
    expect(el.textContent).toContain('Security status unavailable')
  })
})

const act0: ActivityStatus = {
  enabled: true, org_name: 'Livezen', retention_days: 30, idle_threshold_s: 300, disclosure_needed: true, last_sent: null,
  days: [{ day: '2026-10-20', active_s: 7200, idle_s: 600, locked_s: 0, first_active: 0, last_active: 0, events: [], apps: [{ app_id: 'org.worksuite.Office', name: 'WorkSuite Office', active_s: 3600, switches: 3 }] }],
}

describe('Employee monitoring', () => {
  it('Settings: what is and is not collected, retention and the employee’s own data', async () => {
    const el = await render(<MonitoringSection initial={act0} />)
    expect(el.textContent).toContain('Livezen monitors work activity')
    expect(el.textContent).toContain('Keystrokes, screenshots, window titles')
    expect(el.textContent).toContain('Kept for 30 days')
    expect(el.textContent).toContain('WorkSuite Office')
    expect(el.textContent).toContain('2026-10-20')
  })
  it('Settings: off says so', async () => {
    const el = await render(<MonitoringSection initial={{ ...act0, enabled: false, days: [] }} />)
    expect(el.textContent).toContain('does not monitor activity')
  })
  it('taskbar: persistent indicator and first-run disclosure that cannot be dismissed with Escape', async () => {
    const el = await render(<MonitoringIndicator onOpen={() => {}} initial={act0} />)
    expect(el.querySelector('button[aria-label="Activity monitoring is on. Open details"]')).not.toBeNull()
    const dlg = document.querySelector('[role="dialog"]')
    expect(dlg?.textContent).toContain('Livezen monitors work activity on this computer')
    expect(dlg?.textContent).toContain('I understand')
    await act(async () => { window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' })) })
    expect(document.querySelector('[role="dialog"]')).not.toBeNull()
  })
  it('taskbar: nothing when monitoring is off; no dialog once acknowledged', async () => {
    const el = await render(<MonitoringIndicator onOpen={() => {}} initial={{ ...act0, enabled: false }} />)
    expect(el.innerHTML).toBe('')
    act(() => root?.unmount()); host?.remove()
    const el2 = await render(<MonitoringIndicator onOpen={() => {}} initial={{ ...act0, disclosure_needed: false }} />)
    expect(el2.querySelector('button')).not.toBeNull()
    expect(document.querySelector('[role="dialog"]')).toBeNull()
  })
})

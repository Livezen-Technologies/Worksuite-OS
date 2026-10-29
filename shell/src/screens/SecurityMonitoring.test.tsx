// @vitest-environment jsdom
// Settings › Privacy & security › WorkSuite Security (#20) and Employee monitoring (#22), and the taskbar monitoring
// indicator with its first-run disclosure, from fixed data (no bridge).
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { os, type ActivityStatus, type SecurityStatus } from '../lib/os'
import { fmtElapsed, lastScanText, scanErrorCode, SecuritySection } from './settings/Security'
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
  it('#38: real-time, ransomware and web protection rows, suspended programs, quarantine and recent blocks', async () => {
    const full: SecurityStatus = {
      ...sec,
      realtime: { enabled: true, prevention: true, state: 'active', downloads: true },
      protected_folders: { folders: ['~/Documents'], mode: 'block', state: 'active' },
      app_control: { denied: 2 }, web: { dns_blocked: 10, dns_feeds: 1, dns_filter: true, dns_feed_entries: 5 },
      threat_intel: { feeds: 1, entries: 300, updated: null, errors: [] }, auto_patch: 'immediate',
      events: [{ id: 'e1', at: Date.now(), kind: 'write_blocked', path: '/home/u/Documents/a.odt', exe: '/tmp/x', signature: null, enforced: true, resolved: null }],
      suspended: [{ id: 's1', at: Date.now(), path: '/home/u/Documents/b.locked', exe: '/usr/bin/python3', pid: 9 }],
      quarantine: [{ id: 'q1', at: Date.now(), path: '/home/u/Downloads/eicar.com', signature: 'Eicar' }],
    }
    const el = await render(<SecuritySection info={info} initial={full} />)
    expect(el.textContent).toContain('files with threats are blocked when opened')
    expect(el.textContent).toContain('New downloads are scanned')
    expect(el.textContent).toContain('Protecting Documents')
    expect(el.textContent).toContain('15 dangerous sites blocked')
    expect(el.textContent).toContain('300 known-bad addresses blocked')
    expect(el.textContent).toContain('2 programs blocked by your organization')
    expect(el.textContent).toContain('Change to a protected folder blocked')
    expect(el.textContent).toContain('python3')
    expect(el.textContent).toContain('eicar.com')
    expect(el.textContent).toContain('install as soon as they are available')
    expect([...el.querySelectorAll('button')].map((b) => b.textContent)).toEqual(['Quick scan', 'Full scan', 'Resume', 'End program', 'Restore', 'Delete'])
  })
  it('#64: no virus definitions yet → explains, offers Update definitions, scans disabled', async () => {
    const nodefs: SecurityStatus = { ...sec, issues: ['no_signatures'], antivirus: { ...sec.antivirus, signatures: null, signatures_at: null, signatures_age_days: null, ready: false, last_scan: { kind: 'quick', trigger: 'user', started: 0, finished: Date.now(), files: 0, detections: 0, error: 'NO_SIGNATURES' } } }
    const update = vi.spyOn(os, 'securityAction').mockResolvedValue({ ok: true, value: true })
    const el = await render(<SecuritySection info={info} initial={nodefs} />)
    expect(el.textContent).toContain('Virus definitions haven’t been downloaded yet')
    expect(el.textContent).toContain('Last scan couldn’t run: no virus definitions')
    const buttons = [...el.querySelectorAll('button')]
    expect(buttons.map((b) => [b.textContent, b.disabled])).toEqual([['Update definitions', false], ['Quick scan', true], ['Full scan', true]])
    await act(async () => { buttons[0].click() })
    expect(update).toHaveBeenCalledWith('UpdateSecurityDefinitions')
    expect(el.textContent).toContain('Checking for virus definitions')
    update.mockRestore()
  })
  it('#64: a scan that cannot start says why instead of "Scan started"', async () => {
    const start = vi.spyOn(os, 'securityScan').mockResolvedValue({ ok: false, error: 'no_signatures' })
    const el = await render(<SecuritySection info={info} initial={sec} />)
    await act(async () => { [...el.querySelectorAll('button')].find((b) => b.textContent === 'Quick scan')!.click() })
    expect(start).toHaveBeenCalledWith('quick')
    expect(el.textContent).toContain('Couldn’t start a scan: virus definitions haven’t been downloaded yet')
    start.mockRestore()
  })
  it('#68: the engine\'s real state when a scan cannot start; a stopped updater is named and can be restarted', async () => {
    const start = vi.spyOn(os, 'securityScan')
    const stopped: SecurityStatus = { ...sec, antivirus: { ...sec.antivirus, updates: 'failed' } }
    const el = await render(<SecuritySection info={info} initial={stopped} />)
    expect(el.textContent).toContain('Automatic updates stopped after an error')
    expect([...el.querySelectorAll('button')].map((b) => b.textContent)).toContain('Update definitions')
    const quick = () => [...el.querySelectorAll('button')].find((b) => b.textContent === 'Quick scan')!
    for (const [error, text] of [['signatures_downloading', 'virus definitions are still downloading'], ['updater_missing', 'freshclam) isn’t installed'],
      ['engine_check_failed', 'antivirus engine didn’t respond'], ['missing', 'antivirus engine isn’t installed'], ['failed:SYSTEMD_RUN', 'reported an error (SYSTEMD_RUN)'], ['failed', 'reported an error (FAILED)']]) {
      start.mockResolvedValue({ ok: false, error })
      await act(async () => { quick().click() })
      expect(el.textContent).toContain(text)
    }
    expect(el.textContent).not.toMatch(/Couldn’t start a scan\.(?!\S)/)
    start.mockRestore()
  })
  it('#64: progress while scanning (files, found, elapsed, current path), Cancel, and recent scans', async () => {
    const started = Date.now() - 65_000
    const running: SecurityStatus = { ...sec, scanning: true, antivirus: { ...sec.antivirus, ready: true,
      progress: { kind: 'full', started, files: 4321, detections: 1, errors: 0, current: '/home/u/Downloads/setup.bin', elapsed_ms: 65_000 },
      scans: [{ id: 'a', kind: 'quick', trigger: 'user', started: 0, finished: Date.now() - 3_600_000, files: 812, detections: 0 }, { id: 'b', kind: 'full', trigger: 'user', started: 0, finished: Date.now() - 7_200_000, files: 100, detections: 0, error: 'CANCELLED' }] } }
    const cancel = vi.spyOn(os, 'securityAction').mockResolvedValue({ ok: true, value: true })
    const el = await render(<SecuritySection info={info} initial={running} />)
    expect(el.textContent).toMatch(/Full scan · 4,321 files · 1 found · 1:0[5-9]/)
    expect(el.textContent).toContain('Scanning /home/u/Downloads/setup.bin')
    expect(el.textContent).toContain('Quick scan · 812 files · 0 found')
    expect(el.textContent).toContain('Cancelled')
    const buttons = [...el.querySelectorAll('button')]
    expect(buttons.map((b) => b.textContent)).toEqual(['Cancel scan'])
    await act(async () => { buttons[0].click() })
    expect(cancel).toHaveBeenCalledWith('CancelSecurityScan')
    cancel.mockRestore()
    expect(fmtElapsed(3_729_000)).toBe('1:02:09')
  })
  it('#68: a scan that started and then stopped says why', () => {
    const last = { id: 'x', kind: 'quick' as const, trigger: 'user' as const, started: 0, finished: Date.now(), files: 0, detections: 0 }
    expect(lastScanText({ ...last, error: 'ENGINE_ERROR' })).toContain('couldn’t load its virus definitions. Select Update definitions')
    expect(lastScanText({ ...last, error: 'ANTIVIRUS_MISSING' })).toContain('antivirus engine isn’t installed')
    expect(lastScanText({ ...last, error: 'CLAMSCAN_50' })).toContain('stopped with an error (CLAMSCAN_50)')
    expect(lastScanText({ ...last, error: 'SYSTEMD_RUN: spawn systemd-run ENOENT' })).toContain('(SYSTEMD_RUN)')
    expect(scanErrorCode('something went wrong')).toBe('ERROR')
    expect(lastScanText({ ...last, error: 'CANCELLED' })).toBe('Last scan was cancelled')
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
  it('Settings (#39): live state, startup/shutdown, attendance and, only when the policy allows, website domains', async () => {
    const day0 = act0.days[0]
    const base = { ...act0, live: { state: 'idle' as const, app_id: day0.apps[0]?.app_id ?? null, at: Date.now() - 30_000 },
      days: [{ ...day0, domains: [{ domain: 'mail.worksuite.lk', active_s: 600 }] }] }
    const el = await render(<MonitoringSection initial={{ ...base, web_domains: false }} />)
    expect(el.textContent).toContain('Your current state once a minute')
    expect(el.textContent).toContain('When this computer starts up and shuts down')
    expect(el.textContent).toContain('daily attendance summary')
    expect(el.querySelector('[data-testid="mon-live"]')?.textContent).toContain('Idle')
    expect(el.textContent).toContain('First active')
    expect(el.textContent).not.toContain('mail.worksuite.lk')
    expect(el.textContent).not.toContain('Which websites you use')
    act(() => root?.unmount()); host?.remove()
    const el2 = await render(<MonitoringSection initial={{ ...base, web_domains: true }} />)
    expect(el2.textContent).toContain('Which websites you use in WorkSuite web apps')
    expect(el2.textContent).toContain('mail.worksuite.lk')
  })
  it('disclosure lists website domains only when the policy turns them on', async () => {
    await render(<MonitoringIndicator onOpen={() => {}} initial={{ ...act0, web_domains: true }} />)
    expect(document.querySelector('[role="dialog"]')?.textContent).toContain('the domain name only')
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

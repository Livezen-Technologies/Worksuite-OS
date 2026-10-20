import { mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { ActivityTracker, activityPolicy, activityView, clearStore, DISCLOSURE_VERSION, disclosureVersion, emptyStore, loadStore, localDay, saveStore, sendActivity, sendLive, toDomain, webDomainFile } from './activity'
import { appDisplayName, isWorkSuiteWebApp, parseLogindLine, parseNmOnline } from './activityHost'

const T0 = new Date(2026, 9, 20, 9, 0, 0).getTime()   // local 09:00
const MIN = 60_000

function tracker(threshold = 300) {
  let now = T0
  const tr = new ActivityTracker(emptyStore(), { now: () => now, idleThresholdS: threshold })
  return { tr, at: (m: number) => { now = T0 + m * MIN } }
}

describe('activity policy', () => {
  const files = (status: unknown, policy: unknown) => (p: string) => JSON.stringify(p.endsWith('status.json') ? status : policy)
  it('is off unless the device is managed and the signed policy turns it on', () => {
    expect(activityPolicy(() => null).enabled).toBe(false)
    expect(activityPolicy(files({ managed: false }, { activity_monitoring: true })).enabled).toBe(false)
    expect(activityPolicy(files({ managed: true }, { activity_monitoring: false })).enabled).toBe(false)
    const p = activityPolicy(files({ managed: true, org_name: 'Livezen' }, { activity_monitoring: true, activity_retention_days: 30, activity_idle_threshold_s: 9 }))
    expect(p).toEqual({ enabled: true, org_name: 'Livezen', retention_days: 30, idle_threshold_s: 300, web_domains: false })
    expect(activityPolicy(files({ managed: true }, { activity_monitoring: true, activity_web_domains: true })).web_domains).toBe(true)
    expect(activityPolicy(files({ managed: true }, { activity_monitoring: false, activity_web_domains: true })).web_domains).toBe(false)
  })
})

describe('activity tracker', () => {
  it('counts active time per focused app with switches; the shell itself is no app', () => {
    const { tr, at } = tracker()
    tr.focus({ id: 'org.worksuite.Office', name: 'WorkSuite Office' })
    at(30); tr.focus({ id: 'firefox', name: 'Firefox' })
    at(40); tr.focus({ id: 'org.worksuite.Office', name: 'WorkSuite Office' })
    at(50); tr.focus(null)
    at(60); tr.flush()
    const d = tr.store.days[localDay(T0)]
    expect(d.active_s).toBe(3600)
    expect(d.apps).toEqual([
      { app_id: 'org.worksuite.Office', name: 'WorkSuite Office', active_s: 2400, switches: 2 },
      { app_id: 'firefox', name: 'Firefox', active_s: 600, switches: 1 },
    ])
    expect(d.first_active).toBe(T0); expect(d.last_active).toBe(T0 + 60 * MIN)
  })

  it('a short pause stays active; a long one becomes idle from the last input', () => {
    const { tr, at } = tracker(300)
    tr.focus({ id: 'foot', name: 'Terminal' })
    at(10); tr.idle(true)      // last input at 9:09
    at(12); tr.idle(false)     // 3 min pause < 5 min threshold
    at(20); tr.idle(true)      // last input 9:19
    at(40); tr.idle(false)     // 21 min idle
    at(41); tr.flush()
    const d = tr.store.days[localDay(T0)]
    expect(d.idle_s).toBe(21 * 60)
    expect(d.active_s).toBe(20 * 60)
    expect(d.apps[0].active_s).toBe(20 * 60)
    expect(d.events.map((e) => e.type)).toEqual(['idle', 'active'])
  })

  it('locked time and lock events; idle while locked is ignored', () => {
    const { tr, at } = tracker()
    at(5); tr.lock(true)
    at(6); tr.idle(true)
    at(35); tr.lock(false)
    at(40); tr.flush()
    const d = tr.store.days[localDay(T0)]
    expect(d.locked_s).toBe(30 * 60); expect(d.active_s).toBe(10 * 60)
    expect(d.events.map((e) => e.type)).toEqual(['lock', 'unlock'])
  })

  it('splits at local midnight', () => {
    let now = new Date(2026, 9, 20, 23, 30).getTime()
    const tr = new ActivityTracker(emptyStore(), { now: () => now, idleThresholdS: 300 })
    now += 60 * MIN; tr.flush()
    expect(tr.store.days['2026-10-20'].active_s).toBe(1800)
    expect(tr.store.days['2026-10-21'].active_s).toBe(1800)
  })

  it('retention, unsent days and app ids that are not ids', () => {
    const { tr, at } = tracker()
    tr.focus({ id: 'Inbox — Mail', name: 'x' })   // a title, not an app id: not recorded as an app
    at(10); tr.flush()
    expect(tr.store.days[localDay(T0)].apps).toEqual([])
    tr.store.days['2020-01-01'] = { ...tr.store.days[localDay(T0)], day: '2020-01-01' }
    tr.prune(90)
    expect(Object.keys(tr.store.days)).toEqual([localDay(T0)])
    expect(tr.unsent().map((d) => d.day)).toEqual([localDay(T0)])
    tr.markSent([localDay(T0)], T0 + 11 * MIN)
    expect(tr.unsent()).toEqual([])
    at(20); tr.flush()
    expect(tr.unsent().length).toBe(1)
  })
})

describe('store and sending', () => {
  it('saves 0600, clears when monitoring is off but keeps the acknowledgement', () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'ws-act-'))
    try {
      const f = path.join(dir, 'state/activity.json')
      const s = emptyStore(); s.disclosure_ack = 1; s.days['2026-10-20'] = { day: '2026-10-20', active_s: 1, idle_s: 0, locked_s: 0, first_active: null, last_active: null, apps: [], events: [] }
      saveStore(f, s)
      expect(statSync(f).mode & 0o777).toBe(0o600)
      expect(loadStore(f).days['2026-10-20'].active_s).toBe(1)
      clearStore(f, 1)
      expect(JSON.parse(readFileSync(f, 'utf8')).days).toEqual({})
      expect(loadStore(f).disclosure_ack).toBe(1)
    } finally { rmSync(dir, { recursive: true, force: true }) }
  })

  it('sends aggregates only, with the user token and device credential; offline keeps them', async () => {
    const sent: { url: string; headers: Record<string, string>; body: string }[] = []
    const day = { day: '2026-10-20', active_s: 10, idle_s: 0, locked_s: 0, first_active: 1, last_active: 2, apps: [], events: [] }
    const r = await sendActivity([day], { token: 'tok', apiBase: 'https://ws.test/' }, 'dev', async (url, init) => { sent.push({ url, ...init }); return { ok: true, status: 202 } })
    expect(r.ok).toBe(true)
    expect(sent[0].url).toBe('https://ws.test/desktop/v1/activity')
    expect(sent[0].headers).toMatchObject({ authorization: 'Bearer tok', 'x-ws-device': 'dev' })
    expect(Object.keys(JSON.parse(sent[0].body).reports[0]).sort()).toEqual(['active_s', 'apps', 'day', 'events', 'first_active', 'idle_s', 'last_active', 'locked_s'])
    expect(await sendActivity([day], null, 'dev', async () => ({ ok: true, status: 200 }))).toEqual({ ok: false, error: 'not_signed_in' })
    expect(await sendActivity([day], { token: 't', apiBase: 'https://ws.test/' }, null, async () => ({ ok: true, status: 200 }))).toEqual({ ok: false, error: 'not_enrolled' })
    expect(await sendActivity([day], { token: 't', apiBase: 'https://ws.test/' }, 'd', async () => { throw new Error('down') })).toEqual({ ok: false, error: 'offline' })
  })

  it('view: disclosure needed until acknowledged, and again for each new data type (#39)', () => {
    const p = { enabled: true, org_name: 'Org', retention_days: 90, idle_threshold_s: 300, web_domains: false }
    expect(activityView(p, emptyStore(), null).disclosure_needed).toBe(true)
    expect(activityView(p, { ...emptyStore(), disclosure_ack: 1 }, null).disclosure_needed).toBe(true)   // #22 ack: live and power are new
    expect(activityView(p, { ...emptyStore(), disclosure_ack: DISCLOSURE_VERSION }, null).disclosure_needed).toBe(false)
    expect(activityView({ ...p, web_domains: true }, { ...emptyStore(), disclosure_ack: DISCLOSURE_VERSION }, null).disclosure_needed).toBe(true)
    expect(activityView({ ...p, web_domains: true }, { ...emptyStore(), disclosure_ack: disclosureVersion({ web_domains: true }) }, null)).toMatchObject({ disclosure_needed: false, web_domains: true })
    expect(activityView({ ...p, enabled: false }, emptyStore(), null).disclosure_needed).toBe(false)
  })
})

describe('session events', () => {
  it('parses logind lock, unlock and IdleHint', () => {
    expect(parseLogindLine('/org/freedesktop/login1/session/_32: org.freedesktop.login1.Session.Lock ()')).toEqual({ lock: true })
    expect(parseLogindLine('/org/freedesktop/login1/session/_32: org.freedesktop.login1.Session.Unlock ()')).toEqual({ lock: false })
    expect(parseLogindLine("/org/freedesktop/login1/session/_32: org.freedesktop.DBus.Properties.PropertiesChanged ('org.freedesktop.login1.Session', {'IdleHint': <true>, 'IdleSinceHint': <uint64 1>}, @as [])")).toEqual({ idle: true })
    expect(parseLogindLine("... PropertiesChanged ('org.freedesktop.login1.Session', {'LockedHint': <true>}, @as [])")).toBeNull()
  })
  it('app names come from the desktop entry, never a title', () => {
    expect(appDisplayName('org.gnome.Calculator', (p) => p.endsWith('/usr/share/applications/org.gnome.Calculator.desktop') ? '[Desktop Entry]\nName=Calculator\n' : null)).toBe('Calculator')
    expect(appDisplayName('foot-server', () => null)).toBe('Foot server')
  })
})

describe('#39 live state, website domains, network back', () => {
  it('current state for the live view: active/idle/locked and the app id; none while locked', () => {
    const { tr, at } = tracker()
    tr.focus({ id: 'org.worksuite.Office', name: 'WorkSuite Office' })
    expect(tr.current()).toEqual({ state: 'active', app_id: 'org.worksuite.Office' })
    at(5); tr.idle(true)
    expect(tr.current().state).toBe('idle')
    at(6); tr.lock(true)
    expect(tr.current()).toEqual({ state: 'locked', app_id: null })
  })

  it('live heartbeat sends exactly { state, app_id }', async () => {
    const sent: { url: string; body: string }[] = []
    const r = await sendLive({ state: 'idle', app_id: 'foot' }, { token: 't', apiBase: 'https://ws.test/' }, 'dev', async (url, init) => { sent.push({ url, body: init.body }); return { ok: true, status: 204 } })
    expect(r.ok).toBe(true)
    expect(sent[0].url).toBe('https://ws.test/desktop/v1/activity/live')
    expect(JSON.parse(sent[0].body)).toEqual({ state: 'idle', app_id: 'foot' })
    expect(await sendLive({ state: 'active', app_id: null }, { token: 't', apiBase: 'https://ws.test/' }, 'dev', async () => ({ ok: false, status: 403 }))).toEqual({ ok: false, error: 'disabled' })
    expect(await sendLive({ state: 'active', app_id: null }, { token: 't', apiBase: 'https://ws.test/' }, null, async () => ({ ok: true, status: 204 }))).toEqual({ ok: false, error: 'not_enrolled' })
  })

  it('domains: the host name only, never a path, query, title, IP or localhost', () => {
    expect(toDomain('https://Mail.WorkSuite.lk/inbox/123?q=salary#x')).toBe('mail.worksuite.lk')
    expect(toDomain('drive.worksuite.lk')).toBe('drive.worksuite.lk')
    for (const bad of ['http://10.0.0.1/', 'http://localhost:3000/', 'file:///etc/passwd', 'Inbox – Mail', '', null, 'data:text/html,hi']) expect(toDomain(bad)).toBeNull()
    expect(webDomainFile('/run/user/1000', 'worksuite-mail')).toBe('/run/user/1000/worksuite/web-domain/worksuite-mail')
    expect(isWorkSuiteWebApp('worksuite-mail')).toBe(true)
    expect(isWorkSuiteWebApp('org.mozilla.firefox')).toBe(false)
  })

  it('domain time is counted while a web app has the focus, reset on app switch, and dropped when turned off', () => {
    const { tr, at } = tracker()
    tr.focus({ id: 'worksuite-mail', name: 'Mail' })
    tr.setDomain('https://mail.worksuite.lk/inbox')
    at(10); tr.setDomain('https://drive.worksuite.lk/f/1')
    at(15); tr.focus({ id: 'foot', name: 'Terminal' })
    at(20); tr.flush()
    const d = tr.store.days[localDay(T0)]
    expect(d.domains).toEqual([{ domain: 'mail.worksuite.lk', active_s: 600 }, { domain: 'drive.worksuite.lk', active_s: 300 }])
    expect(d.active_s).toBe(1200)
    tr.dropDomains()
    expect(tr.store.days[localDay(T0)].domains).toBeUndefined()
  })

  it('reports carry domains only when there are some', async () => {
    const bodies: string[] = []
    const f = async (_u: string, init: { body: string }) => { bodies.push(init.body); return { ok: true, status: 202 } }
    const base = { day: '2026-10-20', active_s: 10, idle_s: 0, locked_s: 0, first_active: 1, last_active: 2, apps: [], events: [] }
    await sendActivity([base, { ...base, day: '2026-10-21', domains: [{ domain: 'mail.worksuite.lk', active_s: 5 }] }], { token: 't', apiBase: 'https://ws.test/' }, 'd', f)
    const r = JSON.parse(bodies[0]).reports
    expect('domains' in r[0]).toBe(false)
    expect(r[1].domains).toEqual([{ domain: 'mail.worksuite.lk', active_s: 5 }])
  })

  it('NetworkManager full connectivity means online', () => {
    const line = (props: string) => `/org/freedesktop/NetworkManager: org.freedesktop.DBus.Properties.PropertiesChanged ('org.freedesktop.NetworkManager', {${props}}, @as [])`
    expect(parseNmOnline(line("'Connectivity': <uint32 4>"))).toBe(true)
    expect(parseNmOnline(line("'Connectivity': <uint32 1>"))).toBe(false)
    expect(parseNmOnline(line("'State': <uint32 70>"))).toBe(true)
    expect(parseNmOnline(line("'State': <uint32 20>"))).toBe(false)
    expect(parseNmOnline(line("'WirelessEnabled': <true>"))).toBeNull()
    expect(parseNmOnline("/org/freedesktop/login1/session/_3: org.freedesktop.login1.Session.Lock ()")).toBeNull()
  })
})

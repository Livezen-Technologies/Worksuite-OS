// @vitest-environment jsdom
// Shutdown/restart/sign-out overlay: apps are asked to close, logind inhibitors and apps that stay open get the
// "These apps are preventing shutdown" dialog (Cancel / Shut down anyway), every display mirrors the overlay.
// Also: administrator-only details, the crash dialog and Settings › About › Diagnostics gating.
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { EndMirror, SessionEnd } from './SessionEnd'
import { ErrorDetails } from './ErrorDetails'
import { CrashDialog } from './CrashDialog'
import { Diagnostics } from '../screens/settings/Diagnostics'
import { forgetAdmin, type Crash, type EndState, type Inhibitor, type SessionApi } from '../lib/sessionApi'
import { blockers, closeProgress } from '../lib/sessionEnd'
import type { PanelApi, PanelWindow } from '../lib/panel'
import { os } from '../lib/os'

const g = globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }
beforeAll(() => { g.IS_REACT_ACT_ENVIRONMENT = true })
let root: Root | null = null
let host: HTMLDivElement | null = null
beforeEach(() => { vi.useFakeTimers(); forgetAdmin() })
afterEach(() => { act(() => root?.unmount()); host?.remove(); delete window.worksuiteSession; delete window.worksuitePanel; vi.useRealTimers(); vi.restoreAllMocks() })

const win = (handle: string, appId: string, title = appId): PanelWindow => ({ handle, appId, title, output: 'HDMI-1', flags: 0 })

function session(over: Partial<SessionApi> = {}) {
  const ends: (EndState | null)[] = []
  let endCb: (s: EndState | null) => void = () => {}
  let crashCb: (c: Crash) => void = () => {}
  const api: SessionApi = {
    inhibitors: vi.fn(async () => ({ ok: true as const, value: [] as Inhibitor[] })),
    powerForce: vi.fn(async () => ({ ok: true as const, value: true as const })),
    setEndState: vi.fn(async (s) => { ends.push(s); endCb(s); return true }),
    onEndState: (cb) => { endCb = cb; return () => {} },
    onCrash: (cb) => { crashCb = cb; return () => {} },
    reopen: vi.fn(async () => undefined),
    isAdmin: vi.fn(async () => false),
    sessionJournal: vi.fn(async () => ({ ok: true as const, value: 'session log' })),
    systemJournal: vi.fn(async () => ({ ok: true as const, value: 'system log' })),
    bootDetails: vi.fn(async () => ({ ok: true as const, value: false })),
    ...over,
  }
  window.worksuiteSession = api
  return { api, ends, crash: (c: Crash) => act(() => crashCb(c)), pushEnd: (s: EndState | null) => act(() => endCb(s)) }
}

function panel(initial: PanelWindow[], closes: 'all' | 'none' = 'all') {
  let windows = initial
  let cb: (w: PanelWindow[]) => void = () => {}
  const api = {
    windows: vi.fn(async () => windows),
    close: vi.fn(async (h: string) => {
      if (closes === 'all') { windows = windows.filter((w) => w.handle !== h); setTimeout(() => cb(windows), 50) }
      return { ok: true as const, value: true as const }
    }),
    onWindows: (f: (w: PanelWindow[]) => void) => { cb = f; return () => {} },
  } as unknown as PanelApi
  window.worksuitePanel = api
  return api
}

async function render(node: React.ReactNode) {
  host = document.createElement('div'); document.body.append(host)
  root = createRoot(host)
  await act(async () => root!.render(node))
}
const tick = async (ms: number) => { await act(async () => { await vi.advanceTimersByTimeAsync(ms) }) }

describe('session end helpers', () => {
  it('lists each blocking app once, inhibitor reasons first', () => {
    const b = blockers([win('1', 'org.gnome.TextEditor', 'notes.txt'), win('2', 'org.gnome.TextEditor'), win('3', 'worksuite-shell')],
      [{ what: 'shutdown', who: 'Docs', why: 'Unsaved changes in “Q4 plan”', mode: 'block', uid: 1000, pid: 1 }], (id) => (id === 'org.gnome.TextEditor' ? 'Text Editor' : id))
    expect(b).toEqual([{ name: 'Docs', reason: 'Unsaved changes in “Q4 plan”' }, { name: 'Text Editor', reason: null }])
  })
  it('progress follows closed windows and leaves room for the hand-over', () => {
    expect(closeProgress(4, 4)).toBe(0)
    expect(closeProgress(4, 2)).toBeCloseTo(0.4)
    expect(closeProgress(4, 0)).toBeCloseTo(0.8)
    expect(closeProgress(0, 0)).toBeCloseTo(0.8)
  })
})

describe('SessionEnd overlay', () => {
  it('closes every app window, then shuts down with the splash look', async () => {
    const { ends } = session()
    const p = panel([win('a', 'org.gnome.TextEditor'), win('b', 'firefox-esr'), win('s', 'worksuite-shell')])
    const power = vi.spyOn(os, 'power').mockResolvedValue(undefined)
    await render(<SessionEnd action="shutdown" onCancel={() => {}} />)
    expect(host!.textContent).toContain('Shutting down…')
    expect(host!.textContent).toContain('Closing apps')
    await tick(10)
    expect(p.close).toHaveBeenCalledWith('a')
    expect(p.close).toHaveBeenCalledWith('b')
    expect(p.close).not.toHaveBeenCalledWith('s')
    await tick(800)
    expect(ends.at(-1)).toEqual({ action: 'shutdown', phase: 'ending', progress: 1 })
    expect(power).toHaveBeenCalledWith('shutdown')
    expect(host!.querySelector('[role="alertdialog"]')).toBeNull()
  })

  it('an inhibitor shows "These apps are preventing shutdown"; Cancel goes back to the desktop', async () => {
    const { api, ends } = session({ inhibitors: vi.fn(async () => ({ ok: true as const, value: [{ what: 'shutdown', who: 'Docs', why: 'Unsaved changes in “Q4 plan”', mode: 'block', uid: 1000, pid: 7 }] })) })
    panel([])
    const power = vi.spyOn(os, 'power').mockResolvedValue(undefined)
    const onCancel = vi.fn()
    await render(<SessionEnd action="shutdown" onCancel={onCancel} />)
    await tick(800)
    const dlg = host!.querySelector('[role="alertdialog"]')!
    expect(dlg.textContent).toContain('These apps are preventing shutdown')
    expect(dlg.textContent).toContain('Docs')
    expect(dlg.textContent).toContain('Unsaved changes in “Q4 plan”')
    expect(api.inhibitors).toHaveBeenCalledWith('shutdown')
    const cancel = [...dlg.querySelectorAll('button')].find((b) => b.textContent === 'Cancel')!
    expect(document.activeElement).toBe(cancel)
    await act(async () => cancel.click())
    await tick(500)
    expect(onCancel).toHaveBeenCalled()
    expect(ends.at(-1)).toBeNull()
    expect(power).not.toHaveBeenCalled()
  })

  it('"Shut down anyway" skips the inhibitors through systemd (polkit decides)', async () => {
    const { api } = session({ inhibitors: vi.fn(async () => ({ ok: true as const, value: [{ what: 'shutdown', who: 'Docs', why: '', mode: 'block', uid: 1000, pid: 7 }] })) })
    panel([])
    await render(<SessionEnd action="shutdown" onCancel={() => {}} />)
    await tick(800)
    const anyway = [...host!.querySelectorAll('button')].find((b) => b.textContent === 'Shut down anyway')!
    await act(async () => anyway.click())
    await tick(700)
    expect(api.powerForce).toHaveBeenCalledWith('shutdown')
  })

  it('an unanswered administrator prompt brings the dialog back instead of a stuck overlay', async () => {
    const { api } = session({
      inhibitors: vi.fn(async () => ({ ok: true as const, value: [{ what: 'shutdown', who: 'Docs', why: '', mode: 'block', uid: 1000, pid: 7 }] })),
      powerForce: vi.fn(() => new Promise<never>(() => {})),
    })
    panel([])
    await render(<SessionEnd action="restart" onCancel={() => {}} />)
    await tick(800)
    const anyway = [...host!.querySelectorAll('button')].find((b) => b.textContent === 'Restart anyway')!
    await act(async () => anyway.click())
    await tick(700)
    expect(api.powerForce).toHaveBeenCalledWith('restart')
    expect(host!.querySelector('[role="alertdialog"]')).toBeNull()
    await tick(45_100)
    const dlg = host!.querySelector('[role="alertdialog"]')!
    expect(dlg.textContent).toContain('An administrator needs to allow this.')
    expect([...dlg.querySelectorAll('button')].some((b) => b.textContent === 'Cancel')).toBe(true)
  })

  it('apps that keep their windows open are listed after the timeout', async () => {
    session()
    panel([win('a', 'org.gnome.TextEditor', 'notes.txt')], 'none')
    await render(<SessionEnd action="restart" onCancel={() => {}} nameOf={(id) => (id === 'org.gnome.TextEditor' ? 'Text Editor' : id)} />)
    await tick(8100)
    const dlg = host!.querySelector('[role="alertdialog"]')!
    expect(dlg.textContent).toContain('These apps are preventing restart')
    expect(dlg.textContent).toContain('Text Editor')
    expect(dlg.textContent).toContain('Restart anyway')
  })

  it('sign-out goes through the session cleanup, not systemctl', async () => {
    session()
    panel([])
    const onLogout = vi.fn()
    const power = vi.spyOn(os, 'power').mockResolvedValue(undefined)
    await render(<SessionEnd action="logout" onCancel={() => {}} onLogout={onLogout} />)
    expect(host!.textContent).toContain('Signing out…')
    await tick(1500)
    expect(onLogout).toHaveBeenCalled()
    expect(power).not.toHaveBeenCalled()
  })

  it('other displays mirror the overlay', async () => {
    const s = session()
    await render(<EndMirror />)
    expect(host!.textContent).toBe('')
    s.pushEnd({ action: 'restart', phase: 'closing', progress: 0.4 })
    expect(host!.textContent).toContain('Restarting…')
    expect(host!.querySelector('[role="progressbar"]')?.getAttribute('aria-valuenow')).toBe('40')
  })
})

describe('administrator gating', () => {
  it('technical details: a disclosure for administrators, only "Copy details" for others', async () => {
    session({ isAdmin: vi.fn(async () => false) })
    await render(<ErrorDetails details="E: Could not get lock /var/lib/dpkg/lock-frontend" />)
    await tick(0)
    expect(host!.textContent).toBe('Copy details')
    expect(host!.textContent).not.toContain('dpkg')
    act(() => root!.unmount()); host!.remove(); forgetAdmin()
    session({ isAdmin: vi.fn(async () => true) })
    await render(<ErrorDetails details="E: Could not get lock /var/lib/dpkg/lock-frontend" />)
    await tick(0)
    expect(host!.querySelector('details summary')?.textContent).toBe('Details')
    expect(host!.querySelector('pre')?.textContent).toContain('dpkg')
  })

  it('Diagnostics is shown to administrators only, and system logs go through the helper', async () => {
    session({ isAdmin: vi.fn(async () => false) })
    await render(<Diagnostics />)
    await tick(0)
    expect(host!.textContent).toBe('')
    act(() => root!.unmount()); host!.remove(); forgetAdmin()
    const { api } = session({ isAdmin: vi.fn(async () => true) })
    await render(<Diagnostics />)
    await tick(0)
    expect(host!.textContent).toContain('Diagnostics')
    expect(host!.textContent).toContain('Show boot details')
    const boot = [...host!.querySelectorAll('[role="radio"]')].find((b) => b.textContent === 'This start-up') as HTMLButtonElement
    await act(async () => boot.click())
    const showBtn = [...host!.querySelectorAll('button')].find((b) => b.textContent === 'Show log')!
    await act(async () => showBtn.click())
    await tick(0)
    expect(api.systemJournal).toHaveBeenCalledWith('boot', 400)
    expect(host!.querySelector('pre')?.textContent).toBe('system log')
  })
})

describe('crash dialog', () => {
  it('"X quit unexpectedly" with Reopen and Report…', async () => {
    const s = session()
    const onReport = vi.fn()
    await render(<CrashDialog onReport={onReport} />)
    s.crash({ appId: 'org.gnome.TextEditor', name: 'Text Editor', at: 1, details: 'Signal: SIGSEGV' })
    const dlg = host!.querySelector('[role="alertdialog"]')!
    expect(dlg.textContent).toContain('Text Editor quit unexpectedly')
    expect(dlg.textContent).not.toContain('SIGSEGV')
    const reopen = [...dlg.querySelectorAll('button')].find((b) => b.textContent === 'Reopen')!
    await act(async () => reopen.click())
    expect(s.api.reopen).toHaveBeenCalledWith('org.gnome.TextEditor')
    expect(host!.querySelector('[role="alertdialog"]')).toBeNull()
    s.crash({ appId: null, name: 'mystery', at: 2, details: '' })
    const report = [...host!.querySelectorAll('button')].find((b) => b.textContent === 'Report…')!
    expect([...host!.querySelectorAll('button')].some((b) => b.textContent === 'Reopen')).toBe(false)
    await act(async () => report.click())
    expect(onReport).toHaveBeenCalled()
  })
})

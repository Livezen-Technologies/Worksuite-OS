// @vitest-environment jsdom
// Issue #19: consent dialog (nothing shared before Allow), view-only requests offer no control, indicator with
// View only / End, unattended sessions disclosed.
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { RemoteSupportBadge, RemoteSupportPrompt } from './RemoteSupport'
import type { RemoteSupportApi, RsSession } from '../lib/remoteSupportApi'

const g = globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }
beforeAll(() => { g.IS_REACT_ACT_ENVIRONMENT = true })
let root: Root | null = null
let host: HTMLDivElement | null = null
afterEach(() => { act(() => root?.unmount()); host?.remove(); delete window.worksuiteRemoteSupport })

const BASE: RsSession = { session_id: '7d1b3c1e-4b1a-4c55-9a77-3f1d2b9e0c11', state: 'pending', mode: 'control', reason: 'Printer driver fails', admin_name: 'Alice Admin', org_name: 'Livezen', consent: null, granted_mode: null, requested_at: 1, started_at: null, expires_at: 2 }

async function mount(s: RsSession | null, ui: 'prompt' | 'badge') {
  let cur = s
  const api: RemoteSupportApi = {
    state: vi.fn(async () => cur),
    decide: vi.fn(async (d) => { cur = d === 'deny' ? null : { ...cur!, state: 'active', granted_mode: d, consent: 'user' }; return { ok: true as const, value: cur } }),
    revokeControl: vi.fn(async () => { cur = { ...cur!, granted_mode: 'view' }; return { ok: true as const, value: cur } }),
    end: vi.fn(async () => { cur = null; return { ok: true as const, value: null } }),
  }
  window.worksuiteRemoteSupport = api
  host = document.createElement('div'); document.body.append(host); root = createRoot(host)
  const onOpen = vi.fn()
  await act(async () => root!.render(ui === 'prompt' ? <RemoteSupportPrompt onOpen={onOpen} pollMs={10_000} /> : <RemoteSupportBadge pollMs={10_000} />))
  await act(async () => {})
  return { api, onOpen }
}
const button = (label: string) => [...host!.querySelectorAll('button')].find((b) => b.textContent === label)

describe('RemoteSupportPrompt', () => {
  it('nothing without the bridge or without a request', async () => {
    host = document.createElement('div'); document.body.append(host); root = createRoot(host)
    await act(async () => root!.render(<RemoteSupportPrompt />))
    expect(host.textContent).toBe('')
    await mount(null, 'prompt')
    expect(host!.textContent).toBe('')
  })
  it('shows who, organization, access level, reason and session id; three actions', async () => {
    const { api, onOpen } = await mount(BASE, 'prompt')
    const dlg = host!.querySelector('[role="alertdialog"]')!
    for (const s of ['WorkSuite Remote Support', 'IT administrator is requesting access', 'Alice Admin', 'Livezen', 'keyboard and mouse', 'Printer driver fails', BASE.session_id]) expect(dlg.textContent).toContain(s)
    expect(onOpen).toHaveBeenLastCalledWith(true)
    expect(button('Deny')).toBeTruthy(); expect(button('Allow screen sharing')).toBeTruthy()
    await act(async () => button('Allow remote control')!.click())
    expect(api.decide).toHaveBeenCalledWith('control')
    expect(host!.querySelector('[role="alertdialog"]')).toBeNull()
  })
  it('a view-only request cannot be answered with control; Escape denies', async () => {
    const { api } = await mount({ ...BASE, mode: 'view' }, 'prompt')
    expect(button('Allow remote control')).toBeUndefined()
    await act(async () => { host!.querySelector('[role="alertdialog"]')!.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })) })
    expect(api.decide).toHaveBeenCalledWith('deny')
  })
})

describe('RemoteSupportBadge', () => {
  it('visible while active; View only drops control; End ends', async () => {
    const { api } = await mount({ ...BASE, state: 'active', granted_mode: 'control', consent: 'user' }, 'badge')
    expect(host!.querySelector('[role="status"]')!.textContent).toContain('Remote support: in control')
    await act(async () => button('View only')!.click())
    expect(api.revokeControl).toHaveBeenCalled()
    expect(host!.textContent).toContain('Remote support: viewing')
    expect(button('View only')).toBeUndefined()
    await act(async () => button('End')!.click())
    expect(api.end).toHaveBeenCalled()
    expect(host!.textContent).toBe('')
  })
  it('discloses an unattended session', async () => {
    await mount({ ...BASE, state: 'active', granted_mode: 'view', consent: 'unattended_policy' }, 'badge')
    expect(host!.textContent).toContain('connected without asking')
  })
  it('nothing while only pending', async () => {
    await mount(BASE, 'badge')
    expect(host!.textContent).toBe('')
  })
})

// Issue #37: recording disclosure, step-up dialog, clipboard switch, files panel.
describe('remote support follow-ups (issue #37)', () => {
  const ACTIVE: RsSession = { ...BASE, state: 'active', mode: 'view', granted_mode: 'view', consent: 'user', started_at: 2 }
  async function mountFull(s: RsSession, ui: 'prompt' | 'badge', files: Awaited<ReturnType<NonNullable<RemoteSupportApi['files']>>> = []) {
    let cur: RsSession = s
    const api: RemoteSupportApi = {
      state: vi.fn(async () => cur),
      decide: vi.fn(async () => ({ ok: true as const, value: cur })),
      revokeControl: vi.fn(async () => ({ ok: true as const, value: cur })),
      end: vi.fn(async () => ({ ok: true as const, value: null })),
      chat: vi.fn(async () => []),
      decideElevation: vi.fn(async (allow: boolean) => { cur = { ...cur, elevation: null, granted_mode: allow ? 'control' : 'view' }; return { ok: true as const, value: cur } }),
      setClipboard: vi.fn(async (on: boolean) => { cur = { ...cur, clipboard: on }; return { ok: true as const, value: cur } }),
      files: vi.fn(async () => files),
      acceptFile: vi.fn(async () => true),
      rejectFile: vi.fn(async () => true),
      offerFile: vi.fn(async () => ({ ok: false as const, error: 'cancelled' })),
    }
    window.worksuiteRemoteSupport = api
    host = document.createElement('div'); document.body.append(host); root = createRoot(host)
    await act(async () => root!.render(ui === 'prompt' ? <RemoteSupportPrompt pollMs={10_000} /> : <RemoteSupportBadge pollMs={10_000} />))
    await act(async () => {})
    return api
  }

  it('the consent dialog says when the session may be recorded; the indicator keeps saying it', async () => {
    await mountFull({ ...BASE, record: true }, 'prompt')
    expect(host!.querySelector('[role="alertdialog"]')!.textContent).toContain('may record this session')
    act(() => root?.unmount()); host?.remove()
    await mountFull({ ...ACTIVE, record: true }, 'badge')
    expect(host!.textContent).toContain('May be recorded')
    act(() => root?.unmount()); host?.remove()
    await mountFull(ACTIVE, 'badge')
    expect(host!.textContent).not.toContain('May be recorded')
  })

  it('step-up: a fresh dialog asks the user; Escape keeps view only', async () => {
    const api = await mountFull({ ...ACTIVE, elevation: 'pending' }, 'prompt')
    const dlg = host!.querySelector('[role="alertdialog"]')!
    expect(dlg.textContent).toContain('Allow remote control?')
    expect(dlg.textContent).toContain('Alice Admin')
    await act(async () => { dlg.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })) })
    expect(api.decideElevation).toHaveBeenCalledWith(false)
    act(() => root?.unmount()); host?.remove()
    const api2 = await mountFull({ ...ACTIVE, elevation: 'pending' }, 'prompt')
    await act(async () => button('Allow remote control')!.click())
    expect(api2.decideElevation).toHaveBeenCalledWith(true)
    expect(api2.decide).not.toHaveBeenCalled()
  })

  it('clipboard is an off-by-default switch in the indicator', async () => {
    const api = await mountFull(ACTIVE, 'badge')
    const sw = host!.querySelector('[role="switch"]')!
    expect(sw.getAttribute('aria-checked')).toBe('false')
    await act(async () => (sw as HTMLButtonElement).click())
    expect(api.setClipboard).toHaveBeenCalledWith(true)
    expect(host!.querySelector('[role="switch"]')!.getAttribute('aria-checked')).toBe('true')
  })

  it('files panel: an incoming file waits for Save to Downloads or Decline', async () => {
    const api = await mountFull(ACTIVE, 'badge', [{ id: 'f1abcd', name: 'driver.zip', size: 3 * 1048576, direction: 'to_device', state: 'offered', done: 0 }])
    await act(async () => button('Files')!.click())
    await act(async () => {})
    const panel = host!.querySelector('[role="dialog"]')!
    expect(panel.textContent).toContain('Alice Admin wants to send you driver.zip (3.0 MB)')
    await act(async () => button('Save to Downloads')!.click())
    expect(api.acceptFile).toHaveBeenCalledWith('f1abcd')
    await act(async () => button('Decline')!.click())
    expect(api.rejectFile).toHaveBeenCalledWith('f1abcd')
    await act(async () => button('Send a file…')!.click())
    expect(api.offerFile).toHaveBeenCalled()
  })
})

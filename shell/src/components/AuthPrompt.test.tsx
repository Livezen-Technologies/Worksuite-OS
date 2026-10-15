// @vitest-environment jsdom
// G05 admin password prompt: ask, wrong password with tries left, locked out with countdown, no bridge = nothing.
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import AuthPrompt from './AuthPrompt'
import type { PolkitApi, PolkitPrompt } from '../lib/polkitApi'
import { countdown } from '../lib/polkitApi'

const g = globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }
beforeAll(() => { g.IS_REACT_ACT_ENVIRONMENT = true })
let root: Root | null = null
let host: HTMLDivElement | null = null
afterEach(() => { act(() => root?.unmount()); host?.remove(); delete window.worksuitePolkit })

const BASE: PolkitPrompt = { id: 'r1', actionId: 'org.worksuite.packagekit.install', message: 'App Center wants to install "Spotify" for all users.', program: 'App Center',
  user: 'alex', userDisplay: 'Alex Perera', remaining: 5, locked: false, lockedUntil: null, deny: 5, unlockTime: 300, failed: false, info: null, busy: false }

function mount(p: PolkitPrompt | null) {
  let push: (p: PolkitPrompt | null) => void = () => {}
  const api: PolkitApi = { state: vi.fn(async () => p), respond: vi.fn(async () => true), cancel: vi.fn(async () => true), onState: (cb) => { push = cb; return () => {} } }
  window.worksuitePolkit = api
  host = document.createElement('div'); document.body.append(host)
  root = createRoot(host)
  return { api, push: (n: PolkitPrompt | null) => act(() => push(n)) }
}

describe('AuthPrompt (G05)', () => {
  it('shows nothing without the agent bridge', async () => {
    host = document.createElement('div'); document.body.append(host); root = createRoot(host)
    await act(async () => root!.render(<AuthPrompt />))
    expect(host.textContent).toBe('')
  })
  it('asks for the administrator password and sends it to the agent', async () => {
    const { api } = mount(BASE)
    await act(async () => root!.render(<AuthPrompt />))
    expect(host!.querySelector('[role="alertdialog"]')?.textContent).toContain('Administrator access needed')
    expect(host!.textContent).toContain('org.worksuite.packagekit.install')
    const input = host!.querySelector<HTMLInputElement>('#au-pw')!
    expect(host!.querySelector('label[for="au-pw"]')?.textContent).toBe('Password for Alex Perera (administrator)')
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, 'secret')
      input.dispatchEvent(new Event('input', { bubbles: true }))
    })
    await act(async () => host!.querySelector('form')!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })))
    expect(api.respond).toHaveBeenCalledWith('r1', 'secret')
  })
  it('says how many tries are left, then shows the lockout', async () => {
    const { push } = mount(BASE)
    await act(async () => root!.render(<AuthPrompt />))
    push({ ...BASE, failed: true, remaining: 2 })
    expect(host!.querySelector('[role="alert"]')?.textContent).toBe('Wrong password. 2 tries left before a 5-minute lockout.')
    push({ ...BASE, failed: true, remaining: null, locked: true, lockedUntil: Date.now() + 292_000 })
    expect(host!.textContent).toContain('Too many attempts')
    expect(host!.textContent).toMatch(/locked on this device for 4:5\d after 5 wrong passwords/)
    expect(host!.querySelector<HTMLInputElement>('#au-pw')!.disabled).toBe(true)
    push({ ...BASE, failed: true, remaining: null, locked: true, lockedUntil: null, unlockTime: 0 })
    expect(host!.textContent).toContain('Ask IT to unlock it.')
  })
  it('cancel goes to the agent', async () => {
    const { api } = mount(BASE)
    await act(async () => root!.render(<AuthPrompt />))
    await act(async () => Array.from(host!.querySelectorAll('button')).find((b) => b.textContent === 'Cancel')!.click())
    expect(api.cancel).toHaveBeenCalledWith('r1')
  })
  it('formats the countdown', () => {
    expect(countdown(292_000, 0)).toBe('4:52')
    expect(countdown(0, 5000)).toBe('0:00')
  })
})

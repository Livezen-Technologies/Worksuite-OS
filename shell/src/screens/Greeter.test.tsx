// @vitest-environment jsdom
// The greeter lists the real accounts and preselects the session user; it never shows placeholder names.
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import Greeter from './Greeter'
import { os } from '../lib/os'

const g = globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }
beforeAll(() => { g.IS_REACT_ACT_ENVIRONMENT = true })
let root: Root | null = null
let host: HTMLDivElement | null = null
afterEach(() => { act(() => root?.unmount()); host?.remove(); root = null; host = null; vi.restoreAllMocks() })

async function render() {
  host = document.createElement('div'); document.body.append(host); root = createRoot(host)
  await act(async () => { root!.render(<Greeter onSignIn={() => {}} />) })
  await act(async () => { await Promise.resolve() })
}

describe('greeter users', () => {
  it('preselects the session user from the system account list', async () => {
    vi.spyOn(os, 'sysUsers').mockResolvedValue({ available: true, value: { current: 'kim', users: [
      { login: 'ann', name: 'Ann Lee', uid: 1000, admin: true }, { login: 'kim', name: 'Kim Diaz', uid: 1001, admin: false }] } })
    await render()
    expect(document.querySelector('h1')?.textContent).toBe('Kim Diaz')
    expect(document.body.textContent).not.toContain('Hasarinda')
  })
  it('falls back to Other user when accounts are unavailable', async () => {
    vi.spyOn(os, 'sysUsers').mockResolvedValue({ available: false, reason: 'service_unavailable' })
    await render()
    expect(document.querySelector('#ws-user')).not.toBeNull()
    expect(document.body.textContent).not.toContain('Hasarinda')
  })
})

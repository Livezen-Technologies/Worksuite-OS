// @vitest-environment jsdom
// WSOS-INT-010: the shell-drawn administrator prompt shows program, action and account, sends the password once and
// clears it, and says when a password was refused.
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { describe, expect, it } from 'vitest'
import type { PolkitApi } from './PolkitPrompt'

;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true

describe('polkit prompt', () => {
  it('shows the request and answers with the chosen account', async () => {
    const answers: string[] = []
    let push: (p: unknown) => void = () => {}
    const req = { cookie: 'c', action: 'org.freedesktop.policykit.exec', message: 'Authentication is needed to run gparted', program: 'gparted', accounts: ['alice', 'root'] }
    const api: PolkitApi = {
      request: async () => ({ request: req, retry: false }),
      answer: async (a, p) => { answers.push(`${a}:${p}`); return true },
      cancel: async () => { answers.push('cancel'); return true },
      onChange: (cb) => { push = cb; return () => {} },
    }
    ;(window as unknown as { worksuitePolkit: PolkitApi }).worksuitePolkit = api
    const { default: PolkitPrompt } = await import('./PolkitPrompt')
    const host = document.createElement('div'); document.body.append(host)
    const root = createRoot(host)
    await act(async () => { root.render(<PolkitPrompt />) })
    expect(host.textContent).toContain('gparted')
    expect(host.textContent).toContain('org.freedesktop.policykit.exec')
    const select = host.querySelector('select') as HTMLSelectElement
    expect([...select.options].map((o) => o.value)).toEqual(['alice', 'root'])
    const input = host.querySelector('input[type=password]') as HTMLInputElement
    const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!
    act(() => { set.call(input, 'pw1'); input.dispatchEvent(new Event('input', { bubbles: true })) })
    await act(async () => { (host.querySelector('button[type=submit]') as HTMLButtonElement).click() })
    expect(answers).toEqual(['alice:pw1'])
    expect((host.querySelector('input[type=password]') as HTMLInputElement).value).toBe('')
    await act(async () => { push({ request: req, retry: true }) })
    expect(host.querySelector('[role=alert]')?.textContent).toContain('not accepted')
    await act(async () => { [...host.querySelectorAll('button')].find((b) => b.textContent === 'Cancel')!.click() })
    expect(answers).toEqual(['alice:pw1', 'cancel'])
    act(() => root.unmount()); host.remove()
  })
})

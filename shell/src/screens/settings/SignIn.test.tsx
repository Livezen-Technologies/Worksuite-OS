// @vitest-environment jsdom
// Settings › Users › Sign-in options and the lock screen's method switcher (boards AuthMethods, AuthPin, AuthLockPin).
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { SignInOptions, weakPin } from './SignIn'
import Lock from '../Lock'
import { os, type SignInMethods } from '../../lib/os'

const g = globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }
beforeAll(() => { g.IS_REACT_ACT_ENVIRONMENT = true })
let root: Root | null = null
let host: HTMLDivElement | null = null
afterEach(() => { act(() => root?.unmount()); host?.remove(); document.body.innerHTML = ''; root = null; host = null; vi.restoreAllMocks() })

const base: SignInMethods = { pin: false, keys: [], default: 'password', allow_pin: true, pin_min_length: 6, pin_max_length: 12, attempt_limit: 3 }
async function render(el: React.ReactElement) {
  host = document.createElement('div'); document.body.append(host); root = createRoot(host)
  await act(async () => { root!.render(el) })
  await act(async () => { await Promise.resolve() })
}
const button = (name: string) => Array.from(document.querySelectorAll('button')).find((b) => b.textContent === name || b.getAttribute('aria-label') === name) as HTMLButtonElement
const click = async (b: HTMLElement) => { await act(async () => { b.click(); await Promise.resolve() }) }
async function digits(s: string) { for (const d of s) await click(button(d)) }

describe('weak PINs', () => {
  it('refuses repeats and runs like the helper does', () => {
    for (const p of ['111111', '123456', '654321', '890123']) expect(weakPin(p)).toBe(true)
    expect(weakPin('482915')).toBe(false)
  })
})

describe('Sign-in options', () => {
  it('sets up a PIN: create, confirm, then the helper gets it once', async () => {
    vi.spyOn(os, 'signinMethods').mockResolvedValue({ available: true, value: base })
    const set = vi.spyOn(os, 'signinPinSet').mockResolvedValue({ ok: true })
    await render(<SignInOptions />)
    await click(button('Set up'))
    expect(document.body.textContent).toContain('Create a PIN')
    await digits('123456')
    await click(button('Next'))
    expect(document.body.textContent).toContain('Too easy to guess')
    await digits('482915')
    await click(button('Next'))
    expect(document.body.textContent).toContain('Confirm your PIN')
    await digits('482915')
    await click(button('Save PIN'))
    expect(set).toHaveBeenCalledTimes(1)
    expect(set).toHaveBeenCalledWith('482915')
  })
  it('starts over when the confirmation differs', async () => {
    vi.spyOn(os, 'signinMethods').mockResolvedValue({ available: true, value: base })
    const set = vi.spyOn(os, 'signinPinSet')
    await render(<SignInOptions />)
    await click(button('Set up'))
    await digits('482915'); await click(button('Next'))
    await digits('482916'); await click(button('Save PIN'))
    expect(document.body.textContent).toContain('don’t match')
    expect(document.body.textContent).toContain('Create a PIN')
    expect(set).not.toHaveBeenCalled()
  })
  it('lists keys, removes one and offers only set-up methods as the default', async () => {
    vi.spyOn(os, 'signinMethods').mockResolvedValue({ available: true, value: { ...base, pin: true, default: 'pin', keys: [{ id: '0123456789abcdef', name: 'YubiKey', added: null }] } })
    const rm = vi.spyOn(os, 'signinKeyRemove').mockResolvedValue({ ok: true })
    await render(<SignInOptions />)
    const radios = Array.from(document.querySelectorAll('[role=radio]')).map((r) => r.textContent)
    expect(radios).toEqual(['Password', 'PIN', 'Security key'])
    await click(button('Remove YubiKey'))
    expect(rm).toHaveBeenCalledWith('0123456789abcdef')
  })
  it('hides PIN set-up when the organization turned it off', async () => {
    vi.spyOn(os, 'signinMethods').mockResolvedValue({ available: true, value: { ...base, allow_pin: false } })
    await render(<SignInOptions />)
    expect(document.body.textContent).toContain('Turned off by your organization')
    expect(Array.from(document.querySelectorAll('button')).filter((b) => b.textContent === 'Set up')).toHaveLength(1)
  })
  it('says when the password prompt was dismissed', async () => {
    vi.spyOn(os, 'signinMethods').mockResolvedValue({ available: true, value: base })
    vi.spyOn(os, 'signinKeyAdd').mockResolvedValue({ ok: false, error: 'auth_cancelled' })
    await render(<SignInOptions />)
    await click(Array.from(document.querySelectorAll('button')).filter((b) => b.textContent === 'Set up')[1])
    await click(button('Continue'))
    await act(async () => { await Promise.resolve() })
    expect(document.body.textContent).toContain('password prompt was closed')
  })
})

describe('lock screen switcher', () => {
  it('shows only Password without a PIN or key', async () => {
    vi.spyOn(os, 'signinMethods').mockResolvedValue({ available: true, value: base })
    await render(<Lock user="kim" onUnlock={() => {}} />)
    await click(button('Press any key or click to unlock') ?? document.querySelector('button')!)
    expect(document.querySelector('[role=radiogroup]')).toBeNull()
  })
  it('starts on the default method and sends the PIN with method pin', async () => {
    vi.spyOn(os, 'signinMethods').mockResolvedValue({ available: true, value: { ...base, pin: true, default: 'pin', keys: [{ id: '0123456789abcdef', name: 'k', added: null }] } })
    const auth = vi.spyOn(os, 'authenticate').mockResolvedValue({ ok: false })
    await render(<Lock user="kim" onUnlock={() => {}} />)
    await click(document.querySelector('button')!)
    const radios = Array.from(document.querySelectorAll('[role=radio]'))
    expect(radios.map((r) => r.textContent)).toEqual(['Password', 'PIN', 'Security key'])
    expect(radios[1].getAttribute('aria-checked')).toBe('true')
    const input = document.getElementById('ws-lock-pw') as HTMLInputElement
    expect(input.inputMode).toBe('numeric')
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, '4829')
      input.dispatchEvent(new Event('input', { bubbles: true }))
    })
    await act(async () => { input.form!.requestSubmit() })
    expect(auth).toHaveBeenCalledWith('kim', '4829', 'pin')
    expect(document.body.textContent).toContain('Incorrect PIN')
    await click(radios[2] as HTMLElement)
    expect(document.getElementById('ws-lock-pw')).toBeNull()
    await click(button('Unlock'))
    expect(auth).toHaveBeenLastCalledWith('kim', '', 'key')
  })
})

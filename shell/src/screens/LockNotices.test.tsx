// @vitest-environment jsdom
// WSOS-INT-007: the lock screen names the app of an app notification, never its summary or body.
// #25: it shows unread counts, Wi-Fi and battery state, and an announced, content-free error on a failed unlock.
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, describe, expect, it, vi } from 'vitest'
import Lock from './Lock'
import { os } from '../lib/os'

;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true

let root: Root | null = null
let host: HTMLDivElement | null = null
afterEach(() => { act(() => root?.unmount()); host?.remove(); root = null; host = null; vi.restoreAllMocks() })
async function render(el: React.ReactElement) {
  host = document.createElement('div'); document.body.append(host); root = createRoot(host)
  await act(async () => { root!.render(el) })
  await act(async () => { await Promise.resolve() })
  return host
}

describe('lock screen notices', () => {
  it('hides app notification content', async () => {
    const h = await render(<Lock user="u" onUnlock={() => {}} notices={[{ id: 'app-1', title: 'Salary details from HR', at: Date.now(), tone: 'ok', app: 'Mail' }]} />)
    expect(h.textContent).toContain('Mail')
    expect(h.textContent).not.toContain('Salary')
  })
  it('shows unread message and notification counts from the unread state', async () => {
    const at = Date.now()
    const notices = [{ id: 'app-1', title: 'Hi', at, tone: 'ok' as const, app: 'Chat' }, { id: 'app-2', title: 'Done', at, tone: 'ok' as const, app: 'Files' },
      { id: 'app-3', title: 'Old', at, tone: 'ok' as const, app: 'Mail' }]
    const h = await render(<Lock user="u" onUnlock={() => {}} notices={notices} unread={2} />)
    const list = h.querySelector('[aria-label="Unread while locked"]')!
    expect(list.textContent).toContain('1 unread message')
    expect(list.textContent).toContain('1 notification')
    expect(list.textContent).not.toContain('Hi')
  })
  it('shows no counts once everything is read', async () => {
    const h = await render(<Lock user="u" onUnlock={() => {}} notices={[{ id: 'app-1', title: 'x', at: Date.now(), tone: 'ok', app: 'Chat' }]} unread={0} />)
    expect(h.querySelector('[aria-label="Unread while locked"]')).toBeNull()
  })
})

describe('lock screen status', () => {
  it('names Wi-Fi and battery charging state', async () => {
    vi.spyOn(os, 'sysNetwork').mockResolvedValue({ available: true, value: { wifi_enabled: true, devices: [{ device: 'wlan0', type: 'wifi', state: 'connected', connection: 'Office' }], networks: [{ ssid: 'Office', signal: 80, security: 'WPA2', in_use: true }] } })
    vi.spyOn(os, 'sysBattery').mockResolvedValue({ available: true, value: { present: true, percentage: 42, state: 'charging', on_battery: false, time_to_full_s: 100, time_to_empty_s: null } })
    const h = await render(<Lock user="u" onUnlock={() => {}} />)
    const status = h.querySelector('[aria-label="Status"]')!
    expect(status.textContent).toContain('Wi-Fi connected to Office')
    expect(status.textContent).toContain('Battery 42%, charging')
  })
  it('draws no battery on a machine without one', async () => {
    vi.spyOn(os, 'sysBattery').mockResolvedValue({ available: false, reason: 'no_battery' })
    const h = await render(<Lock user="u" onUnlock={() => {}} />)
    expect(h.querySelector('[data-battery]')).toBeNull()
  })
})

describe('lock screen unlock', () => {
  it('announces a failed unlock without detail and keeps focus in the field', async () => {
    vi.spyOn(os, 'signinMethods').mockResolvedValue({ available: false, reason: 'service_unavailable' })
    vi.spyOn(os, 'authenticate').mockResolvedValue({ ok: false } as Awaited<ReturnType<typeof os.authenticate>>)
    const h = await render(<Lock user="u" onUnlock={() => {}} />)
    await act(async () => { window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter' })) })
    const input = h.querySelector<HTMLInputElement>('#ws-lock-pw')!
    expect(document.activeElement).toBe(input)
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, 'secret')
      input.dispatchEvent(new Event('input', { bubbles: true }))
    })
    expect(input.value).toBe('secret')
    await act(async () => { h.querySelector('form')!.requestSubmit() })
    const alert = h.querySelector('[role="alert"]')!
    expect(alert.textContent).toBe('Incorrect password. Try again.')
    expect(input.getAttribute('aria-invalid')).toBe('true')
    expect(input.value).toBe('')
    expect(document.activeElement).toBe(input)
  })
})

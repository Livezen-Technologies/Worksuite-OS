// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { KioskPanel } from './Kiosk'

const g = globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }
beforeAll(() => { g.IS_REACT_ACT_ENVIRONMENT = true })
let root: Root | null = null
let host: HTMLDivElement | null = null
afterEach(() => { act(() => root?.unmount()); host?.remove(); root = null; host = null })
const render = (n: React.ReactNode) => { host = document.createElement('div'); document.body.append(host); root = createRoot(host); act(() => root!.render(n)) }

describe('Settings › Managed › Kiosk mode', () => {
  it('shows what the policy makes this device run, read-only', () => {
    const back = vi.fn()
    render(<KioskPanel org="Livezen" onBack={back} kiosk={{ user: 'kiosk', app: { type: 'url', url: 'https://visitors.example.com/' }, allowed_urls: [], idle_reset_minutes: 5, show_on_screen_keyboard: false, exit_pin: true }} />)
    expect(host!.textContent).toContain('Livezen runs this device as a kiosk')
    expect(host!.textContent).toContain('https://visitors.example.com/')
    expect(host!.textContent).toContain('Only the start page')
    expect(host!.textContent).toContain('5 min')
    expect(host!.textContent).toContain('exit PIN')
    expect(host!.querySelector('[aria-current=true]')!.textContent).toContain('Web kiosk')
    expect(host!.querySelectorAll('input, select, [role=switch]')).toHaveLength(0)
    act(() => host!.querySelector('nav button')!.dispatchEvent(new MouseEvent('click', { bubbles: true })))
    expect(back).toHaveBeenCalled()
  })
  it('says so when the device is not a kiosk', () => {
    render(<KioskPanel org="Livezen" onBack={() => {}} kiosk={null} />)
    expect(host!.textContent).toContain('Kiosk mode is off')
    expect(host!.querySelector('[aria-current=true]')).toBeNull()
  })
})

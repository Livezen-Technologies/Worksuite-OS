// @vitest-environment jsdom
// Kiosk exit prompt (WSOS-AUTH-002): PIN entry, results, administrator path, no PIN when policy turns it off.
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import KioskExit, { KioskStatus, kioskStatusFrom } from './KioskExit'
import type { KioskApi } from '../lib/kioskApi'
import { t } from '../i18n'

const g = globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }
beforeAll(() => { g.IS_REACT_ACT_ENVIRONMENT = true })
let root: Root | null = null
let host: HTMLDivElement | null = null
afterEach(() => { act(() => root?.unmount()); host?.remove(); root = null; host = null })

async function mount(api: KioskApi) {
  host = document.createElement('div'); document.body.append(host)
  root = createRoot(host)
  await act(async () => { root!.render(<KioskExit api={api} />) })
  await act(async () => {})
  return host
}
const fakeApi = (o: Partial<KioskApi> & { exitPin?: boolean } = {}): KioskApi => ({
  info: vi.fn(async () => ({ exitPin: o.exitPin ?? true })),
  exitWithPin: o.exitWithPin ?? vi.fn(async () => 'wrong_pin' as const),
  exitAsAdmin: o.exitAsAdmin ?? vi.fn(async () => 'ok' as const),
  cancel: o.cancel ?? vi.fn(async () => {}),
})
const button = (h: HTMLElement, text: string) => [...h.querySelectorAll('button')].find((b) => b.textContent === text || b.getAttribute('aria-label') === text)!

describe('KioskExit', () => {
  it('PIN from the keypad goes to the helper; a wrong PIN is announced', async () => {
    const api = fakeApi()
    const h = await mount(api)
    const leave = button(h, t('kiosk.leave'))
    expect(leave.disabled).toBe(true)
    for (const d of '4829150') await act(async () => button(h, d).click())
    await act(async () => button(h, t('kiosk.deleteDigit')).click())
    expect((h.querySelector('#ke-pin') as HTMLInputElement).value).toBe('482915')
    await act(async () => leave.click())
    expect(api.exitWithPin).toHaveBeenCalledWith('482915')
    expect(h.querySelector('[role=alert]')?.textContent).toBe(t('kiosk.wrongPin'))
    expect((h.querySelector('#ke-pin') as HTMLInputElement).value).toBe('')
  })

  it('locked out after too many wrong PINs: keypad disabled, administrator path stays', async () => {
    const h = await mount(fakeApi({ exitWithPin: vi.fn(async () => 'locked_out' as const) }))
    for (const d of '123987') await act(async () => button(h, d).click())
    await act(async () => button(h, t('kiosk.leave')).click())
    expect(h.querySelector('[role=alert]')?.textContent).toBe(t('kiosk.lockedOut'))
    expect(button(h, '1').disabled).toBe(true)
    expect(button(h, t('kiosk.useAdmin')).disabled).toBe(false)
  })

  it('without an exit PIN only the administrator path is offered', async () => {
    const api = fakeApi({ exitPin: false })
    const h = await mount(api)
    expect(h.querySelector('#ke-pin')).toBeNull()
    expect(h.textContent).toContain(t('kiosk.exitBodyAdmin'))
    await act(async () => button(h, t('kiosk.useAdmin')).click())
    expect(api.exitAsAdmin).toHaveBeenCalled()
    expect(h.textContent).toContain(t('kiosk.leaving'))
  })

  it('Cancel closes the prompt', async () => {
    const api = fakeApi()
    const h = await mount(api)
    await act(async () => button(h, t('kiosk.cancel')).click())
    expect(api.cancel).toHaveBeenCalled()
  })
})

describe('kiosk status screens (board KioskStates)', () => {
  it('reads only known states and clean values from the query', () => {
    expect(kioskStatusFrom(new URLSearchParams('state=offline&host=work.example.com<script>&secs=8'))).toEqual({ state: 'offline', host: 'work.example.comscript', secs: 8, attempt: 0 })
    expect(kioskStatusFrom(new URLSearchParams('state=evil&secs=-1'))).toMatchObject({ state: 'starting', secs: 0 })
  })
  it('shows the idle warning, restart and offline states', async () => {
    const { createRoot } = await import('react-dom/client')
    const { act } = await import('react')
    for (const [props, text] of [
      [{ state: 'idle' as const, secs: 15 }, 'Starting over in 15 s'],
      [{ state: 'restarting' as const, attempt: 2 }, 'attempt 2'],
      [{ state: 'offline' as const, host: 'work.example.com', secs: 8 }, 'Can’t reach work.example.com. Trying again in 8 s'],
    ] as const) {
      const el = document.createElement('div'); document.body.append(el)
      const r = createRoot(el)
      act(() => r.render(<KioskStatus {...props} />))
      expect(el.textContent).toContain(text)
      act(() => r.unmount()); el.remove()
    }
  })
})

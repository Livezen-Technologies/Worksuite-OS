// @vitest-environment jsdom
// WSOS-IDN-004: when provisioning requires enrollment, first-run setup cannot be skipped or finished unenrolled.
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import FirstRun from './FirstRun'
import { os, type DeviceInfo } from '../lib/os'
import { t } from '../i18n'

const g = globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }
beforeAll(() => { g.IS_REACT_ACT_ENVIRONMENT = true })

let root: Root | null = null
let host: HTMLDivElement | null = null
afterEach(() => { act(() => root?.unmount()); host?.remove(); root = null; host = null; vi.restoreAllMocks() })

const info = (o: Partial<DeviceInfo>): DeviceInfo => ({ agent: true, device: null, managed: false, org_name: null, server: null, last_check_in: null, policies: null, ...o })

async function render(onDone = vi.fn()) {
  host = document.createElement('div')
  document.body.append(host)
  root = createRoot(host)
  await act(async () => { root!.render(<FirstRun onDone={onDone} />) })
  await act(async () => { await Promise.resolve() })
  return onDone
}
const button = (text: string) => [...document.querySelectorAll('button')].find((b) => b.textContent === text)
const click = async (b: HTMLElement) => { await act(async () => { b.click() }) }

describe('first-run setup and required enrollment', () => {
  it('offers "Skip setup" when nothing requires enrollment', async () => {
    vi.spyOn(os, 'deviceInfo').mockResolvedValue(info({ provisioning: { require_enrollment: false, server: null } }))
    const done = await render()
    await click(button(t('setup.skip'))!)
    expect(done).toHaveBeenCalled()
  })

  it('hides "Skip setup" and blocks the apps step until the device is enrolled', async () => {
    vi.spyOn(os, 'deviceInfo').mockResolvedValue(info({ provisioning: { require_enrollment: true, server: 'https://work.example.com' } }))
    await render()
    expect(button(t('setup.skip'))).toBeUndefined()
    await click(button(t('setup.getStarted'))!)
    for (let i = 0; i < 2; i++) await click(button(t('common.next'))!)
    expect(document.body.textContent).toContain(t('setup.enrollRequired'))
    const next = [...document.querySelectorAll('button')].find((b) => b.disabled && b.className.includes('bg-[#1F6BFF]'))
    expect(next).toBeTruthy()
  })

  it('does not apply to a device that is already managed', async () => {
    vi.spyOn(os, 'deviceInfo').mockResolvedValue(info({ managed: true, provisioning: { require_enrollment: true, server: null } }))
    await render()
    expect(button(t('setup.skip'))).toBeTruthy()
  })
})

describe('first-boot network step (WSOS-INS-009)', () => {
  const toApps = async () => {
    await click(button(t('setup.getStarted'))!)
    for (let i = 0; i < 2; i++) await click(button(t('common.next'))!)
    await act(async () => { await Promise.resolve() })
  }

  it('lists NetworkManager networks, sends the password to sysWifiConnect, and stays skippable', async () => {
    vi.spyOn(os, 'deviceInfo').mockResolvedValue(info({}))
    vi.spyOn(os, 'sysNetwork').mockResolvedValue({ available: true, value: { wifi_enabled: true, devices: [{ device: 'wlan0', type: 'wifi', state: 'disconnected', connection: null }], networks: [{ ssid: 'Office', signal: 70, security: 'WPA2', in_use: false }] } })
    const connect = vi.spyOn(os, 'sysWifiConnect').mockResolvedValue({ ok: true })
    await render()
    await toApps()
    expect(document.body.textContent).toContain(t('setup.network'))
    expect(document.body.textContent).toContain('Office')
    expect(document.body.textContent).toContain(t('common.notConnected'))
    const row = [...document.querySelectorAll('li')].find((l) => l.textContent?.includes('Office'))!
    await click([...row.querySelectorAll('button')][0])
    const pw = document.querySelector('input[type=password]') as HTMLInputElement
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(pw, 's3cret')
      pw.dispatchEvent(new Event('input', { bubbles: true }))
    })
    await act(async () => { (pw.form as HTMLFormElement).requestSubmit() })
    expect(connect).toHaveBeenCalledWith('Office', 's3cret')
    // The step is skippable: the primary button is enabled without a connection.
    const next = [...document.querySelectorAll('button')].find((b) => b.className.includes('bg-[#1F6BFF]') && !b.closest('form'))
    expect(next?.disabled).toBe(false)
  })

  it('says NetworkManager is unavailable instead of showing sample networks', async () => {
    vi.spyOn(os, 'deviceInfo').mockResolvedValue(info({}))
    vi.spyOn(os, 'sysNetwork').mockResolvedValue({ available: false, reason: 'service_unavailable' })
    await render()
    await toApps()
    expect(document.body.textContent).toContain(t('settings.notAvailable', { what: t('settings.net.info') }))
    expect(document.querySelectorAll('li').length).toBe(0)
  })
})

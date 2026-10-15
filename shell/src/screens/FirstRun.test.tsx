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

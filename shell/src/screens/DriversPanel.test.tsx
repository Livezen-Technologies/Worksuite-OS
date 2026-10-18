// @vitest-environment jsdom
// Settings › Drivers over the package service's driver report: device statuses by group (Display, Wi-Fi, Ethernet),
// checking online, the NVIDIA recommendation and Secure Boot steps, policy off, metered, installing with progress and
// friendly errors, and the "drivers available" notice.
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { DeviceWatcher, DriversPanel } from './Hardware'
import { os, type DriverOffer, type DriverReport, type HwDevice, type PackageJobEvent } from '../lib/os'
import { driverGroups, driverLabel, driverNotice } from '../lib/hardware'

const g = globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }
beforeAll(() => { g.IS_REACT_ACT_ENVIRONMENT = true })
let root: Root | null = null
let host: HTMLDivElement | null = null
afterEach(() => { act(() => root?.unmount()); host?.remove(); root = null; host = null; vi.restoreAllMocks() })
const flush = () => act(async () => { await new Promise((r) => setTimeout(r, 0)) })

const dev = (id: string, name: string, kind: HwDevice['kind'], driver: string | null): HwDevice =>
  ({ id, name, vendor: null, kind, bus: 'pci', built_in: true, driver, driver_version: null, driver_proprietary: null, ids: '0000:0000' })
const DEVS = [dev('pci:0000:00:14.3', 'Wi-Fi 6E AX211', 'wireless', 'iwlwifi'), dev('pci:0000:00:1f.6', 'I219-V', 'network', 'e1000e'), dev('pci:0000:01:00.0', 'GeForce RTX 4090', 'graphics', 'nouveau')]
const FW: DriverOffer = { id: 'fw:firmware-iwlwifi', device_id: 'pci:0000:00:14.3', name: 'firmware-iwlwifi', summary: 'firmware_missing', from_version: null, to_version: 'debian', license: 'proprietary', category: 'recommended', size_bytes: 24e6, restart: false, kind: 'firmware' }
const NV: DriverOffer = { id: 'gpu:nvidia-driver', device_id: 'pci:0000:01:00.0', name: 'NVIDIA proprietary driver', summary: 'nvidia_better', from_version: null, to_version: '550', license: 'proprietary', category: 'recommended', size_bytes: 400e6, restart: true, kind: 'gpu' }
const report = (o: Partial<DriverReport> = {}): DriverReport => ({
  state: 'idle', checked_at: 1, online_search: true, metered: false, secure_boot: false, auto_installed: [], offers: [FW, NV],
  devices: [
    { id: 'pci:0000:00:14.3', kind: 'wifi', driver: 'iwlwifi', status: 'missing_firmware', offers: [FW.id] },
    { id: 'pci:0000:00:1f.6', kind: 'ethernet', driver: 'e1000e', status: 'working', offers: [] },
    { id: 'pci:0000:01:00.0', kind: 'display', driver: 'nouveau', status: 'optional_driver', offers: [NV.id] },
  ], ...o,
})

function mockOs(r: DriverReport | null) {
  vi.spyOn(os, 'hwDevices').mockResolvedValue({ ok: true, value: DEVS })
  vi.spyOn(os, 'onDriversChanged').mockImplementation(() => () => {})
  return vi.spyOn(os, 'hwDriverReport').mockResolvedValue(r ? { ok: true, value: r } : { ok: false, error: 'unavailable' })
}
async function mount(node: React.ReactNode) { host = document.createElement('div'); document.body.append(host); root = createRoot(host); act(() => root!.render(node)); await flush(); return host }
const section = (el: HTMLElement, name: string) => el.querySelector(`section[aria-label="${name}"]`) as HTMLElement

describe('Settings › Drivers', () => {
  it('lists Display, Wi-Fi and Ethernet with each device’s driver and status', async () => {
    mockOs(report())
    const el = await mount(<DriversPanel onOpenUpdates={() => {}} />)
    expect(section(el, 'Display').textContent).toContain('GeForce RTX 4090')
    expect(section(el, 'Display').textContent).toContain('uses Mesa (nouveau)')
    expect(section(el, 'Display').textContent).toContain('Optional driver available')
    expect(section(el, 'Wi-Fi').textContent).toContain('Missing firmware')
    expect(section(el, 'Ethernet').textContent).toContain('Working')
  })

  it('recommends the NVIDIA driver with the reason, and keeps nouveau the default', async () => {
    mockOs(report())
    const el = await mount(<DriversPanel onOpenUpdates={() => {}} />)
    const nv = section(el, 'NVIDIA proprietary driver')
    expect(nv.textContent).toContain('Recommended'.toUpperCase())
    expect(nv.textContent).toContain('Better performance')
    expect(nv.textContent).toContain('nouveau')
    expect(el.textContent).toContain('Firmware for Wi-Fi 6E AX211')
    expect(el.textContent).not.toContain('firmware-iwlwifi')   // package names stay out of the UI
  })

  it('Secure Boot: the recommendation says so, and a pending MOK enrolment shows the steps and password', async () => {
    mockOs(report({ secure_boot: true, offers: [{ ...NV, summary: 'nvidia_secure_boot' }], mok: { password: '12345678', pending: true } }))
    const el = await mount(<DriversPanel onOpenUpdates={() => {}} />)
    expect(el.textContent).toContain('Secure Boot is on')
    const mok = section(el, 'One more step at the next restart')
    expect(mok.textContent).toContain('Enroll MOK')
    expect(mok.textContent).toContain('1234-5678')
  })

  it('“Check for drivers” shows the checking state, then the result', async () => {
    const spy = mockOs(report({ offers: [], devices: [] }))
    let done: (v: { ok: true; value: DriverReport }) => void = () => {}
    const el = await mount(<DriversPanel onOpenUpdates={() => {}} />)
    expect(el.textContent).toContain('Drivers are up to date')
    spy.mockImplementation(() => new Promise((r) => { done = r }))
    const btn = [...el.querySelectorAll('button')].find((b) => b.textContent === 'Check for drivers')!
    await act(async () => { btn.click() })
    expect(spy).toHaveBeenLastCalledWith(true)
    expect(el.textContent).toContain('Looking for drivers online')
    await act(async () => { done({ ok: true, value: report() }) })
    expect(el.textContent).not.toContain('Looking for drivers online')
    expect(el.textContent).toContain('1 driver update')
  })

  it('policy off, metered and fallback notes; no package service → the honest fallback', async () => {
    mockOs(report({ state: 'off', offers: [] }))
    expect((await mount(<DriversPanel onOpenUpdates={() => {}} />)).textContent).toContain('turned off')
    act(() => root?.unmount()); host?.remove(); vi.restoreAllMocks()
    mockOs(report({ metered: true, gpu_fallback: true }))
    const el = await mount(<DriversPanel onOpenUpdates={() => {}} />)
    expect(el.textContent).toContain('metered connection')
    expect(el.textContent).toContain('went back to the built-in display driver')
    act(() => root?.unmount()); host?.remove(); vi.restoreAllMocks()
    mockOs(null)
    expect((await mount(<DriversPanel onOpenUpdates={() => {}} />)).textContent).toContain('Driver updates come with WorkSuite OS updates.')
  })

  it('installs with progress; a failure is shown in friendly words', async () => {
    mockOs(report())
    let emit: (e: PackageJobEvent) => void = () => {}
    vi.spyOn(os, 'onPkgJob').mockImplementation((cb) => { emit = cb; return () => {} })
    const install = vi.spyOn(os, 'hwInstallDrivers').mockResolvedValue({ ok: true, value: '/job/7' })
    const el = await mount(<DriversPanel onOpenUpdates={() => {}} />)
    await act(async () => { [...el.querySelectorAll('button')].find((b) => b.textContent === 'Install selected')!.click() })
    await flush()
    expect(install).toHaveBeenCalledWith(['fw:firmware-iwlwifi'])
    await act(async () => { emit({ job: '/job/7', kind: 'progress', percent: 40, phase: 'fw:firmware-iwlwifi' }) })
    expect(document.body.textContent).toContain('Installing driver updates')
    expect(document.body.querySelector('[role=progressbar]')).not.toBeNull()
    await act(async () => { emit({ job: '/job/7', kind: 'finished', result: 'failed', error: 'apt-get: E: Unable to locate package firmware-iwlwifi' }) })
    const alert = document.body.querySelector('[role=alert]')!.textContent!
    expect(alert).not.toContain('apt-get')
  })
})

describe('driver helpers', () => {
  it('groups and labels display drivers', () => {
    const gs = driverGroups(DEVS, report())
    expect(gs.map((x) => x.group)).toEqual(['display', 'wifi', 'ethernet'])
    expect(driverLabel('amdgpu', null)).toBe('Mesa (amdgpu)')
    expect(driverLabel('nvidia', '550.163.01')).toBe('NVIDIA 550')
  })

  it('notice: the Wi-Fi wording; auto-installed and already announced offers are quiet', () => {
    const seen = new Set<string>()
    expect(driverNotice(report({ offers: [FW] }), DEVS, seen)?.title).toBe('Drivers available for your Wi-Fi card')
    expect(driverNotice(report({ offers: [FW], auto_installed: [FW.id] }), DEVS, seen)).toBeNull()
    expect(driverNotice(report({ offers: [FW, NV] }), DEVS, seen)?.title).toBe('A better driver is available for your graphics card')
    expect(driverNotice(report({ offers: [FW] }), DEVS, new Set([FW.id]))).toBeNull()
  })

  it('DeviceWatcher shows the notice from a background check and posts it to the notification centre', async () => {
    let push: (r: DriverReport) => void = () => {}
    vi.spyOn(os, 'hwDevices').mockResolvedValue({ ok: true, value: DEVS })
    vi.spyOn(os, 'onDriversChanged').mockImplementation((cb) => { push = cb; return () => {} })
    const notify = vi.spyOn(os, 'driversNotify').mockResolvedValue(1)
    const open = vi.fn()
    const el = await mount(<DeviceWatcher onOpenUpdates={() => {}} onOpenDrivers={open} />)
    await act(async () => { push(report({ offers: [FW] })) })
    await flush()
    expect(el.textContent).toContain('Drivers available for your Wi-Fi card')
    expect(notify).toHaveBeenCalledWith('Drivers available for your Wi-Fi card', 'Open Settings › Drivers to install them.')
    await act(async () => { [...el.querySelectorAll('button')].find((b) => b.textContent === 'View')!.click() })
    expect(open).toHaveBeenCalled()
  })
})

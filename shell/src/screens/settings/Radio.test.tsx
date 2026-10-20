// @vitest-environment jsdom
// Wi-Fi and Bluetooth troubleshooting (#31): problems in words with their fixes (turn on, restart the service, find
// drivers), adapter details that can be copied, and Settings › Graphics (#16): acceleration status and fallback.
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { RadioProblems } from './Radio'
import { GraphicsPanel, accelSummary } from './Graphics'
import { os } from '../../lib/os'
import { onSettingsSection } from '../../lib/settingsNav'
import type { RadioDiagnosis } from '../../../electron/radios'
import type { GraphicsState } from '../../../electron/graphics'

const g = globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }
beforeAll(() => { g.IS_REACT_ACT_ENVIRONMENT = true })
let root: Root | null = null
let host: HTMLDivElement | null = null
afterEach(() => { act(() => root?.unmount()); host?.remove(); root = null; host = null; vi.restoreAllMocks() })
const flush = () => act(async () => { await new Promise((r) => setTimeout(r, 0)) })
async function mount(node: React.ReactNode) { host = document.createElement('div'); document.body.append(host); root = createRoot(host); act(() => root!.render(node)); await flush(); return host }
const button = (el: HTMLElement, text: string) => [...el.querySelectorAll('button')].find((b) => b.textContent === text) as HTMLButtonElement

const diag = (o: Partial<RadioDiagnosis>): RadioDiagnosis & { text: string } => ({
  kind: 'wifi', status: 'problem', adapters: [], hardware: [], service: 'active', problems: [], text: 'Wi-Fi: problem', ...o,
})

describe('RadioProblems', () => {
  it('shows each problem with its fix and applies it', async () => {
    const fix = vi.spyOn(os, 'radioFix').mockResolvedValue({ ok: true, value: true })
    const onFixed = vi.fn()
    const d = diag({ status: 'off', adapters: [{ name: 'wlan0', device: 'Wi-Fi 6 AX201', driver: 'iwlwifi', soft_blocked: true, hard_blocked: false }],
      problems: [{ code: 'soft_blocked', device: 'Wi-Fi 6 AX201', fix: 'unblock' }, { code: 'service_stopped', device: null, fix: 'restart_service' }] })
    const el = await mount(<RadioProblems kind="wifi" d={d} onFixed={onFixed} />)
    const alerts = [...el.querySelectorAll('[role="alert"]')].map((a) => a.textContent)
    expect(alerts[0]).toContain('Wi-Fi 6 AX201 is turned off')
    expect(alerts[1]).toContain('The system service isn’t running')
    await act(async () => { button(el, 'Turn on').click() })
    await flush()
    expect(fix).toHaveBeenCalledWith('wifi', 'unblock')
    expect(onFixed).toHaveBeenCalled()
    fix.mockResolvedValue({ ok: false, error: 'not_allowed' })
    await act(async () => { button(el, 'Restart service').click() })
    await flush()
    expect(fix).toHaveBeenLastCalledWith('wifi', 'restart_service')
    expect(el.textContent).toContain('An administrator’s approval is needed')
  })

  it('missing drivers open Settings › Drivers; details list adapters and hardware', async () => {
    const seen: string[] = []
    const off = onSettingsSection((s) => seen.push(s))
    const d = diag({ kind: 'bluetooth', hardware: [{ name: 'MT7922 Bluetooth', driver: null, ids: '14c3:0616' }], problems: [{ code: 'no_driver', device: 'MT7922 Bluetooth', fix: 'find_driver' }] })
    const el = await mount(<RadioProblems kind="bluetooth" d={d} onFixed={() => {}} />)
    expect(el.textContent).toContain('No driver for MT7922 Bluetooth')
    act(() => button(el, 'Find drivers').click())
    expect(seen).toEqual(['Drivers'])
    off()
    act(() => button(el, 'Adapter details').click())
    expect(el.querySelector('dl')?.textContent).toContain('14c3:0616')
    expect(el.querySelector('dl')?.textContent).toContain('driver none')
  })

  it('renders nothing while all is well unless asked to', async () => {
    const el = await mount(<RadioProblems kind="wifi" d={diag({ status: 'ok' })} onFixed={() => {}} />)
    expect(el.textContent).toBe('')
  })
})

const GFX: GraphicsState = {
  gpus: [{ name: 'Navi 33', vendor: 'AMD', ids: '1002:7480', driver: 'amdgpu', driver_version: null, proprietary: false, virtual: false }],
  compositor: { renderer: 'gpu', reason: null, choice: 'auto', fell_back: false },
  apps: { accelerated: true, disabled_reason: null, features: { gpu_compositing: 'enabled', video_decode: 'enabled', webgl: 'enabled' }, gl_renderer: 'AMD Radeon RX 7600 (radeonsi)', gl_version: 'OpenGL ES 3.2 Mesa 25.0.7', driver_vendor: 'Mesa', driver_version: '25.0.7' },
  vaapi: { available: true, driver: 'Mesa Gallium driver 25.0.7 for AMD Radeon RX 7600', decode: ['H264Main', 'AV1Profile0'], encode: ['H264Main'] },
  vulkan: { available: true, api_version: '1.4.305', devices: [{ name: 'AMD Radeon RX 7600 (RADV NAVI33)', type: 'discrete_gpu', driver: 'radv' }] },
}

describe('GraphicsPanel', () => {
  it('shows the GPU, its driver, APIs and acceleration status, and saves the renderer choice', async () => {
    vi.spyOn(os, 'graphics').mockResolvedValue({ ok: true, value: GFX })
    const set = vi.spyOn(os, 'graphicsSetRenderer').mockResolvedValue({ ok: true, value: true })
    const el = await mount(<GraphicsPanel onOpen={() => {}} />)
    expect(el.querySelector('[role="status"]')?.textContent).toContain('On: the desktop and apps are drawn by the graphics card')
    expect(el.textContent).toContain('AMD Navi 33')
    expect(el.textContent).toContain('Driver: amdgpu')
    expect(el.textContent).toContain('OpenGL ES 3.2 Mesa 25.0.7')
    expect(el.textContent).toContain('1.4.305 · AMD Radeon RX 7600 (RADV NAVI33)')
    expect(el.textContent).toContain('H264Main, AV1Profile0')
    const soft = [...el.querySelectorAll('input[type="radio"]')][2] as HTMLInputElement
    await act(async () => { soft.click() })
    await flush()
    expect(set).toHaveBeenCalledWith('software')
    expect(el.textContent).toContain('takes effect the next time you sign in')
  })

  it('explains software rendering and offers to try the GPU again after a fallback', async () => {
    const fell: GraphicsState = { ...GFX, compositor: { ...GFX.compositor, renderer: 'software', fell_back: true }, apps: { ...GFX.apps, accelerated: false, disabled_reason: 'software_session' } }
    expect(accelSummary(fell)).toEqual({ on: false, text: expect.stringContaining('didn’t start on the graphics card') })
    expect(accelSummary({ ...GFX, gpus: [{ ...GFX.gpus[0], driver: 'virtio_gpu', virtual: true }], compositor: { ...GFX.compositor, renderer: 'software' } }).text).toContain('virtual machine')
    expect(accelSummary({ ...GFX, apps: { ...GFX.apps, disabled_reason: 'gpu_crashed' } }).text).toContain('stopped responding')
    vi.spyOn(os, 'graphics').mockResolvedValue({ ok: true, value: fell })
    const reset = vi.spyOn(os, 'graphicsReset').mockResolvedValue({ ok: true, value: true })
    const el = await mount(<GraphicsPanel onOpen={() => {}} />)
    await act(async () => { button(el, 'Try the graphics card again').click() })
    await flush()
    expect(reset).toHaveBeenCalled()
  })
})

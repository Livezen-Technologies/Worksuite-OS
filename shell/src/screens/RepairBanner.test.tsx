// @vitest-environment jsdom
// WSOS-APT-006: Settings › Updates surfaces an interrupted dpkg run and runs the audited Repair.
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { RepairBanner } from './Updates'
import { os, type PackageJobEvent } from '../lib/os'

const g = globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }
beforeAll(() => { g.IS_REACT_ACT_ENVIRONMENT = true })
let root: Root | null = null
let host: HTMLDivElement | null = null
afterEach(() => { act(() => root?.unmount()); host?.remove(); root = null; host = null; vi.restoreAllMocks() })
const flush = () => act(async () => { await new Promise((r) => setTimeout(r, 0)) })
async function mount() { host = document.createElement('div'); document.body.append(host); root = createRoot(host); act(() => root!.render(<RepairBanner />)); await flush(); return host }

describe('RepairBanner', () => {
  it('shows nothing when packages are fine or the service is unavailable', async () => {
    vi.spyOn(os, 'pkgState').mockResolvedValue({ ok: true, value: 'idle' })
    expect((await mount()).textContent).toBe('')
    act(() => root?.unmount()); host?.remove()
    vi.spyOn(os, 'pkgState').mockResolvedValue({ ok: false, error: 'service_unavailable' })
    expect((await mount()).textContent).toBe('')
  })

  it('interrupted: Repair starts the job; success clears the warning', async () => {
    const state = vi.spyOn(os, 'pkgState').mockResolvedValue({ ok: true, value: 'interrupted' })
    let emit: (e: PackageJobEvent) => void = () => {}
    vi.spyOn(os, 'onPkgJob').mockImplementation((cb) => { emit = cb; return () => {} })
    const repair = vi.spyOn(os, 'pkgRepair').mockResolvedValue({ ok: true, value: '/job/1' })
    const el = await mount()
    expect(el.querySelector('[role=alert]')!.textContent).toContain('interrupted')
    await act(async () => { el.querySelector('button')!.click() })
    expect(repair).toHaveBeenCalledOnce()
    expect(el.querySelector('button')!.disabled).toBe(true)
    state.mockResolvedValue({ ok: true, value: 'idle' })
    await act(async () => { emit({ job: '/job/1', kind: 'finished', result: 'success' } as PackageJobEvent) })
    await flush()
    expect(el.textContent).toContain('Packages repaired')
    expect(el.querySelector('button')).toBeNull()
  })

  it('a refused password shows the error and keeps Repair available', async () => {
    vi.spyOn(os, 'pkgState').mockResolvedValue({ ok: true, value: 'interrupted' })
    vi.spyOn(os, 'pkgRepair').mockResolvedValue({ ok: false, error: 'not_authorized' })
    const el = await mount()
    await act(async () => { el.querySelector('button')!.click() })
    expect(el.querySelector('button')!.disabled).toBe(false)
    expect(el.querySelector('.text-\\[\\#FCA5A5\\]')).not.toBeNull()
  })
})

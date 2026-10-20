// @vitest-environment jsdom
// Settings › Updates: update history from the package service (offered release with notes, pending, installed and
// failed updates of every kind, worded failures) and app updates with "Update all" (reserved by policy).
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { AppUpdatesSection, HistorySection } from './Updates'
import { os, type OsUpdateStatus, type PackageJobEvent } from '../lib/os'

const g = globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }
beforeAll(() => { g.IS_REACT_ACT_ENVIRONMENT = true })
let root: Root | null = null
let host: HTMLDivElement | null = null
afterEach(() => { act(() => root?.unmount()); host?.remove(); root = null; host = null; vi.restoreAllMocks() })
const flush = () => act(async () => { await new Promise((r) => setTimeout(r, 0)) })
async function mount(node: React.ReactNode) { host = document.createElement('div'); document.body.append(host); root = createRoot(host); act(() => root!.render(node)); await flush(); return host }

const ST: OsUpdateStatus = { state: 'waiting', version: '1.5.0', installed: '1.4.2', release_id: 'os-1.5.0', mandatory: false, deadline: null, deferrals_left: null,
  reason: 'major_upgrade', restart_at: null, last_check: 1, notes: 'New Start menu.', download_bytes: 700e6, upgrade: true }

describe('update history', () => {
  it('shows the offered release with notes and size, then pending, installed and failed entries without raw errors', async () => {
    vi.spyOn(os, 'onPkgJob').mockImplementation(() => () => {})
    vi.spyOn(os, 'updateHistory').mockResolvedValue({ ok: true, value: {
      pending: [{ id: 'job-3', kind: 'app', title: 'org.gimp.GIMP', version: null, result: 'pending', started_at: 5 }],
      entries: [
        { id: 'e2', kind: 'firmware', title: 'Dell UEFI firmware', version: '1.20', result: 'failed', started_at: 3, finished_at: 4, error: 'fwupdmgr: exit 1' },
        { id: 'e1', kind: 'os', title: 'WorkSuite OS', version: '1.4.2', result: 'success', started_at: 1, finished_at: 2, reboot_required: true },
      ] } })
    const el = await mount(<HistorySection st={ST} offered="1.5.0" />)
    const text = el.textContent!
    expect(text).toContain('WorkSuite OS 1.5.0')
    expect(text).toContain('Download 700')
    expect(text).toContain('Version upgrade')
    expect(text).toContain('New Start menu.')
    expect(text).toContain('Pending')
    expect(text).toContain('Dell UEFI firmware 1.20')
    expect(text).toContain('Failed')
    expect(text).toContain('Restart needed')
    expect(text).not.toContain('fwupdmgr')   // diagnostics stay with administrators
  })

  it('says when nothing was installed yet', async () => {
    vi.spyOn(os, 'onPkgJob').mockImplementation(() => () => {})
    vi.spyOn(os, 'updateHistory').mockResolvedValue({ ok: true, value: { pending: [], entries: [] } })
    const el = await mount(<HistorySection st={{ ...ST, notes: null }} offered={null} />)
    expect(el.textContent).toContain('No updates have been installed on this computer yet.')
  })
})

describe('app updates', () => {
  it('lists Flatpak updates and updates all of them as one job', async () => {
    let listener: ((e: PackageJobEvent) => void) | null = null
    vi.spyOn(os, 'onPkgJob').mockImplementation((cb) => { listener = cb; return () => {} })
    vi.spyOn(os, 'appUpdates').mockResolvedValue({ ok: true, value: [{ id: 'flatpak:org.gimp.GIMP', name: 'GIMP', version: '2.10.40', download_size: '120 MB' }] })
    const upd = vi.spyOn(os, 'updateApps').mockResolvedValue({ ok: true, value: '/job/7' })
    const el = await mount(<AppUpdatesSection reserved={false} />)
    expect(el.textContent).toContain('GIMP')
    expect(el.textContent).toContain('2.10.40 · 120 MB')
    const btn = [...el.querySelectorAll('button')].find((b) => b.textContent === 'Update all')!
    await act(async () => { btn.click() })
    expect(upd).toHaveBeenCalledWith([])
    await act(async () => { listener!({ kind: 'finished', job: '/job/7', result: 'success' } as PackageJobEvent) })
    await flush()
    expect(el.textContent).toContain('Apps updated.')
  })

  it('has no Update all when the organization reserves app updates', async () => {
    vi.spyOn(os, 'onPkgJob').mockImplementation(() => () => {})
    vi.spyOn(os, 'appUpdates').mockResolvedValue({ ok: true, value: [{ id: 'flatpak:org.gimp.GIMP', name: 'GIMP', version: null, download_size: null }] })
    const el = await mount(<AppUpdatesSection reserved />)
    expect([...el.querySelectorAll('button')].some((b) => b.textContent === 'Update all')).toBe(false)
    expect(el.textContent).toContain('Your organization updates apps on this computer.')
  })
})

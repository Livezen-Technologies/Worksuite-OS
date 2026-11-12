// @vitest-environment jsdom
// Settings › Updates › Update from a USB drive: after the bundle installs, the card stops offering it (VM finding).
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { OfflineUpdates } from './UpdatesOffline'
import { os, type OsUpdateStatus, type PackageJobEvent } from '../lib/os'
import { setLocale } from '../i18n'

const g = globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }
beforeAll(() => { g.IS_REACT_ACT_ENVIRONMENT = true; setLocale('en') })
let root: Root | null = null
let host: HTMLDivElement | null = null
afterEach(() => { act(() => root?.unmount()); host?.remove(); root = null; host = null; vi.restoreAllMocks() })
const flush = () => act(async () => { await new Promise((r) => setTimeout(r, 0)) })

const st = { state: 'up_to_date', version: null, installed: '1.0.1~qa1', release_id: null, mandatory: false, deadline: null, deferrals_left: null, reason: null, restart_at: null, last_check: 1 } as unknown as OsUpdateStatus

describe('USB update card', () => {
  it('offers Install for a newer signed bundle, and stops offering it once it is installed', async () => {
    vi.spyOn(os, 'bundleInspect').mockResolvedValue({ ok: true, value: { release_id: 'rel-1.0.1~qa2', version: '1.0.1~qa2', packages: 13, bytes: 138e6, critical: false, verified: true } } as never)
    let emit: (e: PackageJobEvent) => void = () => {}
    vi.spyOn(os, 'onPkgJob').mockImplementation((cb) => { emit = cb; return () => {} })
    const install = vi.spyOn(os, 'bundleInstall').mockResolvedValue({ ok: true, value: '/job/2' })
    host = document.createElement('div'); document.body.append(host); root = createRoot(host)
    act(() => root!.render(<OfflineUpdates st={st} job={null} policy={null as never} orgName={null} bundles={[{ handle: 'wsupdate:1', name: 'worksuite-os-1.0.1~qa2-amd64.wsupdate', drive: 'WSQA3' }]} />))
    await flush()
    const button = () => [...host!.querySelectorAll('button')].find((b) => /Install from USB|Choose file/.test(b.textContent ?? ''))!
    expect(host.textContent).toContain('newer than installed (1.0.1~qa1)')
    expect(button().textContent).toBe('Install from USB')
    await act(async () => { button().click() })
    expect(install).toHaveBeenCalledWith('wsupdate:1')
    await act(async () => { emit({ job: '/job/2', kind: 'finished', result: 'success' } as PackageJobEvent) })
    await flush()
    expect(host.textContent).toContain('The offline update is installed')
    expect(host.textContent).toContain('not newer than installed (1.0.1~qa2)')
    expect(button().textContent).not.toBe('Install from USB')
  })
})

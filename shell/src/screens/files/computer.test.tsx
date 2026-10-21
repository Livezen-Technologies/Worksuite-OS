// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { os, type DiskVolume } from '../../lib/os'
import { ComputerView, volName } from './computer'

const g = globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }
beforeAll(() => { g.IS_REACT_ACT_ENVIRONMENT = true })
let root: Root | null = null
let host: HTMLDivElement | null = null
afterEach(() => { act(() => root?.unmount()); host?.remove(); root = null; host = null; vi.restoreAllMocks() })
async function render(node: React.ReactNode) { host = document.createElement('div'); document.body.append(host); root = createRoot(host); await act(async () => root!.render(node)) }
const button = (name: string) => [...host!.querySelectorAll<HTMLButtonElement>('button')].find((b) => b.textContent === name || b.getAttribute('aria-label') === name)!

const vol = (p: Partial<DiskVolume>): DiskVolume => ({ device: '/dev/sda1', disk: '/dev/sda', label: 'Data', model: 'WDC', fstype: 'ntfs', kind: 'internal', size: 1e12, mountpoint: null, total: null, free: null, encrypted: false, locked: false, readOnly: false, root: null, ...p })
const VOLS = [
  vol({ device: '/dev/nvme0n1p6', disk: '/dev/nvme0n1', label: '', kind: 'system', mountpoint: '/', total: 400e9, free: 100e9, encrypted: true, root: 'home' }),
  vol({}),
  vol({ device: '/dev/sdb1', disk: '/dev/sdb', label: 'KINGSTON', kind: 'removable', size: 31e9, mountpoint: '/media/alex/KINGSTON', total: 31e9, free: 18e9, root: 'media:KINGSTON' }),
]

describe('This Computer (#63)', () => {
  it('lists disks and removable drives with name and free/total space', async () => {
    vi.spyOn(os, 'filesVolumes').mockResolvedValue({ ok: true, value: VOLS })
    await render(<ComputerView onOpen={() => {}} onChanged={() => {}} />)
    const text = host!.textContent!
    expect(text).toContain('Disks')
    expect(text).toContain('Removable drives')
    expect(text).toContain('System')
    expect(text).toMatch(/100(\.0)? GB free of 400(\.0)? GB/)
    expect(text).toContain('not mounted')
    expect(text).toContain('KINGSTON')
    expect(button('Eject KINGSTON')).toBeTruthy()
    expect(button('Unmount')).toBeTruthy()            // only KINGSTON: the system disk has no Unmount
    expect([...host!.querySelectorAll('button')].filter((b) => b.textContent === 'Unmount')).toHaveLength(1)
  })
  it('mounting opens the volume; errors are shown in words', async () => {
    vi.spyOn(os, 'filesVolumes').mockResolvedValue({ ok: true, value: VOLS })
    const mount = vi.spyOn(os, 'filesVolMount').mockResolvedValueOnce({ ok: true, value: 'media:Data' }).mockResolvedValueOnce({ ok: false, error: 'auth_cancelled' })
    const onOpen = vi.fn()
    await render(<ComputerView onOpen={onOpen} onChanged={() => {}} />)
    await act(async () => button('Mount').click())
    expect(mount).toHaveBeenCalledWith('/dev/sda1')
    expect(onOpen).toHaveBeenCalledWith('media:Data')
    await act(async () => button('Mount').click())
    expect(host!.querySelector('[role=alert]')!.textContent).toContain('administrator prompt was closed')
  })
  it('says when udisks2 is not running', async () => {
    vi.spyOn(os, 'filesVolumes').mockResolvedValue({ ok: false, error: 'unavailable' })
    await render(<ComputerView onOpen={() => {}} onChanged={() => {}} />)
    expect(host!.textContent).toContain('udisks2')
  })
  it('names unlabelled volumes by size', () => {
    expect(volName(vol({ label: '', size: 64e9, kind: 'removable' }))).toMatch(/64(\.0)? GB volume/)
  })
})

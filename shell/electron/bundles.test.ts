import { mkdirSync, mkdtempSync, utimesSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { mountRemovable, findBundles } from './bundles'
import type { DiskVolume } from './volumes'

describe('findBundles', () => {
  it('lists top-level .wsupdate files on each drive, newest first', () => {
    const t = mkdtempSync(path.join(os.tmpdir(), 'wsb-'))
    const a = path.join(t, 'KINGSTON'), b = path.join(t, 'SANDISK')
    mkdirSync(path.join(a, 'sub'), { recursive: true }); mkdirSync(b)
    writeFileSync(path.join(a, 'worksuite-1.1.2-offline.wsupdate'), 'x')
    writeFileSync(path.join(a, 'notes.txt'), 'x')
    writeFileSync(path.join(a, 'sub', 'deep.wsupdate'), 'x')
    writeFileSync(path.join(a, '.hidden.wsupdate'), 'x')
    mkdirSync(path.join(b, 'dir.wsupdate'))
    writeFileSync(path.join(b, 'worksuite-1.1.1-offline.wsupdate'), 'x')
    utimesSync(path.join(b, 'worksuite-1.1.1-offline.wsupdate'), 1, 1)
    const r = findBundles([{ label: 'KINGSTON', path: a }, { label: 'SANDISK', path: b }, { label: 'GONE', path: path.join(t, 'missing') }])
    expect(r.map((x) => [x.drive, x.name])).toEqual([['KINGSTON', 'worksuite-1.1.2-offline.wsupdate'], ['SANDISK', 'worksuite-1.1.1-offline.wsupdate']])
  })
})

describe('mountRemovable (Install from a USB drive)', () => {
  const vol = (o: Partial<DiskVolume>): DiskVolume => ({ device: '/dev/sda1', disk: '/dev/sda', label: '', model: '', fstype: 'vfat', kind: 'removable', size: 1, mountpoint: null,
    total: null, free: null, encrypted: false, locked: false, readOnly: false, ...o })
  it('mounts plugged-in removable drives only: not internal disks, locked or already mounted volumes, or odd filesystems', async () => {
    const mounted: string[] = []
    const vols = {
      list: async () => ({ ok: true as const, value: [
        vol({ device: '/dev/sda1' }),
        vol({ device: '/dev/sdb1', fstype: 'exfat' }),
        vol({ device: '/dev/sdc1', mountpoint: '/media/u/KEYS' }),
        vol({ device: '/dev/sdd1', locked: true, encrypted: true, fstype: 'crypto_LUKS' }),
        vol({ device: '/dev/nvme0n1p3', kind: 'internal', fstype: 'ext4' }),
        vol({ device: '/dev/sde1', fstype: 'swap' }),
        vol({ device: '/dev/sr0', kind: 'optical', fstype: 'iso9660' }),
      ] }),
      mount: async (d: string) => { mounted.push(d); return d === '/dev/sdb1' ? { ok: false as const, error: 'failed' } : { ok: true as const, value: `/media/u/${d.slice(5)}` } },
    }
    expect(await mountRemovable(vols)).toEqual(['/media/u/sda1'])
    expect(mounted).toEqual(['/dev/sda1', '/dev/sdb1'])
  })
  it('does nothing when the drive list is unavailable', async () => {
    expect(await mountRemovable({ list: async () => ({ ok: false as const, error: 'unavailable' }), mount: async () => { throw new Error('no') } })).toEqual([])
  })
})

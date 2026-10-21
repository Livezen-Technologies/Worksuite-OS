import { EventEmitter } from 'node:events'
import type { ChildProcess } from 'node:child_process'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { blockMounts, extraMounts, LSBLK_ARGS, mountedPath, parseVolumes, rootFor, volumeError, volumesBridge, watchVolumes, withSpace, type VolExec } from './volumes'
import { roots } from './files'

// `lsblk -J -b -o NAME,PATH,SIZE,LABEL,PARTLABEL,FSTYPE,MOUNTPOINTS,RM,HOTPLUG,RO,TYPE,TRAN,PARTTYPE,MODEL` (util-linux
// 2.41, Debian 13) on a dual-boot laptop: NVMe with EFI + MSR + Windows + WinRE + Debian (LUKS → ext4 /) + swap, a
// SATA data disk, a USB stick, an SD card, an empty DVD drive, a loop device and a zram swap.
const LAPTOP = JSON.stringify({ blockdevices: [
  { name: 'loop0', path: '/dev/loop0', size: 104857600, label: null, partlabel: null, fstype: 'squashfs', mountpoints: ['/snap/core/1'], rm: false, hotplug: false, ro: true, type: 'loop', tran: null, parttype: null, model: null },
  { name: 'sda', path: '/dev/sda', size: 1000204886016, label: null, partlabel: null, fstype: null, mountpoints: [null], rm: false, hotplug: false, ro: false, type: 'disk', tran: 'sata', parttype: null, model: 'WDC WD10EZEX-08WN4A0',
    children: [
      { name: 'sda1', path: '/dev/sda1', size: 1000202788864, label: 'Data', partlabel: 'Basic data partition', fstype: 'ntfs', mountpoints: [null], rm: false, hotplug: false, ro: false, type: 'part', tran: null, parttype: 'ebd0a0a2-b9e5-4433-87c0-68b6b72699c7', model: null },
    ] },
  { name: 'sdb', path: '/dev/sdb', size: 31042043904, label: null, partlabel: null, fstype: null, mountpoints: [null], rm: true, hotplug: true, ro: false, type: 'disk', tran: 'usb', parttype: null, model: 'DataTraveler 3.0',
    children: [
      { name: 'sdb1', path: '/dev/sdb1', size: 31040995328, label: 'KINGSTON', partlabel: null, fstype: 'vfat', mountpoints: ['/media/alex/KINGSTON'], rm: true, hotplug: true, ro: false, type: 'part', tran: null, parttype: '0xc', model: null },
    ] },
  { name: 'sr0', path: '/dev/sr0', size: 1073741312, label: null, partlabel: null, fstype: null, mountpoints: [null], rm: true, hotplug: false, ro: false, type: 'rom', tran: 'sata', parttype: null, model: 'DVD+-RW GU90N' },
  { name: 'mmcblk0', path: '/dev/mmcblk0', size: 63864569856, label: null, partlabel: null, fstype: null, mountpoints: [null], rm: false, hotplug: false, ro: false, type: 'disk', tran: null, parttype: null, model: null,
    children: [
      { name: 'mmcblk0p1', path: '/dev/mmcblk0p1', size: 63863521280, label: '', partlabel: null, fstype: 'exfat', mountpoints: [null], rm: false, hotplug: false, ro: false, type: 'part', tran: null, parttype: '0x7', model: null },
    ] },
  { name: 'zram0', path: '/dev/zram0', size: 4294967296, label: null, partlabel: null, fstype: 'swap', mountpoints: ['[SWAP]'], rm: false, hotplug: false, ro: false, type: 'disk', tran: null, parttype: null, model: null },
  { name: 'nvme0n1', path: '/dev/nvme0n1', size: 512110190592, label: null, partlabel: null, fstype: null, mountpoints: [null], rm: false, hotplug: false, ro: false, type: 'disk', tran: 'nvme', parttype: null, model: 'Samsung SSD 980 PRO 500GB',
    children: [
      { name: 'nvme0n1p1', path: '/dev/nvme0n1p1', size: 104857600, label: 'SYSTEM', partlabel: 'EFI system partition', fstype: 'vfat', mountpoints: ['/boot/efi'], rm: false, hotplug: false, ro: false, type: 'part', tran: 'nvme', parttype: 'c12a7328-f81f-11d2-ba4b-00a0c93ec93b', model: null },
      { name: 'nvme0n1p2', path: '/dev/nvme0n1p2', size: 16777216, label: null, partlabel: 'Microsoft reserved partition', fstype: null, mountpoints: [null], rm: false, hotplug: false, ro: false, type: 'part', tran: 'nvme', parttype: 'e3c9e316-0b5c-4db8-817d-f92df00215ae', model: null },
      { name: 'nvme0n1p3', path: '/dev/nvme0n1p3', size: 214748364800, label: 'Windows', partlabel: 'Basic data partition', fstype: 'ntfs', mountpoints: [null], rm: false, hotplug: false, ro: false, type: 'part', tran: 'nvme', parttype: 'ebd0a0a2-b9e5-4433-87c0-68b6b72699c7', model: null },
      { name: 'nvme0n1p4', path: '/dev/nvme0n1p4', size: 681574400, label: 'Recovery', partlabel: null, fstype: 'ntfs', mountpoints: [null], rm: false, hotplug: false, ro: false, type: 'part', tran: 'nvme', parttype: 'de94bba4-06d1-4d40-a16a-bfd50179d6ac', model: null },
      { name: 'nvme0n1p5', path: '/dev/nvme0n1p5', size: 1073741824, label: null, partlabel: null, fstype: 'ext4', mountpoints: ['/boot'], rm: false, hotplug: false, ro: false, type: 'part', tran: 'nvme', parttype: '0fc63daf-8483-4772-8e79-3d69d8477de4', model: null },
      { name: 'nvme0n1p6', path: '/dev/nvme0n1p6', size: 286654955520, label: null, partlabel: null, fstype: 'crypto_LUKS', mountpoints: [null], rm: false, hotplug: false, ro: false, type: 'part', tran: 'nvme', parttype: '0fc63daf-8483-4772-8e79-3d69d8477de4', model: null,
        children: [
          { name: 'luks-3f1c', path: '/dev/mapper/luks-3f1c', size: 286638178304, label: null, partlabel: null, fstype: 'ext4', mountpoints: ['/'], rm: false, hotplug: false, ro: false, type: 'crypt', tran: null, parttype: null, model: null },
        ] },
      { name: 'nvme0n1p7', path: '/dev/nvme0n1p7', size: 8589934592, label: null, partlabel: null, fstype: 'swap', mountpoints: ['[SWAP]'], rm: false, hotplug: false, ro: false, type: 'part', tran: 'nvme', parttype: '0657fd6d-a4ab-43c4-84e5-0933c84b4f4f', model: null },
    ] },
] })

describe('parseVolumes', () => {
  const vols = parseVolumes(LAPTOP)
  it('lists the system disk, data partitions and removable media, and hides boot, EFI, MSR, recovery, swap, loop and zram', () => {
    expect(vols.map((v) => v.device)).toEqual(['/dev/nvme0n1p6', '/dev/nvme0n1p3', '/dev/sda1', '/dev/mmcblk0p1', '/dev/sdb1'])
  })
  it('the system volume is the LUKS container of / and is marked encrypted', () => {
    expect(vols[0]).toMatchObject({ kind: 'system', mountpoint: '/', encrypted: true, locked: false, fstype: 'ext4', disk: '/dev/nvme0n1', model: 'Samsung SSD 980 PRO 500GB' })
  })
  it('names, sizes and kinds', () => {
    const by = (d: string) => vols.find((v) => v.device === d)!
    expect(by('/dev/sda1')).toMatchObject({ label: 'Data', kind: 'internal', size: 1000202788864, mountpoint: null, fstype: 'ntfs' })
    expect(by('/dev/sdb1')).toMatchObject({ label: 'KINGSTON', kind: 'removable', mountpoint: '/media/alex/KINGSTON' })
    expect(by('/dev/mmcblk0p1')).toMatchObject({ label: '', kind: 'removable', fstype: 'exfat' })   // SD card reader: removable by name
  })
  it('an empty disc drive lists nothing; a disc in it is a read-only optical volume', () => {
    expect(vols.some((v) => v.disk === '/dev/sr0')).toBe(false)
    const disc = parseVolumes(JSON.stringify({ blockdevices: [{ name: 'sr0', path: '/dev/sr0', size: 4700000000, label: 'PHOTOS_2019', fstype: 'iso9660', mountpoints: [null], rm: true, type: 'rom', tran: 'sata', model: 'DVD' }] }))
    expect(disc).toEqual([expect.objectContaining({ device: '/dev/sr0', kind: 'optical', readOnly: true, label: 'PHOTOS_2019' })])
  })
  it('a locked LUKS USB drive is listed as locked; a stick without partition table is its own volume', () => {
    const v = parseVolumes(JSON.stringify({ blockdevices: [
      { name: 'sdc', path: '/dev/sdc', size: '16000000000', rm: '1', hotplug: '1', type: 'disk', tran: 'usb', model: 'Ultra', children: [{ name: 'sdc1', path: '/dev/sdc1', size: '16000000000', fstype: 'crypto_LUKS', type: 'part', mountpoints: [null] }] },
      { name: 'sdd', path: '/dev/sdd', size: 8000000000, rm: true, type: 'disk', tran: 'usb', fstype: 'vfat', label: 'RAW', mountpoints: [null] },
    ] }))
    expect(v).toEqual([
      expect.objectContaining({ device: '/dev/sdc1', locked: true, encrypted: true, size: 16e9, model: 'Ultra' }),
      expect.objectContaining({ device: '/dev/sdd', label: 'RAW', kind: 'removable' }),
    ])
  })
  it('LVM on LUKS: logical volumes are listed (root as system, swap hidden), a separate /home is system too', () => {
    const v = parseVolumes(JSON.stringify({ blockdevices: [{ name: 'sda', path: '/dev/sda', size: 256e9, type: 'disk', tran: 'sata', rm: false, children: [
      { name: 'sda1', path: '/dev/sda1', size: 256e9, fstype: 'crypto_LUKS', type: 'part', children: [{ name: 'cr', path: '/dev/mapper/cr', fstype: 'LVM2_member', type: 'crypt', children: [
        { name: 'vg-root', path: '/dev/mapper/vg-root', size: 50e9, fstype: 'ext4', type: 'lvm', mountpoints: ['/'] },
        { name: 'vg-home', path: '/dev/mapper/vg-home', size: 190e9, fstype: 'ext4', type: 'lvm', mountpoints: ['/home'] },
        { name: 'vg-swap', path: '/dev/mapper/vg-swap', size: 8e9, fstype: 'swap', type: 'lvm', mountpoints: ['[SWAP]'] },
      ] }] },
    ] }] }))
    expect(v.map((x) => [x.device, x.kind, x.mountpoint])).toEqual([['/dev/sda1', 'system', '/'], ['/dev/sda1', 'system', '/home']])
  })
  it('hides the live medium and survives bad input', () => {
    expect(parseVolumes(JSON.stringify({ blockdevices: [{ path: '/dev/sdb', type: 'disk', rm: true, tran: 'usb', children: [{ path: '/dev/sdb1', fstype: 'iso9660', type: 'part', mountpoints: ['/run/live/medium'] }] }] }))).toEqual([])
    expect(parseVolumes('not json')).toEqual([])
    expect(parseVolumes(JSON.stringify({ blockdevices: [{ path: '/dev/sdx;rm -rf', type: 'disk', fstype: 'vfat' }] }))).toEqual([])
  })
})

describe('space, errors, mounts', () => {
  it('withSpace fills total/free from statvfs for mounted volumes only (bavail, not bfree)', () => {
    const v = withSpace(parseVolumes(LAPTOP), (p) => { if (p === '/') return { blocks: 1000, bavail: 250, bsize: 4096 }; throw new Error('EACCES') })
    expect(v[0]).toMatchObject({ total: 4096000, free: 1024000 })
    expect(v.find((x) => x.device === '/dev/sdb1')).toMatchObject({ total: null, free: null })   // unreadable: unknown, not 0
    expect(v.find((x) => x.device === '/dev/sda1')).toMatchObject({ total: null })
  })
  it('maps udisksctl errors to clear messages', () => {
    expect(volumeError('Error mounting /dev/sda1: GDBus.Error:org.freedesktop.UDisks2.Error.NotAuthorizedDismissed: The authentication dialog was dismissed')).toBe('auth_cancelled')
    expect(volumeError('GDBus.Error:org.freedesktop.UDisks2.Error.NotAuthorized: Not authorized to perform operation')).toBe('not_authorized')
    expect(volumeError('Error unmounting /dev/sdb1: GDBus.Error:org.freedesktop.UDisks2.Error.DeviceBusy: Error unmounting /dev/sdb1: target is busy')).toBe('busy')
    expect(volumeError("Error mounting /dev/sdc1: GDBus.Error:org.freedesktop.UDisks2.Error.Failed: Error mounting system-managed device /dev/sdc1: wrong fs type, bad option, bad superblock")).toBe('unreadable')
    expect(volumeError('Error looking up object for device /dev/sdz1')).toBe('gone')
    expect(volumeError('???')).toBe('failed')
  })
  it('reads the mount point from udisksctl mount output (with and without full stop, spaces kept)', () => {
    expect(mountedPath('Mounted /dev/sdb1 at /media/alex/KINGSTON.\n')).toBe('/media/alex/KINGSTON')
    expect(mountedPath('Mounted /dev/sda1 at /media/alex/My Data')).toBe('/media/alex/My Data')
  })
  it('extra mounts under /mnt and /media other than the user\'s udisks mounts become roots', () => {
    const mounts = '/dev/mapper/luks-3f1c / ext4 rw 0 0\n/dev/sda1 /mnt/Data\\040Disk ntfs3 rw 0 0\n/dev/sdb1 /media/alex/KINGSTON vfat rw 0 0\n'
      + '/dev/sdc1 /media/bob/USB vfat rw 0 0\ntmpfs /mnt/tmp tmpfs rw 0 0\n/dev/nvme0n1p1 /boot/efi vfat rw 0 0\n'
    expect(blockMounts(mounts)[1]).toEqual({ source: '/dev/sda1', target: '/mnt/Data Disk' })
    expect(extraMounts(mounts, 'alex')).toEqual(['/mnt/Data Disk', '/media/bob/USB'])
    const rs = roots({ home: '/nonexistent-home', user: 'alex' }, () => mounts)
    expect(rs.find((r) => r.id === 'vol:/mnt/Data Disk')).toEqual({ id: 'vol:/mnt/Data Disk', label: 'Data Disk', path: '/mnt/Data Disk' })
    expect(rootFor({ mountpoint: '/mnt/Data Disk', kind: 'internal' }, rs)).toBe('vol:/mnt/Data Disk')
    expect(rootFor({ mountpoint: '/', kind: 'system' }, rs)).toBe('home')
    expect(rootFor({ mountpoint: null, kind: 'internal' }, rs)).toBeNull()
  })
})

function fake(answers: Record<string, { code?: number; stdout?: string; stderr?: string; missing?: boolean }>) {
  const calls: string[] = []
  const exec: VolExec = async (cmd, args) => {
    const key = [cmd, ...args].join(' ')
    calls.push(key)
    const hit = Object.keys(answers).find((k) => key.startsWith(k))
    const a = hit ? answers[hit] : { code: 0 }
    return { code: a.code ?? 0, stdout: a.stdout ?? '', stderr: a.stderr ?? '', missing: a.missing }
  }
  return { exec, calls }
}
const noSpace = () => { throw new Error('no') }

describe('volumesBridge', () => {
  const lsblk = { [`lsblk ${LSBLK_ARGS.join(' ')}`]: { stdout: LAPTOP } }
  it('mounts an internal partition through udisksctl, allowing the polkit prompt', async () => {
    const f = fake({ ...lsblk, 'udisksctl mount': { stdout: 'Mounted /dev/sda1 at /media/alex/Data\n' } })
    expect(await volumesBridge(f.exec, noSpace).mount('/dev/sda1')).toEqual({ ok: true, value: '/media/alex/Data' })
    expect(f.calls).toContain('udisksctl mount -b /dev/sda1')
    expect(f.calls.some((c) => c.includes('--no-user-interaction'))).toBe(false)
  })
  it('refuses devices it does not list (EFI, unknown, injected)', async () => {
    const f = fake(lsblk)
    const b = volumesBridge(f.exec, noSpace)
    for (const d of ['/dev/nvme0n1p1', '/dev/sdz9', '--help', '/dev/sda1 /dev/sdb']) expect(await b.mount(d)).toEqual({ ok: false, error: 'gone' })
    expect(f.calls.some((c) => c.startsWith('udisksctl'))).toBe(false)
  })
  it('never unmounts or ejects the system disk; internal disks cannot be ejected', async () => {
    const f = fake(lsblk)
    const b = volumesBridge(f.exec, noSpace)
    expect(await b.unmount('/dev/nvme0n1p6')).toEqual({ ok: false, error: 'system' })
    expect(await b.eject('/dev/sda1')).toEqual({ ok: false, error: 'not_removable' })
  })
  it('ejects a USB stick: unmount then power off; a busy drive reports busy and stays powered', async () => {
    const f = fake(lsblk)
    expect(await volumesBridge(f.exec, noSpace).eject('/dev/sdb1')).toEqual({ ok: true, value: true })
    expect(f.calls.filter((c) => c.startsWith('udisksctl'))).toEqual(['udisksctl unmount -b /dev/sdb1', 'udisksctl power-off -b /dev/sdb'])
    const g = fake({ ...lsblk, 'udisksctl unmount': { code: 1, stderr: 'Error unmounting /dev/sdb1: GDBus.Error:org.freedesktop.UDisks2.Error.DeviceBusy: target is busy' } })
    expect(await volumesBridge(g.exec, noSpace).eject('/dev/sdb1')).toEqual({ ok: false, error: 'busy' })
    expect(g.calls.some((c) => c.includes('power-off'))).toBe(false)
  })
  it('a missing lsblk or udisksctl is "unavailable"', async () => {
    expect(await volumesBridge(fake({ lsblk: { code: 1, missing: true } }).exec).list()).toEqual({ ok: false, error: 'unavailable' })
    expect(await volumesBridge(fake({ ...lsblk, udisksctl: { code: 1, missing: true } }).exec, noSpace).mount('/dev/sda1')).toEqual({ ok: false, error: 'unavailable' })
  })
})

describe('watchVolumes', () => {
  afterEach(() => { vi.useRealTimers() })
  it('reports udisks changes once they settle, ignores the banner, and restarts the monitor', () => {
    vi.useFakeTimers()
    const kids: (EventEmitter & { stdout: EventEmitter; kill: () => void })[] = []
    const start = () => { const c = Object.assign(new EventEmitter(), { stdout: new EventEmitter(), kill: vi.fn() }); kids.push(c); return c as unknown as ChildProcess }
    const changed = vi.fn()
    const stop = watchVolumes(changed, start, 100)
    kids[0].stdout.emit('data', Buffer.from('Monitoring the udisks daemon. Press Ctrl+C to exit.\n'))
    vi.advanceTimersByTime(500)
    expect(changed).not.toHaveBeenCalled()
    kids[0].stdout.emit('data', Buffer.from('10:12:01.512: Added /org/freedesktop/UDisks2/block_devices/sdc\n'))
    kids[0].stdout.emit('data', Buffer.from('10:12:01.530: Added /org/freedesktop/UDisks2/block_devices/sdc1\n'))
    vi.advanceTimersByTime(150)
    expect(changed).toHaveBeenCalledTimes(1)
    kids[0].emit('close')
    vi.advanceTimersByTime(2500)
    expect(kids).toHaveLength(2)
    stop()
    expect(kids[1].kill).toHaveBeenCalled()
  })
})

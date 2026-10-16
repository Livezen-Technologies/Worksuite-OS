import { describe, expect, it } from 'vitest'
import { installedDisk, luksDevices, osVersion, parseLsblk, RECOVERY_IMAGES, recoveryHost, REINSTALL, rootDisk, type Host } from './recovery'

const tree = (unlocked: boolean) => JSON.stringify({ blockdevices: [
  { path: '/dev/vda', name: 'vda', type: 'disk', fstype: null, size: 42949672960, mountpoint: null, children: [
    { path: '/dev/vda1', name: 'vda1', type: 'part', fstype: 'vfat', size: 536870912, mountpoint: '/boot/efi' },
    { path: '/dev/vda2', name: 'vda2', type: 'part', fstype: 'crypto_LUKS', fsver: '2', label: 'WorkSuite', size: 42412802048, mountpoint: null,
      children: unlocked ? [{ path: '/dev/mapper/root', name: 'root', type: 'crypt', fstype: 'ext4', mountpoint: '/' }] : [] }] }] })

type Out = Record<string, { code?: number; stdout?: string; stderr?: string }>
function fakeHost(out: Out = {}, over: Partial<Host> = {}) {
  const calls: string[][] = []
  const stdin: { args: string[]; secret: string }[] = []
  const host: Host = {
    exec: async (cmd, args) => { calls.push([cmd, ...args]); return { code: 0, stdout: '', stderr: '', ...(out[cmd] ?? {}) } },
    exists: () => true,
    read: () => 'NAME="WorkSuite OS"\nVERSION_ID="1.1"\n',
    withStdin: async (_cmd, args, secret) => { stdin.push({ args, secret }); return { code: 0, stderr: '' } },
    ...over,
  }
  return { host, calls, stdin }
}
const pkg = {
  checkUpdates: async () => ({ ok: true as const, value: { state: 'idle' } }),
  updateStatus: async () => ({ ok: true as const, value: { state: 'up_to_date', installed: '1.1' } as unknown }),
}

describe('lsblk parsing', () => {
  it('finds LUKS volumes, their state and the root disk', () => {
    const nodes = parseLsblk(tree(true))
    expect(luksDevices(nodes)).toEqual([{ device: '/dev/vda2', name: 'vda2', label: 'WorkSuite', version: '2', size_bytes: 42412802048, unlocked: true }])
    expect(rootDisk(nodes)).toBe('vda')
    expect(parseLsblk('not json')).toEqual([])
    expect(osVersion('VERSION_ID=1.0\n')).toBe('1.0')
    expect(osVersion(null)).toBeNull()
  })
})

describe('recovery host', () => {
  it('reports facts and which tools exist', async () => {
    const f = fakeHost({ lsblk: { stdout: tree(true) }, systemctl: { stdout: '3\n' } })
    const info = await recoveryHost(pkg, f.host).info()
    expect(info).toMatchObject({ os_version: '1.1', disk: 'vda', firmware: 'EFI', failures: 3 })
    expect(info.features).toMatchObject({ unlock: true, repair: true, snapshots: false, reinstall: true })
  })

  it('knows when Recovery was chosen in the boot menu', async () => {
    const read = (p: string) => (p === '/proc/cmdline' ? 'BOOT_IMAGE=/vmlinuz root=UUID=x ro systemd.unit=worksuite-recovery.target worksuite.recovery=1 quiet splash' : 'VERSION_ID="1.1"\n')
    expect((await recoveryHost(pkg, fakeHost({}, { read }).host).info()).manual).toBe(true)
    expect((await recoveryHost(pkg, fakeHost().host).info()).manual).toBe(false)
  })

  it('runs read-only checks', async () => {
    const ro = fakeHost({ findmnt: { stdout: 'ext4 ro,relatime\n' } })
    expect((await recoveryHost(pkg, ro.host).check('disk')).status).toBe('problem')
    const rw = fakeHost({ findmnt: { stdout: 'ext4 rw,relatime\n' } })
    expect((await recoveryHost(pkg, rw.host).check('disk')).status).toBe('ok')
    const broken = { ...pkg, checkUpdates: async () => ({ ok: true as const, value: { state: 'interrupted' } }) }
    expect(await recoveryHost(broken, rw.host).check('packages')).toEqual({ status: 'problem', note: 'Interrupted package changes', fixable: true })
    const down = { ...pkg, checkUpdates: async () => ({ ok: false as const, error: 'service_unavailable' }) }
    expect((await recoveryHost(down, rw.host).check('packages')).status).toBe('unavailable')
    expect((await recoveryHost(pkg, rw.host).check('drivers')).status).toBe('unavailable')
  })

  it('unlocks only listed locked LUKS devices, passing the key on stdin only', async () => {
    const f = fakeHost({ lsblk: { stdout: tree(false) } })
    const rec = recoveryHost(pkg, f.host)
    expect(await rec.unlock('/dev/vda2', 'KEY-SECRET')).toEqual({ ok: true, value: true })
    expect(f.stdin).toEqual([{ args: ['unlock', '--block-device', '/dev/vda2', '--key-file', '/dev/stdin'], secret: 'KEY-SECRET' }])
    expect(f.calls.flat().join(' ')).not.toContain('KEY-SECRET')
    expect(await rec.unlock('/dev/sda1', 'x')).toEqual({ ok: false, error: 'not_found' })
    const wrong = fakeHost({ lsblk: { stdout: tree(false) } }, { withStdin: async () => ({ code: 1, stderr: 'Error unlocking /dev/vda2: Failed to activate device: Operation not permitted' }) })
    expect(await recoveryHost(pkg, wrong.host).unlock('/dev/vda2', 'k')).toEqual({ ok: false, error: 'wrong_key' })
    const open = fakeHost({ lsblk: { stdout: tree(true) } })
    expect(await recoveryHost(pkg, open.host).unlock('/dev/vda2', 'k')).toEqual({ ok: false, error: 'already_unlocked' })
    const noUdisks = fakeHost({}, { exists: () => false })
    expect(await recoveryHost(pkg, noUdisks.host).unlock('/dev/vda2', 'k')).toEqual({ ok: false, error: 'unavailable' })
  })
})

describe('reinstall (SRS §9.2-R6)', () => {
  const lsblk = { lsblk: { stdout: tree(true) } }
  it('keep runs worksuite-reinstall through pkexec without any erase confirmation', async () => {
    const h = fakeHost(lsblk)
    expect(await recoveryHost(pkg, h.host).reinstall('keep', '')).toEqual({ ok: true, value: true })
    expect(h.calls.at(-1)).toEqual(['pkexec', REINSTALL, '--mode', 'keep', '--disk', 'vda'])
  })
  it('erase needs the disk name typed, and passes it on for the script to check again', async () => {
    const h = fakeHost(lsblk)
    expect(await recoveryHost(pkg, h.host).reinstall('erase', 'vdb')).toEqual({ ok: false, error: 'confirm_mismatch' })
    expect(h.calls.some((c) => c[0] === 'pkexec')).toBe(false)
    expect(await recoveryHost(pkg, h.host).reinstall('erase', ' vda ')).toEqual({ ok: true, value: true })
    expect(h.calls.at(-1)).toEqual(['pkexec', REINSTALL, '--mode', 'erase', '--disk', 'vda', '--confirm', 'vda'])
  })
  it('maps script exit codes and refuses unknown modes', async () => {
    const h = fakeHost({ ...lsblk, pkexec: { code: 4 } })
    expect(await recoveryHost(pkg, h.host).reinstall('keep', '')).toEqual({ ok: false, error: 'no_image' })
    expect(await recoveryHost(pkg, fakeHost({ ...lsblk, pkexec: { code: 126 } }).host).reinstall('keep', '')).toEqual({ ok: false, error: 'not_authorized' })
    expect(await recoveryHost(pkg, h.host).reinstall('wipe', '')).toEqual({ ok: false, error: 'invalid_argument' })
  })
  it('is offered only with the script and a recovery image present', async () => {
    const none = fakeHost(lsblk, { exists: (p) => p !== REINSTALL })
    expect((await recoveryHost(pkg, none.host).info()).features.reinstall).toBe(false)
    const img = fakeHost(lsblk, { exists: (p) => p === REINSTALL || p === RECOVERY_IMAGES[0] })
    expect((await recoveryHost(pkg, img.host).info()).features.reinstall).toBe(true)
  })
  it('finds the installed disk when booted from the recovery image', () => {
    const nodes = parseLsblk(JSON.stringify({ blockdevices: [
      { name: 'sda', type: 'disk', children: [{ name: 'sda1', type: 'part', mountpoint: '/run/live/medium' }] },
      { name: 'nvme0n1', type: 'disk', children: [{ name: 'nvme0n1p1', type: 'part', mountpoint: null }] }] }))
    expect(installedDisk(nodes)).toBe('nvme0n1')
  })
})

// Files › This Computer (#63): every disk partition and mounted volume the user can use — internal partitions,
// USB drives, SD cards and discs — with its name, total and free space, and mount / unmount / eject through udisks2.
// Block devices come from `lsblk -J -b` (udisks2 and lsblk read the same udev database), sizes of mounted volumes from
// statvfs, and actions go to `udisksctl`, which asks polkit: removable media mount without a prompt, internal disks
// raise the administrator prompt (the WorkSuite polkit agent). Hotplug: `udisksctl monitor` prints a line on every
// udisks2 object change, which is turned into a debounced 'ws:filesVolumesChanged' event.
// Boot, EFI, swap, recovery and other system-only partitions are hidden, as are loop devices and the live medium.
import { execFile, spawn, type ChildProcess } from 'node:child_process'
import { readFileSync, statfsSync } from 'node:fs'
import path from 'node:path'

type Reply<T> = { ok: true; value: T } | { ok: false; error: string }
export type VolExec = (cmd: string, args: string[]) => Promise<{ code: number; stdout: string; stderr: string; missing?: boolean }>

export type VolumeKind = 'system' | 'internal' | 'removable' | 'optical'
export interface DiskVolume {
  /** The block device udisks acts on (for an encrypted volume: the LUKS container). */
  device: string
  /** The whole disk it lies on. */
  disk: string
  /** Filesystem label, else partition label; '' when it has neither (the renderer names it by size). */
  label: string
  /** Drive model ("SanDisk Ultra"), for unnamed volumes and tooltips. */
  model: string
  fstype: string
  kind: VolumeKind
  /** Partition size in bytes. */
  size: number
  mountpoint: string | null
  /** statvfs of the mount point (bytes); null when not mounted or unreadable. */
  total: number | null
  free: number | null
  encrypted: boolean
  /** Encrypted and not unlocked yet. */
  locked: boolean
  readOnly: boolean
}

interface Node {
  name?: string; path?: string; size?: number | string | null; label?: string | null; partlabel?: string | null; fstype?: string | null
  mountpoint?: string | null; mountpoints?: (string | null)[] | null; rm?: boolean | string | number; hotplug?: boolean | string | number
  ro?: boolean | string | number; type?: string; tran?: string | null; parttype?: string | null; model?: string | null; children?: Node[]
}

export const LSBLK_ARGS = ['-J', '-b', '-o', 'NAME,PATH,SIZE,LABEL,PARTLABEL,FSTYPE,MOUNTPOINTS,RM,HOTPLUG,RO,TYPE,TRAN,PARTTYPE,MODEL']

const truthy = (v: unknown) => v === true || v === '1' || v === 1
const DEV = /^\/dev\/[A-Za-z0-9._:/-]{1,96}$/

/** GPT type GUIDs and MBR type codes of partitions nobody browses: EFI system, BIOS boot, Microsoft reserved, Windows
 *  recovery, Linux swap, XBOOTLDR (/boot), MBR extended containers, hidden recovery (0x27) and EFI (0xef). */
const SYSTEM_PARTTYPES = new Set([
  'c12a7328-f81f-11d2-ba4b-00a0c93ec93b', '21686148-6449-6e6f-744e-656564454649', 'e3c9e316-0b5c-4db8-817d-f92df00215ae',
  'de94bba4-06d1-4d40-a16a-bfd50179d6ac', '0657fd6d-a4ab-43c4-84e5-0933c84b4f4f', 'bc13c2ff-59e6-4262-a352-b275fd6f7172',
  '0x5', '0xf', '0x85', '0x27', '0xef', '0x82',
])
/** Filesystems that are not user data. */
const HIDDEN_FS = new Set(['swap', 'squashfs', 'erofs', 'LVM2_member', 'linux_raid_member', 'BitLocker', 'zfs_member', 'bcache'])
/** Mount points of system internals; "/" and "/home" are kept and shown as the system volume. */
const HIDDEN_MOUNT = /^(\[SWAP\]|\/(boot|efi|usr|var|tmp|opt|snap|recovery|run\/live|run\/initramfs|lib\/live)(\/|$))/
const SYSTEM_MOUNT = /^\/(home)?$/

const mountOfNode = (n: Node): string | null => n.mountpoints?.find((m): m is string => !!m) ?? n.mountpoint ?? null
const bytes = (v: unknown): number => { const n = typeof v === 'number' ? v : Number(v); return Number.isFinite(n) && n > 0 ? n : 0 }

/** `lsblk -J -b -o …` (LSBLK_ARGS) → the volumes This Computer lists, without space figures (see withSpace). */
export function parseVolumes(json: string): DiskVolume[] {
  let doc: { blockdevices?: Node[] }
  try { doc = JSON.parse(json) } catch { return [] }
  const out: DiskVolume[] = []
  for (const disk of doc.blockdevices ?? []) {
    if (!disk.path || !DEV.test(disk.path) || (disk.type !== 'disk' && disk.type !== 'rom')) continue   // loop, zram, …
    const removable = truthy(disk.rm) || truthy(disk.hotplug) || disk.tran === 'usb' || disk.tran === 'mmc' || /^mmcblk/.test(disk.name ?? '')
    const base: VolumeKind = disk.type === 'rom' ? 'optical' : removable ? 'removable' : 'internal'
    const model = (disk.model ?? '').trim()
    // A whole-disk filesystem (a stick formatted without a partition table, a disc) is its own volume.
    const parts = disk.children?.length ? disk.children : disk.fstype ? [disk] : []
    const visit = (p: Node, partType: string | null, container: Node | null) => {
      if (!p.path || !DEV.test(p.path)) return
      const fstype = p.fstype ?? ''
      const mp = mountOfNode(p)
      if (SYSTEM_PARTTYPES.has((partType ?? '').toLowerCase())) return
      if (mp && HIDDEN_MOUNT.test(mp)) return
      if (fstype === 'crypto_LUKS') {
        const inner = (p.children ?? []).filter((c) => c.type === 'crypt')
        if (!inner.length) { push(p, p, null, true); return }
        for (const c of inner) visit(c, partType, p)
        return
      }
      if (fstype === 'LVM2_member') { for (const c of p.children ?? []) if (c.type === 'lvm') visit(c, null, container); return }
      if (!fstype || HIDDEN_FS.has(fstype)) return                                     // unformatted, extended, swap, …
      push(container ?? p, p, mp, false)
    }
    const push = (act: Node, fs: Node, mp: string | null, locked: boolean) => {
      const kind: VolumeKind = mp && SYSTEM_MOUNT.test(mp) ? 'system' : base
      out.push({
        device: act.path!, disk: disk.path!, label: (fs.label || fs.partlabel || act.partlabel || '').trim(), model, fstype: locked ? 'crypto_LUKS' : fs.fstype ?? '',
        kind, size: bytes(fs.size) || bytes(act.size), mountpoint: mp, total: null, free: null,
        encrypted: act !== fs || locked, locked, readOnly: truthy(fs.ro) || truthy(disk.ro) || disk.type === 'rom',
      })
    }
    for (const p of parts) visit(p, p === disk ? null : p.parttype ?? null, null)
  }
  // System volume first, then internal, removable, discs; by name within a kind.
  const order: Record<VolumeKind, number> = { system: 0, internal: 1, removable: 2, optical: 3 }
  return out.sort((a, b) => order[a.kind] - order[b.kind] || (a.mountpoint === '/' ? -1 : b.mountpoint === '/' ? 1 : 0) || a.device.localeCompare(b.device, undefined, { numeric: true }))
}

/** Total and free bytes from statvfs for each mounted volume (bavail: what an unprivileged user can still write). */
export function withSpace(vols: DiskVolume[], statfs: (p: string) => { blocks: number; bavail: number; bsize: number } = statfsSync): DiskVolume[] {
  return vols.map((v) => {
    if (!v.mountpoint) return v
    try { const s = statfs(v.mountpoint); return { ...v, total: s.blocks * s.bsize, free: s.bavail * s.bsize } } catch { return v }
  })
}

/** udisksctl output → a message key the Files window shows (files.vol.err.*). */
export function volumeError(text: string): string {
  if (/NotAuthorizedDismissed|dismissed/i.test(text)) return 'auth_cancelled'
  if (/NotAuthorized|not authorized/i.test(text)) return 'not_authorized'
  if (/target is busy|DeviceBusy|is busy/i.test(text)) return 'busy'
  if (/NotMounted|not mounted/i.test(text)) return 'not_mounted'
  if (/AlreadyMounted|already mounted/i.test(text)) return 'already_mounted'
  if (/No such|doesn't exist|does not exist|Error looking up object/i.test(text)) return 'gone'
  if (/unknown filesystem|wrong fs type|NotSupported|bad superblock|Error mounting/i.test(text)) return 'unreadable'
  return 'failed'
}

/** "Mounted /dev/sdb1 at /media/u/USB" (udisks ≥2.10 drops the full stop) → the mount point. */
export function mountedPath(text: string): string | null {
  return /\bat (\/.+?)\.?\s*$/m.exec(text.trim())?.[1] ?? null
}

/** Mount points of mounted block devices from /proc/self/mounts (octal escapes such as \040 decoded). */
export function blockMounts(text: string): { source: string; target: string }[] {
  const dec = (s: string) => s.replace(/\\([0-7]{3})/g, (_, o) => String.fromCharCode(parseInt(o, 8)))
  return text.split('\n').map((l) => l.split(' ')).filter((f) => f.length > 2 && f[0].startsWith('/dev/')).map((f) => ({ source: dec(f[0]), target: dec(f[1]) }))
}

/** Volumes under /mnt, /media and /run/media other than the user's own udisks mounts (/media/<user>/…): data
 *  partitions mounted from fstab, for example. They are Files roots "vol:<mount point>". */
export function extraMounts(mountsText: string, user: string): string[] {
  const own = [`/media/${user}/`, `/run/media/${user}/`]
  return [...new Set(blockMounts(mountsText).map((m) => m.target))]
    .filter((t) => /^\/(mnt|media|run\/media)\/./.test(t) && !own.some((o) => t.startsWith(o)) && !HIDDEN_MOUNT.test(t))
}
export function readMounts(): string { try { return readFileSync('/proc/self/mounts', 'utf8') } catch { return '' } }

/** Long-running udisks calls: a polkit prompt can stay open for minutes. */
const realExec: VolExec = (cmd, args) => new Promise((resolve) => {
  execFile(cmd, args, { timeout: 180_000, env: { ...process.env, LC_ALL: 'C' }, maxBuffer: 4 << 20 }, (err, stdout, stderr) => {
    resolve({ code: err ? 1 : 0, stdout: String(stdout), stderr: String(stderr), missing: (err as NodeJS.ErrnoException | null)?.code === 'ENOENT' })
  })
})

export function volumesBridge(exec: VolExec = realExec, statfs?: Parameters<typeof withSpace>[1]) {
  const fail = (error: string): Reply<never> => ({ ok: false, error })
  const run = async (args: string[]): Promise<Reply<string>> => {
    const r = await exec('udisksctl', args)
    if (r.missing) return fail('unavailable')
    return r.code === 0 ? { ok: true, value: r.stdout } : fail(volumeError(r.stderr + r.stdout))
  }
  const b = {
    async list(): Promise<Reply<DiskVolume[]>> {
      const r = await exec('lsblk', LSBLK_ARGS)
      if (r.code !== 0) return fail(r.missing ? 'unavailable' : 'failed')
      return { ok: true, value: withSpace(parseVolumes(r.stdout), statfs) }
    },
    /** Only devices This Computer lists can be acted on. */
    async find(device: string): Promise<DiskVolume | null> {
      if (typeof device !== 'string' || !DEV.test(device)) return null
      const l = await b.list()
      return l.ok ? l.value.find((v) => v.device === device) ?? null : null
    },
    /** Mount (polkit decides; internal disks ask for an administrator). Returns the mount point. */
    async mount(device: string): Promise<Reply<string>> {
      const v = await b.find(device)
      if (!v) return fail('gone')
      if (v.mountpoint) return { ok: true, value: v.mountpoint }
      if (v.locked) return fail('locked')
      // The cleartext device of an unlocked LUKS volume is what carries the filesystem.
      const target = v.encrypted ? await cleartext(v) : v.device
      if (!target) return fail('locked')
      const r = await run(['mount', '-b', target])
      if (!r.ok) return r
      return { ok: true, value: mountedPath(r.value) ?? (await b.find(device))?.mountpoint ?? '' }
    },
    async unmount(device: string): Promise<Reply<true>> {
      const v = await b.find(device)
      if (!v) return fail('gone')
      if (v.kind === 'system') return fail('system')
      if (!v.mountpoint) return { ok: true, value: true }
      const target = v.encrypted ? await cleartext(v) : v.device
      const r = await run(['unmount', '-b', target ?? v.device])
      if (!r.ok) return r
      if (v.encrypted) await run(['lock', '-b', v.device])        // leave it locked, as it was found
      return { ok: true, value: true }
    },
    /** Safely remove a removable drive or disc: unmount (and lock) every volume on it, then power it off. */
    async eject(device: string): Promise<Reply<true>> {
      const v = await b.find(device)
      if (!v) return fail('gone')
      if (v.kind !== 'removable' && v.kind !== 'optical') return fail('not_removable')
      const l = await b.list()
      for (const o of l.ok ? l.value.filter((x) => x.disk === v.disk) : [v]) {
        if (o.kind === 'system') return fail('system')
        if (o.mountpoint) { const r = await b.unmount(o.device); if (!r.ok) return r }
      }
      // A disc tray has no power-off; unmounting it is enough for udisks to let the user eject it.
      if (v.kind === 'optical') return { ok: true, value: true }
      const p = await run(['power-off', '-b', v.disk])
      return p.ok ? { ok: true, value: true } : p
    },
  }
  async function cleartext(v: DiskVolume): Promise<string | null> {
    const r = await exec('lsblk', ['-J', '-o', 'PATH,TYPE', v.device])
    try {
      const found = (JSON.parse(r.stdout) as { blockdevices?: Node[] }).blockdevices?.[0]?.children?.find((c) => c.type === 'crypt')?.path
      return found && DEV.test(found) ? found : null
    } catch { return null }
  }
  return b
}
export type VolumesBridge = ReturnType<typeof volumesBridge>

/**
 * udisks2 hotplug: `udisksctl monitor` reports every object added, removed or changed (a drive plugged in, a
 * filesystem mounted, media inserted). Changes are coalesced and reported once things settle. Restarts with back-off
 * if udisksd restarts; does nothing when udisksctl is missing (the view still refreshes when opened).
 */
export function watchVolumes(onChange: () => void, start: () => ChildProcess = () => spawn('udisksctl', ['monitor'], { stdio: ['ignore', 'pipe', 'ignore'] }), debounceMs = 400) {
  let child: ChildProcess | null = null
  let timer: ReturnType<typeof setTimeout> | null = null
  let stopped = false
  let delay = 2000
  const fire = () => { if (timer) clearTimeout(timer); timer = setTimeout(() => { timer = null; onChange() }, debounceMs) }
  const launch = () => {
    if (stopped) return
    try { child = start() } catch { return }
    let missing = false
    child.on('error', (e: NodeJS.ErrnoException) => { if (e.code === 'ENOENT') missing = true })
    child.stdout?.on('data', (chunk: Buffer) => {
      delay = 2000
      // The first lines are the "Monitoring the udisks daemon" banner; only object lines mean a change.
      if (/^\d{2}:\d{2}:\d{2}\.\d+: |Added|Removed|Properties Changed/m.test(String(chunk))) fire()
    })
    child.on('close', () => {
      child = null
      if (stopped || missing) return
      setTimeout(launch, delay)
      delay = Math.min(delay * 2, 60_000)
    })
  }
  launch()
  return () => { stopped = true; if (timer) clearTimeout(timer); child?.kill() }
}

/** Where a mounted volume opens in Files: the root whose folder is its mount point, or Home for the system disk. */
export function rootFor(v: Pick<DiskVolume, 'mountpoint' | 'kind'>, roots: { id: string; path: string }[]): string | null {
  if (!v.mountpoint) return null
  if (v.kind === 'system') return 'home'
  const want = path.resolve(v.mountpoint)
  return roots.find((r) => path.resolve(r.path) === want)?.id ?? null
}

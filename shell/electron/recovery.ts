// Recovery screens → host. Read-only probes with fixed arguments (lsblk, findmnt, systemctl), the package
// service for package repair and update state, and udisks for unlocking a LUKS volume (polkit asks for rights).
// Snapshots, reinstall, copy-to-USB, a root terminal and saving reports have no service yet: they answer
// `unavailable` so the screens can say so. The recovery key/passphrase is only ever written to udisksctl's stdin.
import { execFile, spawn } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'

type Reply<T> = { ok: true; value: T } | { ok: false; error: string }
export type Exec = (cmd: string, args: string[]) => Promise<{ code: number; stdout: string; stderr: string }>

export interface Host {
  exec: Exec
  exists(path: string): boolean
  read(path: string): string | null
  /** Runs cmd with `secret` on stdin only (never argv, env or a file). */
  withStdin(cmd: string, args: string[], secret: string): Promise<{ code: number; stderr: string }>
}

const realHost: Host = {
  exec: (cmd, args) => new Promise((resolve) => {
    execFile(cmd, args, { timeout: 20_000 }, (err, stdout, stderr) => resolve({ code: err ? 1 : 0, stdout, stderr }))
  }),
  exists: (p) => existsSync(p),
  read: (p) => { try { return readFileSync(p, 'utf8') } catch { return null } },
  withStdin: (cmd, args, secret) => new Promise((resolve) => {
    const child = spawn(cmd, args, { stdio: ['pipe', 'ignore', 'pipe'] })
    let stderr = ''
    child.stderr.setEncoding('utf8')
    child.stderr.on('data', (c: string) => { stderr += c })
    child.on('error', () => resolve({ code: 1, stderr: 'spawn_failed' }))
    child.on('close', (code) => resolve({ code: code ?? 1, stderr }))
    child.stdin.end(secret)
  }),
}

export interface LuksDevice { device: string; name: string; label: string | null; version: string | null; size_bytes: number | null; unlocked: boolean }
export type Feature = 'unlock' | 'repair' | 'snapshots' | 'reinstall' | 'copy_usb' | 'terminal' | 'report_usb'
export interface RecoveryInfo {
  os_version: string | null; disk: string | null; firmware: 'EFI' | 'BIOS'; failures: number | null
  luks: LuksDevice[]; features: Record<Feature, boolean>
}

interface BlkNode { path?: string; name?: string; type?: string; fstype?: string | null; fsver?: string | null; label?: string | null; size?: number | string | null; mountpoint?: string | null; children?: BlkNode[] }

export function parseLsblk(json: string): BlkNode[] {
  try { return ((JSON.parse(json) as { blockdevices?: BlkNode[] }).blockdevices) ?? [] } catch { return [] }
}

function walk(nodes: BlkNode[], fn: (n: BlkNode, top: BlkNode) => void, top?: BlkNode) {
  for (const n of nodes) { fn(n, top ?? n); if (n.children) walk(n.children, fn, top ?? n) }
}

export function luksDevices(nodes: BlkNode[]): LuksDevice[] {
  const out: LuksDevice[] = []
  walk(nodes, (n) => {
    if (n.fstype !== 'crypto_LUKS' || !n.path) return
    const size = n.size == null ? null : Number(n.size)
    out.push({ device: n.path, name: n.name ?? n.path, label: n.label ?? null, version: n.fsver ?? null,
      size_bytes: Number.isFinite(size) ? size : null, unlocked: (n.children ?? []).some((c) => c.type === 'crypt') })
  })
  return out
}

/** Name of the whole disk that holds "/" (e.g. "vda", "nvme0n1"). */
export function rootDisk(nodes: BlkNode[]): string | null {
  let disk: string | null = null
  walk(nodes, (n, top) => { if (n.mountpoint === '/') disk = top.name ?? null })
  return disk
}

export function osVersion(osRelease: string | null): string | null {
  const m = /^VERSION_ID="?([^"\n]+)"?/m.exec(osRelease ?? '')
  return m ? m[1] : null
}

const LSBLK = ['-J', '-b', '-o', 'PATH,NAME,TYPE,FSTYPE,FSVER,LABEL,SIZE,MOUNTPOINT']
const UDISKSCTL = '/usr/bin/udisksctl'

export interface PackageProbe {
  checkUpdates(): Promise<Reply<{ state: string }>>
  updateStatus(check?: boolean): Promise<Reply<unknown>>
}

export function recoveryHost(pkg: PackageProbe, host: Host = realHost) {
  const blk = async () => { const r = await host.exec('lsblk', LSBLK); return r.code === 0 ? parseLsblk(r.stdout) : [] }

  return {
    async info(): Promise<RecoveryInfo> {
      const nodes = await blk()
      const n = await host.exec('systemctl', ['--user', 'show', 'worksuite-shell.service', '-p', 'NRestarts', '--value'])
      const restarts = n.code === 0 ? Number.parseInt(n.stdout.trim(), 10) : NaN
      return {
        os_version: osVersion(host.read('/etc/os-release')),
        disk: rootDisk(nodes),
        firmware: host.exists('/sys/firmware/efi') ? 'EFI' : 'BIOS',
        failures: Number.isFinite(restarts) && restarts > 0 ? restarts : null,
        luks: luksDevices(nodes),
        features: { unlock: host.exists(UDISKSCTL), repair: true, snapshots: false, reinstall: false, copy_usb: false, terminal: false, report_usb: false },
      }
    },

    /** One startup-repair check. Never changes anything; package repair is a separate, authorized job. */
    async check(id: string): Promise<{ status: 'ok' | 'problem' | 'unavailable'; note: string; fixable?: boolean }> {
      switch (id) {
        case 'boot': {
          if (!host.exists('/sys/firmware/efi')) return { status: 'ok', note: 'Legacy BIOS' }
          const r = await host.exec('findmnt', ['-n', '-o', 'TARGET', '/boot/efi'])
          return r.code === 0 ? { status: 'ok', note: 'Fine' } : { status: 'problem', note: 'EFI partition not mounted' }
        }
        case 'disk': {
          const r = await host.exec('findmnt', ['-n', '-o', 'FSTYPE,OPTIONS', '/'])
          if (r.code !== 0) return { status: 'unavailable', note: 'Couldn’t read the system disk' }
          const opts = (r.stdout.trim().split(/\s+/)[1] ?? '').split(',')
          return opts.includes('ro') ? { status: 'problem', note: 'Mounted read-only: file system errors' } : { status: 'ok', note: 'Fine' }
        }
        case 'crypt': {
          const l = luksDevices(await blk())
          if (!l.length) return { status: 'ok', note: 'Not encrypted' }
          return l.every((d) => d.unlocked) ? { status: 'ok', note: 'Unlocked' } : { status: 'problem', note: 'Locked' }
        }
        case 'packages': {
          const r = await pkg.checkUpdates()
          if (!r.ok) return { status: 'unavailable', note: 'Package service isn’t running' }
          return r.value.state === 'interrupted' ? { status: 'problem', note: 'Interrupted package changes', fixable: true } : { status: 'ok', note: 'Fine' }
        }
        case 'update': {
          const r = await pkg.updateStatus(false)
          if (!r.ok) return { status: 'unavailable', note: 'Update service isn’t running' }
          const s = r.value as { state?: string; installed?: string; reason?: string | null }
          if (s.state === 'failed') return { status: 'problem', note: s.reason ? `Failed: ${s.reason}` : 'Failed' }
          return { status: 'ok', note: s.installed ? `Version ${s.installed}` : 'Fine' }
        }
        case 'drivers': return { status: 'unavailable', note: 'Not checked in this version' }
        default: return { status: 'unavailable', note: 'Unknown check' }
      }
    },

    async unlock(device: string, secret: string): Promise<Reply<true>> {
      if (!host.exists(UDISKSCTL)) return { ok: false, error: 'unavailable' }
      if (!secret) return { ok: false, error: 'wrong_key' }
      const dev = luksDevices(await blk()).find((d) => d.device === device)
      if (!dev) return { ok: false, error: 'not_found' }
      if (dev.unlocked) return { ok: false, error: 'already_unlocked' }
      const r = await host.withStdin(UDISKSCTL, ['unlock', '--block-device', dev.device, '--key-file', '/dev/stdin'], secret)
      if (r.code === 0) return { ok: true, value: true }
      if (/NotAuthorized|not authorized|dismissed/i.test(r.stderr)) return { ok: false, error: 'not_authorized' }
      if (/No key available|Operation not permitted|Failed to activate|passphrase/i.test(r.stderr)) return { ok: false, error: 'wrong_key' }
      return { ok: false, error: 'failed' }
    },

    unavailable: async (): Promise<Reply<never>> => ({ ok: false, error: 'unavailable' }),
  }
}

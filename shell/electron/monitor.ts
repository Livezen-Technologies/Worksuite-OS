// System monitor (G11): CPU, memory, disk and network rates and per-app usage read straight from /proc, the way
// top and gnome-system-monitor do. Processes are grouped by their systemd cgroup: an app scope (app-<id>-….scope)
// is one app, the shell's own unit is "WorkSuite shell", system.slice/init.scope are "System services", and the
// rest of the user's processes are grouped by command name. Rates are deltas between two samples, so the first
// sample has none. Nothing here writes, except "End process", which only signals the user's own processes.
import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import type { Exec } from './system'
import { xdgDirs } from './xdgDirs'

export interface CpuStat { total: number; idle: number; cores: number }
export interface MemStat { total: number; available: number }
export interface IoStat { read: number; write: number }
export interface NetStat { rx: number; tx: number }
export interface PidStat { pid: number; comm: string; ticks: number; rss: number; uid: number | null; cgroup: string }

export type GroupKind = 'shell' | 'app' | 'system' | 'user'
export interface MonitorGroup { key: string; kind: GroupKind; name: string; count: number; cpu: number | null; mem: number; energy: 'high' | 'medium' | 'low' | null }
export interface MonitorProcess { pid: number; name: string; group: string; cpu: number | null; mem: number; own: boolean }
export interface MonitorSnapshot {
  at: number
  cpu: { percent: number | null; cores: number; mhz: number | null }
  memory: { used: number; total: number }
  disk: { read_bps: number | null; write_bps: number | null }
  net: { rx_bps: number | null; tx_bps: number | null }
  groups: MonitorGroup[]
  processes: MonitorProcess[]
}

// ---------- parsers (pure) ----------
/** First `cpu` line of /proc/stat: total and idle (idle + iowait) jiffies; cores = number of `cpuN` lines. */
export function parseProcStat(text: string): CpuStat | null {
  const lines = text.split('\n')
  const all = lines.find((l) => /^cpu\s/.test(l))
  if (!all) return null
  const n = all.trim().split(/\s+/).slice(1).map(Number)
  // user nice system idle iowait irq softirq steal (guest time is already inside user/nice)
  const total = n.slice(0, 8).reduce((a, b) => a + (b || 0), 0)
  return { total, idle: (n[3] || 0) + (n[4] || 0), cores: lines.filter((l) => /^cpu\d+\s/.test(l)).length }
}

export function parseMeminfo(text: string): MemStat | null {
  const kb = (k: string) => { const m = new RegExp(`^${k}:\\s+(\\d+)\\s*kB`, 'm').exec(text); return m ? Number(m[1]) * 1024 : null }
  const total = kb('MemTotal'), available = kb('MemAvailable')
  return total == null || available == null ? null : { total, available }
}

const WHOLE_DISK = /^(sd[a-z]+|vd[a-z]+|xvd[a-z]+|hd[a-z]+|nvme\d+n\d+|mmcblk\d+)$/
/** /proc/diskstats summed over whole disks (partitions and device-mapper would count the same I/O twice). */
export function parseDiskstats(text: string): IoStat {
  let read = 0, write = 0
  for (const line of text.split('\n')) {
    const f = line.trim().split(/\s+/)
    if (f.length < 10 || !WHOLE_DISK.test(f[2])) continue
    read += Number(f[5]) * 512; write += Number(f[9]) * 512
  }
  return { read, write }
}

/** /proc/net/dev summed over every interface but loopback. */
export function parseNetDev(text: string): NetStat {
  let rx = 0, tx = 0
  for (const line of text.split('\n')) {
    const m = /^\s*([^:\s]+):\s*(.*)$/.exec(line)
    if (!m || m[1] === 'lo') continue
    const f = m[2].trim().split(/\s+/).map(Number)
    rx += f[0] || 0; tx += f[8] || 0
  }
  return { rx, tx }
}

/** Average "cpu MHz" over /proc/cpuinfo; null where the kernel doesn't report it (many ARM boards). */
export function parseCpuMhz(text: string): number | null {
  const v = [...text.matchAll(/^cpu MHz\s*:\s*([\d.]+)/gm)].map((m) => Number(m[1])).filter((x) => x > 0)
  return v.length ? v.reduce((a, b) => a + b, 0) / v.length : null
}

/** /proc/<pid>/stat → command name and utime+stime. The name is in parentheses and may itself contain them. */
export function parsePidStat(text: string): { comm: string; ticks: number } | null {
  const open = text.indexOf('('), close = text.lastIndexOf(')')
  if (open < 0 || close < open) return null
  const rest = text.slice(close + 2).split(' ')
  // rest[0] is field 3 (state); utime and stime are fields 14 and 15.
  const ticks = Number(rest[11]) + Number(rest[12])
  return Number.isFinite(ticks) ? { comm: text.slice(open + 1, close), ticks } : null
}

/** The unified (v2) cgroup path from /proc/<pid>/cgroup. */
export function parseCgroup(text: string): string {
  return /^0::(.*)$/m.exec(text)?.[1]?.trim() ?? ''
}

/**
 * What a process belongs to, from its cgroup path. App scopes follow the XDG/systemd convention
 * app[-<launcher>]-<app id>[@…]-<random>.scope (or .service); flatpak's launcher id is "flatpak".
 */
export function classify(cgroup: string, shellUnit = 'worksuite-shell.service'): { kind: GroupKind; id: string | null } {
  const units = cgroup.split('/').filter(Boolean)
  if (units.includes(shellUnit)) return { kind: 'shell', id: null }
  if (units.includes('system.slice') || units.includes('init.scope')) return { kind: 'system', id: null }
  const app = [...units].reverse().find((u) => /^app-.+\.(scope|service)$/.test(u))
  if (app) {
    let id = app.replace(/\.(scope|service)$/, '').replace(/^app-/, '').replace(/@[^-]*$/, '')
    if (app.endsWith('.scope')) id = id.replace(/-[0-9a-f]{6,}$|-\d+$/, '')
    id = id.replace(/^(flatpak|gnome|kde|worksuite|dbus\\x2d[^-]*)-/, '').replace(/\\x2d/g, '-')
    return { kind: 'app', id }
  }
  return { kind: 'user', id: null }
}

/** Energy impact from the share of CPU time; there is no per-process power meter on this hardware. */
export function energyOf(cpu: number | null): MonitorGroup['energy'] {
  if (cpu == null) return null
  return cpu >= 5 ? 'high' : cpu >= 1.5 ? 'medium' : 'low'
}

// ---------- sampler ----------
export interface ProcSource {
  read(path: string): string | null
  pids(): number[]
  pageSize: number
  uid: number | null
  /** Names for app ids (desktop entry names); falls back to the id. */
  appName(id: string): string | null
  now(): number
}

export const realProcSource = (appName: (id: string) => string | null): ProcSource => ({
  read(p) { try { return readFileSync(p, 'utf8') } catch { return null } },
  pids() { try { return readdirSync('/proc').filter((n) => /^\d+$/.test(n)).map(Number) } catch { return [] } },
  pageSize: 4096,
  uid: typeof process.getuid === 'function' ? process.getuid() : null,
  appName,
  now: () => Date.now(),
})

interface Prev { at: number; cpu: CpuStat; io: IoStat; net: NetStat; ticks: Map<number, number> }

export function monitorSampler(src: ProcSource, shellPids: () => Set<number> = () => new Set()) {
  let prev: Prev | null = null
  const readPid = (pid: number): PidStat | null => {
    const st = src.read(`/proc/${pid}/stat`)
    const p = st ? parsePidStat(st) : null
    if (!p) return null
    const statm = src.read(`/proc/${pid}/statm`)
    const rss = statm ? Number(statm.split(' ')[1]) * src.pageSize : 0
    const status = src.read(`/proc/${pid}/status`)
    const uid = status ? Number(/^Uid:\s+(\d+)/m.exec(status)?.[1] ?? NaN) : NaN
    return { pid, comm: p.comm, ticks: p.ticks, rss: Number.isFinite(rss) ? rss : 0, uid: Number.isFinite(uid) ? uid : null, cgroup: parseCgroup(src.read(`/proc/${pid}/cgroup`) ?? '') }
  }

  return {
    sample(): { available: true; value: MonitorSnapshot } | { available: false; reason: string } {
      const stat = src.read('/proc/stat'), mem = src.read('/proc/meminfo')
      const cpu = stat ? parseProcStat(stat) : null
      const m = mem ? parseMeminfo(mem) : null
      if (!cpu || !m) return { available: false, reason: 'proc_unavailable' }
      const io = parseDiskstats(src.read('/proc/diskstats') ?? '')
      const net = parseNetDev(src.read('/proc/net/dev') ?? '')
      const at = src.now()
      const dt = prev ? (at - prev.at) / 1000 : 0
      const dTotal = prev ? cpu.total - prev.cpu.total : 0
      const rate = (a: number, b: number | undefined) => (prev && dt > 0 && b !== undefined ? Math.max(0, (a - b) / dt) : null)
      const share = (t: number, pt: number | undefined) => (prev && dTotal > 0 && pt !== undefined ? Math.max(0, ((t - pt) / dTotal) * 100) : null)

      const shell = shellPids()
      const ticks = new Map<number, number>()
      const procs: MonitorProcess[] = []
      const groups = new Map<string, MonitorGroup>()
      for (const pid of src.pids()) {
        const p = readPid(pid)
        if (!p) continue
        ticks.set(pid, p.ticks)
        // Kernel threads have no memory map; they count as system services wherever their cgroup is.
        const c = shell.has(pid) ? { kind: 'shell' as const, id: null } : p.rss === 0 ? { kind: 'system' as const, id: null } : classify(p.cgroup)
        const key = c.kind === 'app' ? `app:${c.id}` : c.kind === 'user' ? `user:${p.comm}` : c.kind
        const name = c.kind === 'app' ? src.appName(c.id!) ?? c.id! : c.kind === 'user' ? p.comm : ''
        const cpuPct = share(p.ticks, prev?.ticks.get(pid))
        procs.push({ pid, name: p.comm, group: key, cpu: cpuPct, mem: p.rss, own: src.uid != null && p.uid === src.uid })
        const g = groups.get(key) ?? { key, kind: c.kind, name, count: 0, cpu: prev ? 0 : null, mem: 0, energy: null }
        g.count++; g.mem += p.rss
        if (g.cpu != null) g.cpu += cpuPct ?? 0
        groups.set(key, g)
      }
      for (const g of groups.values()) g.energy = energyOf(g.cpu)
      const value: MonitorSnapshot = {
        at,
        cpu: { percent: prev && dTotal > 0 ? Math.max(0, Math.min(100, (1 - (cpu.idle - prev.cpu.idle) / dTotal) * 100)) : null, cores: cpu.cores, mhz: parseCpuMhz(src.read('/proc/cpuinfo') ?? '') },
        memory: { used: m.total - m.available, total: m.total },
        disk: { read_bps: rate(io.read, prev?.io.read), write_bps: rate(io.write, prev?.io.write) },
        net: { rx_bps: rate(net.rx, prev?.net.rx), tx_bps: rate(net.tx, prev?.net.tx) },
        groups: [...groups.values()].sort((a, b) => (b.cpu ?? 0) - (a.cpu ?? 0) || b.mem - a.mem),
        processes: procs.sort((a, b) => (b.cpu ?? 0) - (a.cpu ?? 0) || b.mem - a.mem),
      }
      prev = { at, cpu, io, net, ticks }
      return { available: true, value }
    },
  }
}

/** Every descendant of `root` (the shell's renderer, GPU and utility processes), from /proc/<pid>/stat ppids. */
export function descendants(src: Pick<ProcSource, 'read' | 'pids'>, root: number): Set<number> {
  const children = new Map<number, number[]>()
  for (const pid of src.pids()) {
    const st = src.read(`/proc/${pid}/stat`)
    if (!st) continue
    const ppid = Number(st.slice(st.lastIndexOf(')') + 2).split(' ')[1])
    children.set(ppid, [...(children.get(ppid) ?? []), pid])
  }
  const out = new Set<number>([root])
  const stack = [root]
  while (stack.length) for (const c of children.get(stack.pop()!) ?? []) if (!out.has(c)) { out.add(c); stack.push(c) }
  return out
}

// ---------- health (this boot) ----------
export interface HealthItem { id: 'boot' | 'signin' | 'memory' | 'cpu' | 'launch' | 'resume' | 'restarts'; value: number | null; unit: 's' | 'bytes' | 'pct' | 'count'; limit: number; ok: boolean | null }

/** `systemd-analyze time`: "Startup finished in … = 22.4s" (or "1min 2.3s"); seconds, or null. */
export function parseAnalyzeTime(text: string): number | null {
  const m = /=\s*((?:\d+min\s*)?[\d.]+m?s)\s*$/m.exec(text)
  if (!m) return null
  const min = /(\d+)min/.exec(m[1]), s = /([\d.]+)(m?s)$/.exec(m[1])
  if (!s) return null
  return (min ? Number(min[1]) * 60 : 0) + Number(s[1]) / (s[2] === 'ms' ? 1000 : 1)
}

// SRS §16 limits on reference hardware (tests/perf/gates.tsv, hw-amd64).
export const LIMITS = { boot: 30, signin: 5, memory: 1536 * 1024 * 1024, cpu: 2, launch: 2, restarts: 0 }

export async function health(exec: Exec, shellReadyMs: number | null, mem: MemStat | null, cpuPct: number | null): Promise<HealthItem[]> {
  const [a, r] = await Promise.all([exec('systemd-analyze', ['time']), exec('systemctl', ['--user', 'show', 'worksuite-shell.service', '-p', 'NRestarts', '--value'])])
  const boot = a.code === 0 ? parseAnalyzeTime(a.stdout) : null
  const restarts = r.code === 0 && /^\s*\d+\s*$/.test(r.stdout) ? Number(r.stdout) : null
  const used = mem ? mem.total - mem.available : null
  const item = (id: HealthItem['id'], value: number | null, unit: HealthItem['unit'], limit: number, strict = false): HealthItem =>
    ({ id, value, unit, limit, ok: value == null ? null : strict ? value < limit : value <= limit })
  return [
    item('boot', boot, 's', LIMITS.boot),
    item('signin', shellReadyMs == null ? null : shellReadyMs / 1000, 's', LIMITS.signin),
    item('memory', used, 'bytes', LIMITS.memory),
    item('cpu', cpuPct, 'pct', LIMITS.cpu, true),
    // No launch-time or resume probes run in a user session; they are measured only by tests/perf on test images.
    item('launch', null, 's', LIMITS.launch),
    item('restarts', restarts, 'count', LIMITS.restarts),
  ]
}

// ---------- startup apps ----------
export interface StartupEntry { id: string; name: string; comment: string | null; enabled: boolean; scope: 'user' | 'system' }

/** XDG autostart: ~/.config/autostart overrides /etc/xdg/autostart by file name; Hidden=true turns one off. */
export function parseAutostart(files: { dir: 'user' | 'system'; name: string; text: string }[], desktop = 'WorkSuite'): StartupEntry[] {
  const by = new Map<string, StartupEntry>()
  for (const f of [...files.filter((x) => x.dir === 'system'), ...files.filter((x) => x.dir === 'user')]) {
    const sect = f.text.split(/^\[/m).find((s) => s.startsWith('Desktop Entry]')) ?? ''
    const kv = (k: string) => new RegExp(`^${k}=(.*)$`, 'm').exec(sect)?.[1]?.trim() ?? null
    const only = kv('OnlyShowIn'), not = kv('NotShowIn')
    if (only && !only.split(';').includes(desktop)) { by.delete(f.name); continue }
    if (not && not.split(';').includes(desktop)) { by.delete(f.name); continue }
    by.set(f.name, { id: f.name, name: kv('Name') ?? f.name.replace(/\.desktop$/, ''), comment: kv('Comment'), enabled: kv('Hidden') !== 'true' && kv('X-GNOME-Autostart-enabled') !== 'false', scope: f.dir })
  }
  return [...by.values()].sort((a, b) => a.name.localeCompare(b.name))
}

export function readAutostart(home: string): StartupEntry[] {
  const files: { dir: 'user' | 'system'; name: string; text: string }[] = []
  for (const [dir, path] of [['system', '/etc/xdg/autostart'], ['user', join(xdgDirs(home).config, 'autostart')]] as const) {
    let names: string[] = []
    try { names = readdirSync(path).filter((n) => n.endsWith('.desktop')) } catch { continue }
    for (const name of names) { try { files.push({ dir, name, text: readFileSync(join(path, name), 'utf8') }) } catch { /* unreadable */ } }
  }
  return parseAutostart(files)
}

/** SIGTERM to one of the user's own processes; never the shell itself. */
export function endProcess(pid: number, own: (pid: number) => boolean, kill: (pid: number, sig: string) => void, shell: Set<number>): { ok: true; value: true } | { ok: false; error: string } {
  if (!Number.isInteger(pid) || pid <= 1) return { ok: false, error: 'invalid_argument' }
  if (shell.has(pid)) return { ok: false, error: 'not_allowed' }
  if (!own(pid)) return { ok: false, error: 'not_allowed' }
  try { kill(pid, 'SIGTERM'); return { ok: true, value: true } } catch { return { ok: false, error: 'failed' } }
}

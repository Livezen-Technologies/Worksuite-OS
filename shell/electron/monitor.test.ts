import { describe, expect, it } from 'vitest'
import { classify, descendants, endProcess, energyOf, health, monitorSampler, parseAnalyzeTime, parseAutostart, parseCgroup, parseCpuMhz, parseDiskstats, parseMeminfo, parseNetDev, parsePidStat, parseProcStat, type ProcSource } from './monitor'
import { overrideFlag, parseUserOff, splitPermissions, flatpakPermsClient } from './flatpakPerms'
import { pickBacklight, quickBridge, type BacklightFs } from './quick'

describe('proc parsers', () => {
  it('reads /proc/stat totals and cores', () => {
    const s = parseProcStat('cpu  100 0 50 800 50 0 0 0 0 0\ncpu0 50 0 25 400 25 0 0 0 0 0\ncpu1 50 0 25 400 25 0 0 0 0 0\nintr 1\n')!
    expect(s).toEqual({ total: 1000, idle: 850, cores: 2 })
    expect(parseProcStat('nothing')).toBeNull()
  })
  it('reads meminfo, diskstats (whole disks only) and net/dev (no loopback)', () => {
    expect(parseMeminfo('MemTotal:       16000 kB\nMemFree: 1 kB\nMemAvailable:    4000 kB\n')).toEqual({ total: 16000 * 1024, available: 4000 * 1024 })
    const disk = '   8       0 sda 10 0 200 0 5 0 100 0 0 0 0\n   8       1 sda1 10 0 200 0 5 0 100 0 0 0 0\n 259 0 nvme0n1 1 0 2 0 1 0 4 0 0 0 0\n   7 0 loop0 1 0 999 0 1 0 999 0 0 0 0\n'
    expect(parseDiskstats(disk)).toEqual({ read: (200 + 2) * 512, write: (100 + 4) * 512 })
    const net = 'Inter-|   Receive\n face |bytes\n    lo: 999 0 0 0 0 0 0 0 999 0 0 0 0 0 0 0\n  eth0: 1000 5 0 0 0 0 0 0 300 4 0 0 0 0 0 0\n'
    expect(parseNetDev(net)).toEqual({ rx: 1000, tx: 300 })
    expect(parseCpuMhz('cpu MHz\t\t: 2000.000\ncpu MHz\t\t: 3000.000\n')).toBe(2500)
    expect(parseCpuMhz('')).toBeNull()
  })
  it('reads a pid stat line whose name has spaces and parentheses', () => {
    expect(parsePidStat('42 (Web (Content)) S 1 42 42 0 -1 4194560 100 0 0 0 7 3 0 0 20 0 1 0 100 1000 50')).toEqual({ comm: 'Web (Content)', ticks: 10 })
    expect(parseCgroup('0::/user.slice/user-1000.slice/user@1000.service/app.slice/app-flatpak-com.slack.Slack-1234.scope\n')).toContain('app-flatpak')
  })
  it('classifies cgroups into shell, apps, system and the rest', () => {
    expect(classify('/user.slice/user-1000.slice/user@1000.service/app.slice/worksuite-shell.service').kind).toBe('shell')
    expect(classify('/system.slice/NetworkManager.service').kind).toBe('system')
    expect(classify('/user.slice/user-1000.slice/user@1000.service/app.slice/app-flatpak-com.slack.Slack-1234.scope')).toEqual({ kind: 'app', id: 'com.slack.Slack' })
    expect(classify('/user.slice/user-1000.slice/user@1000.service/app.slice/app-worksuite-firefox\\x2desr-8f3a2b.scope')).toEqual({ kind: 'app', id: 'firefox-esr' })
    expect(classify('/user.slice/user-1000.slice/session-2.scope').kind).toBe('user')
    expect([energyOf(null), energyOf(0.2), energyOf(2), energyOf(9)]).toEqual([null, 'low', 'medium', 'high'])
  })
})

function fakeSource(): ProcSource & { tick: (n: number) => void } {
  let t = 0, cpuTotal = 1000, idle = 900, pTicks = 10
  const files = () => ({
    '/proc/stat': `cpu  ${cpuTotal - idle} 0 0 ${idle} 0 0 0 0\ncpu0 1 0 0 1 0 0 0 0\n`,
    '/proc/meminfo': 'MemTotal: 1000 kB\nMemAvailable: 400 kB\n',
    '/proc/diskstats': `8 0 sda 0 0 ${t * 2} 0 0 0 ${t} 0 0 0 0\n`,
    '/proc/net/dev': `eth0: ${t * 1000} 0 0 0 0 0 0 0 ${t * 10} 0 0 0 0 0 0 0\n`,
    '/proc/cpuinfo': 'cpu MHz : 1000\n',
    '/proc/10/stat': `10 (slack) S 1 1 1 0 -1 0 0 0 0 0 ${pTicks} 0 0 0`,
    '/proc/10/statm': '100 25 0 0 0 0 0',
    '/proc/10/status': 'Name: slack\nUid:\t1000\t1000\t1000\t1000\n',
    '/proc/10/cgroup': '0::/user.slice/user-1000.slice/user@1000.service/app.slice/app-flatpak-com.slack.Slack-99.scope\n',
    '/proc/2/stat': '2 (kthreadd) S 0 0 0 0 -1 0 0 0 0 0 0 0 0 0',
    '/proc/2/statm': '0 0 0 0 0 0 0',
    '/proc/2/status': 'Uid:\t0\t0\t0\t0\n',
    '/proc/2/cgroup': '0::/\n',
  } as Record<string, string>)
  return {
    read: (p) => files()[p] ?? null, pids: () => [2, 10], pageSize: 4096, uid: 1000,
    appName: (id) => (id === 'com.slack.Slack' ? 'Slack' : null), now: () => t * 1000,
    tick(n) { t += n; cpuTotal += 1000 * n; idle += 800 * n; pTicks += 50 * n },
  }
}

describe('monitor sampler', () => {
  it('has no rates on the first sample, then deltas per second and per app', () => {
    const src = fakeSource()
    const m = monitorSampler(src)
    const a = m.sample()
    expect(a.available && a.value.cpu.percent).toBeNull()
    expect(a.available && a.value.memory).toEqual({ used: 600 * 1024, total: 1000 * 1024 })
    src.tick(2)
    const b = m.sample()
    if (!b.available) throw new Error('unavailable')
    expect(b.value.cpu.percent).toBeCloseTo(20)
    expect(b.value.disk).toEqual({ read_bps: 512 * 2, write_bps: 512 })
    expect(b.value.net).toEqual({ rx_bps: 1000, tx_bps: 10 })
    const slack = b.value.groups.find((g) => g.key === 'app:com.slack.Slack')!
    expect(slack).toMatchObject({ name: 'Slack', kind: 'app', count: 1, mem: 25 * 4096, energy: 'high' })
    expect(slack.cpu).toBeCloseTo(5)
    expect(b.value.groups.find((g) => g.kind === 'system')!.count).toBe(1)
    expect(b.value.processes.find((p) => p.pid === 10)!.own).toBe(true)
    expect(b.value.processes.find((p) => p.pid === 2)!.own).toBe(false)
  })
  it('is unavailable without /proc', () => {
    expect(monitorSampler({ ...fakeSource(), read: () => null }).sample()).toEqual({ available: false, reason: 'proc_unavailable' })
  })
  it('finds the shell process tree', () => {
    const stat: Record<string, string> = { '/proc/5/stat': '5 (a) S 1 0', '/proc/6/stat': '6 (b) S 5 0', '/proc/7/stat': '7 (c) S 6 0', '/proc/8/stat': '8 (d) S 1 0' }
    expect([...descendants({ read: (p) => stat[p] ?? null, pids: () => [5, 6, 7, 8] }, 5)].sort()).toEqual([5, 6, 7])
  })
  it('ends only the user’s own processes, never the shell', () => {
    const kills: number[] = []
    const kill = (p: number) => { kills.push(p) }
    expect(endProcess(10, () => true, kill, new Set([5]))).toEqual({ ok: true, value: true })
    expect(endProcess(5, () => true, kill, new Set([5])).ok).toBe(false)
    expect(endProcess(11, () => false, kill, new Set()).ok).toBe(false)
    expect(endProcess(1, () => true, kill, new Set()).ok).toBe(false)
    expect(kills).toEqual([10])
  })
})

describe('health', () => {
  it('parses systemd-analyze totals', () => {
    expect(parseAnalyzeTime('Startup finished in 2.101s (kernel) + 7.712s (userspace) = 9.813s\ngraphical.target reached after 7.6s in userspace.')).toBeCloseTo(9.813)
    expect(parseAnalyzeTime('Startup finished in 3.2s (firmware) + 1min 2.5s (userspace) = 1min 5.700s')).toBeCloseTo(65.7)
    expect(parseAnalyzeTime('Bootup is not yet finished')).toBeNull()
  })
  it('reports unmeasured items as null instead of a number', async () => {
    const exec = async (cmd: string) => (cmd === 'systemd-analyze' ? { code: 0, stdout: 'Startup finished in 1s (kernel) + 2s (userspace) = 3.000s\n', stderr: '' } : { code: 0, stdout: '1\n', stderr: '' })
    const h = await health(exec, 2100, { total: 4e9, available: 3e9 }, 1.5)
    expect(Object.fromEntries(h.map((x) => [x.id, [x.value, x.ok]]))).toEqual({ boot: [3, true], signin: [2.1, true], memory: [1e9, true], cpu: [1.5, true], launch: [null, null], restarts: [1, false] })
  })
  it('lists autostart entries with user overrides and desktop filters', () => {
    const e = parseAutostart([
      { dir: 'system', name: 'a.desktop', text: '[Desktop Entry]\nName=Alpha\n' },
      { dir: 'system', name: 'b.desktop', text: '[Desktop Entry]\nName=Beta\nOnlyShowIn=GNOME;\n' },
      { dir: 'system', name: 'c.desktop', text: '[Desktop Entry]\nName=Gamma\n' },
      { dir: 'user', name: 'c.desktop', text: '[Desktop Entry]\nName=Gamma\nHidden=true\n' },
    ])
    expect(e.map((x) => [x.name, x.enabled, x.scope])).toEqual([['Alpha', true, 'system'], ['Gamma', false, 'user']])
  })
})

describe('quick settings bridge', () => {
  const fs = (devs: Record<string, Record<string, string>>): BacklightFs => ({ list: () => Object.keys(devs), read: (d, f) => devs[d]?.[f] ?? null })
  it('prefers firmware backlights and sets brightness through logind', async () => {
    const f = fs({ acpi_video0: { type: 'firmware\n', brightness: '50', max_brightness: '100' }, intel_backlight: { type: 'raw', brightness: '1', max_brightness: '1000' } })
    expect(pickBacklight(f)).toEqual({ device: 'acpi_video0', cur: 50, max: 100 })
    const calls: string[][] = []
    const q = quickBridge(async (cmd, args) => { calls.push([cmd, ...args]); return { code: 0, stdout: '', stderr: '' } }, f)
    expect(q.brightness()).toEqual({ available: true, value: { device: 'acpi_video0', percent: 50 } })
    await q.setBrightness(30)
    expect(calls[0]).toEqual(['busctl', 'call', 'org.freedesktop.login1', '/org/freedesktop/login1/session/auto', 'org.freedesktop.login1.Session', 'SetBrightness', 'ssu', 'backlight', 'acpi_video0', '30'])
    expect(quickBridge(async () => ({ code: 0, stdout: '', stderr: '' }), fs({})).brightness()).toEqual({ available: false, reason: 'no_backlight' })
  })
})

describe('flatpak permission switches', () => {
  it('maps permissions to override flags and reads user overrides', () => {
    expect(splitPermissions(['filesystems=home;xdg-download:ro', 'shared=network;ipc'])).toEqual(['filesystems=home', 'filesystems=xdg-download:ro', 'shared=network', 'shared=ipc'])
    expect(overrideFlag('filesystems=xdg-download:ro', false)).toBe('--nofilesystem=xdg-download')
    expect(overrideFlag('filesystems=xdg-download:ro', true)).toBe('--filesystem=xdg-download:ro')
    expect(overrideFlag('shared=network', false)).toBe('--unshare=network')
    expect(overrideFlag('sockets=x11', false)).toBe('--nosocket=x11')
    expect(overrideFlag('session-bus=org.x', false)).toBeNull()
    expect(overrideFlag('filesystems=$(rm)', false)).toBeNull()
    expect(parseUserOff('[Context]\nfilesystems=!home;xdg-music;\nshared=!network;\n')).toEqual(['filesystems=home', 'shared=network'])
  })
  it('only changes permissions the app declares', async () => {
    const calls: string[][] = []
    const c = flatpakPermsClient(async (cmd, args) => { calls.push([cmd, ...args]); return { code: 0, stdout: '', stderr: '' } })
    expect((await c.set('flatpak:com.slack.Slack', 'filesystems=host', true, ['filesystems=xdg-download'])).ok).toBe(false)
    expect((await c.set('apt:gimp', 'shared=network', false, ['shared=network'])).ok).toBe(false)
    expect(await c.set('flatpak:com.slack.Slack', 'shared=network', false, ['shared=network;ipc'])).toEqual({ ok: true, value: true })
    expect(calls).toEqual([['flatpak', 'override', '--user', '--unshare=network', 'com.slack.Slack']])
  })
})

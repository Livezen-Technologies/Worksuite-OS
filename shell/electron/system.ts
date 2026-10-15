// Read-only facts for Settings (users, network, Bluetooth, displays, sound). Files and fixed-argument
// commands only, as the logged-in user; anything that can't be read comes back as "unavailable".
import { execFile } from 'node:child_process'
import { readFileSync, readdirSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'

type Reply<T> = { ok: true; value: T } | { ok: false; error: string }
export type Exec = (cmd: string, args: string[]) => Promise<string | null>
const realExec: Exec = (cmd, args) => new Promise((resolve) => {
  execFile(cmd, args, { timeout: 5000, env: { ...process.env, LC_ALL: 'C' } }, (err, stdout) => resolve(err ? null : stdout))
})
const read = (p: string) => { try { return readFileSync(p, 'utf8') } catch { return null } }
const list = (p: string) => { try { return readdirSync(p) } catch { return [] } }

export interface LocalUser { login: string; name: string; uid: number; admin: boolean }

/** /etc/passwd + /etc/group → people (uid 1000–59999 with a login shell); admin = sudo or wheel member. */
export function parseUsers(passwd: string, group: string): LocalUser[] {
  const admins = new Set(group.split('\n').filter((l) => /^(sudo|wheel|admin):/.test(l)).flatMap((l) => (l.split(':')[3] ?? '').split(',').filter(Boolean)))
  return passwd.split('\n').map((l) => l.split(':')).filter((f) => f.length >= 7).map((f) => ({ login: f[0], uid: Number(f[2]), name: (f[4] ?? '').split(',')[0] || f[0], shell: f[6] }))
    .filter((u) => u.uid >= 1000 && u.uid < 60000 && !/(nologin|false)$/.test(u.shell))
    .map(({ login, uid, name }) => ({ login, uid, name, admin: admins.has(login) }))
}

export interface WifiNet { ssid: string; signal: number; secure: boolean; active: boolean }
/** `nmcli -t -f ACTIVE,SSID,SIGNAL,SECURITY dev wifi list` (":" escaped as "\:"). Hidden networks dropped, best signal per SSID. */
export function parseWifi(out: string): WifiNet[] {
  const best = new Map<string, WifiNet>()
  for (const line of out.split('\n')) {
    const f = line.split(/(?<!\\):/).map((x) => x.replace(/\\:/g, ':'))
    if (f.length < 4 || !f[1]) continue
    const n = { active: f[0] === 'yes', ssid: f[1], signal: Number(f[2]) || 0, secure: !!f[3] && f[3] !== '--' }
    const old = best.get(n.ssid)
    if (!old || n.active || (!old.active && n.signal > old.signal)) best.set(n.ssid, n)
  }
  return [...best.values()].sort((a, b) => Number(b.active) - Number(a.active) || b.signal - a.signal)
}

export interface NetIf { name: string; type: 'wifi' | 'ethernet'; up: boolean }
export interface NetworkInfo { interfaces: NetIf[]; wifi: WifiNet[] | null; wifi_enabled: boolean | null }

export interface BtDevice { address: string; name: string; connected: boolean | null }
export interface BluetoothInfo { adapter: boolean; powered: boolean | null; name: string | null; paired: BtDevice[] | null }
/** `bluetoothctl devices Paired` → "Device AA:BB:… Name". */
export function parseBtDevices(out: string): BtDevice[] {
  return out.split('\n').map((l) => /^Device ([0-9A-F:]{17}) (.+)$/i.exec(l.trim())).filter((m): m is RegExpExecArray => !!m)
    .map((m) => ({ address: m[1], name: m[2], connected: null }))
}

export interface DisplayOutput { name: string; built_in: boolean; mode: string | null }
export interface DisplayInfo { outputs: DisplayOutput[]; brightness: number | null }

export interface SoundDevice { name: string | null; volume: number; muted: boolean }
export interface SoundInfo { output: SoundDevice | null; input: SoundDevice | null }
/** `wpctl get-volume` → "Volume: 0.40 [MUTED]". */
export function parseVolume(out: string | null): { volume: number; muted: boolean } | null {
  const m = /Volume:\s*([\d.]+)(.*)/.exec(out ?? '')
  return m ? { volume: Math.round(Number(m[1]) * 100), muted: /MUTED/.test(m[2]) } : null
}

export function systemInfo(root = '/', exec: Exec = realExec) {
  const sys = (...p: string[]) => path.join(root, 'sys', ...p)
  return {
    users(): Reply<{ current: string; users: LocalUser[] }> {
      const passwd = read(path.join(root, 'etc/passwd'))
      if (!passwd) return { ok: false, error: 'unavailable' }
      return { ok: true, value: { current: os.userInfo().username, users: parseUsers(passwd, read(path.join(root, 'etc/group')) ?? '') } }
    },
    async network(): Promise<Reply<NetworkInfo>> {
      const interfaces = list(sys('class', 'net')).filter((n) => n !== 'lo').flatMap((n): NetIf[] => {
        const wifi = list(sys('class', 'net', n)).includes('wireless') || list(sys('class', 'net', n)).includes('phy80211')
        const physical = list(sys('class', 'net', n)).includes('device')
        if (!physical) return []
        return [{ name: n, type: wifi ? 'wifi' : 'ethernet', up: (read(sys('class', 'net', n, 'operstate')) ?? '').trim() === 'up' }]
      })
      const radio = await exec('nmcli', ['-t', 'radio', 'wifi'])
      const scan = radio === null ? null : await exec('nmcli', ['-t', '-f', 'ACTIVE,SSID,SIGNAL,SECURITY', 'device', 'wifi', 'list', '--rescan', 'no'])
      return { ok: true, value: { interfaces, wifi: scan === null ? null : parseWifi(scan), wifi_enabled: radio === null ? null : radio.trim() === 'enabled' } }
    },
    async bluetooth(): Promise<Reply<BluetoothInfo>> {
      const adapter = list(sys('class', 'bluetooth')).some((n) => /^hci\d+$/.test(n))
      if (!adapter) return { ok: true, value: { adapter: false, powered: null, name: null, paired: null } }
      const show = await exec('bluetoothctl', ['show'])
      const paired = await exec('bluetoothctl', ['devices', 'Paired'])
      const powered = show === null ? null : /Powered: yes/.test(show)
      const name = show === null ? null : /\bAlias: (.+)/.exec(show)?.[1]?.trim() ?? null
      return { ok: true, value: { adapter, powered, name, paired: paired === null ? null : parseBtDevices(paired) } }
    },
    displays(): Reply<DisplayInfo> {
      const outputs = list(sys('class', 'drm')).filter((n) => /^card\d+-/.test(n))
        .filter((n) => (read(sys('class', 'drm', n, 'status')) ?? '').trim() === 'connected')
        .map((n) => {
          const name = n.replace(/^card\d+-/, '')
          return { name, built_in: /^(eDP|LVDS|DSI)/.test(name), mode: (read(sys('class', 'drm', n, 'modes')) ?? '').split('\n')[0].trim() || null }
        })
      const bl = list(sys('class', 'backlight'))[0]
      const cur = bl ? Number(read(sys('class', 'backlight', bl, 'brightness'))) : NaN
      const max = bl ? Number(read(sys('class', 'backlight', bl, 'max_brightness'))) : NaN
      return { ok: true, value: { outputs, brightness: max > 0 && Number.isFinite(cur) ? Math.round((cur / max) * 100) : null } }
    },
    async sound(): Promise<Reply<SoundInfo>> {
      const dev = async (id: string): Promise<SoundDevice | null> => {
        const v = parseVolume(await exec('wpctl', ['get-volume', id]))
        if (!v) return null
        const info = await exec('wpctl', ['inspect', id])
        return { ...v, name: /node\.description = "([^"]+)"/.exec(info ?? '')?.[1] ?? null }
      }
      const output = await dev('@DEFAULT_AUDIO_SINK@')
      const input = await dev('@DEFAULT_AUDIO_SOURCE@')
      if (!output && !input) return { ok: false, error: 'unavailable' }
      return { ok: true, value: { output, input } }
    },
  }
}

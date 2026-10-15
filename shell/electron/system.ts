// Settings → host bridge (WSOS-INT-001…006, WSOS-DSK-006). Each area reads real state through the stock CLI
// of its service (nmcli, bluetoothctl, wpctl, upower, lpstat, wlr-randr, udisksctl) with fixed argument arrays,
// never a shell. When the tool is missing or the service isn't running the answer is
// `{ available: false, reason }`, never invented values. The Wi-Fi password only goes to nmcli's stdin (--ask).
import { execFile, spawn } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

export type Avail<T> = { available: true; value: T } | { available: false; reason: string }
export type Exec = (cmd: string, args: string[]) => Promise<{ code: number; stdout: string; stderr: string; missing?: boolean }>
export type WithStdin = (cmd: string, args: string[], input: string) => Promise<{ code: number; stderr: string }>

export const realExec: Exec = (cmd, args) => new Promise((resolve) => {
  execFile(cmd, args, { timeout: 15_000, env: { ...process.env, LC_ALL: 'C' } }, (err, stdout, stderr) => {
    const missing = (err as NodeJS.ErrnoException | null)?.code === 'ENOENT'
    resolve({ code: err ? 1 : 0, stdout: String(stdout), stderr: String(stderr), missing })
  })
})

export const realWithStdin: WithStdin = (cmd, args, input) => new Promise((resolve) => {
  const child = spawn(cmd, args, { stdio: ['pipe', 'ignore', 'pipe'], env: { ...process.env, LC_ALL: 'C' } })
  let stderr = ''
  child.stderr.setEncoding('utf8')
  child.stderr.on('data', (c: string) => { stderr += c })
  child.on('error', () => resolve({ code: 1, stderr: 'spawn_failed' }))
  child.on('close', (code) => resolve({ code: code ?? 1, stderr }))
  child.stdin.end(input)
})

// ---------- types ----------
export interface WifiNetwork { ssid: string; signal: number; security: string; in_use: boolean }
export interface NetDevice { device: string; type: string; state: string; connection: string | null }
export interface NetworkState { wifi_enabled: boolean; devices: NetDevice[]; networks: WifiNetwork[] }
export interface BtDevice { address: string; name: string; connected: boolean }
export interface BluetoothState { powered: boolean; name: string | null; discoverable: boolean; paired: BtDevice[] }
export interface AudioDevice { id: number; name: string; is_default: boolean }
export interface SoundState { volume: number; muted: boolean; outputs: AudioDevice[]; inputs: AudioDevice[] }
export interface BatteryState { present: boolean; percentage: number | null; state: string; time_to_full_s: number | null; time_to_empty_s: number | null; on_battery: boolean }
export interface Printer { name: string; state: 'idle' | 'printing' | 'disabled' | 'unknown'; is_default: boolean }
export interface Display { name: string; description: string; enabled: boolean; width: number | null; height: number | null; refresh: number | null; scale: number | null }
export interface Drive { model: string; serial: string; device: string }

// ---------- parsers (pure) ----------
/** Splits one line of `nmcli -t` output on unescaped ':' and unescapes '\:' and '\\'. */
export function splitTerse(line: string): string[] {
  const out: string[] = []; let cur = ''
  for (let i = 0; i < line.length; i++) {
    const c = line[i]
    if (c === '\\' && i + 1 < line.length) { cur += line[++i]; continue }
    if (c === ':') { out.push(cur); cur = ''; continue }
    cur += c
  }
  out.push(cur)
  return out
}

/** `nmcli -t -f IN-USE,SSID,SIGNAL,SECURITY device wifi list`; hidden SSIDs dropped, strongest per SSID kept. */
export function parseWifiList(text: string): WifiNetwork[] {
  const by = new Map<string, WifiNetwork>()
  for (const line of text.split('\n')) {
    if (!line.trim()) continue
    const [inUse, ssid, signal, security] = splitTerse(line)
    if (!ssid) continue
    const n: WifiNetwork = { ssid, signal: Number(signal) || 0, security: security && security !== '--' ? security : '', in_use: inUse === '*' }
    const prev = by.get(ssid)
    if (!prev || n.in_use || (!prev.in_use && n.signal > prev.signal)) by.set(ssid, n)
  }
  return [...by.values()].sort((a, b) => Number(b.in_use) - Number(a.in_use) || b.signal - a.signal)
}

/** `nmcli -t -f DEVICE,TYPE,STATE,CONNECTION device`; loopback dropped. */
export function parseNmDevices(text: string): NetDevice[] {
  return text.split('\n').filter((l) => l.trim()).map(splitTerse)
    .filter(([, type]) => type !== 'loopback')
    .map(([device, type, state, connection]) => ({ device, type, state, connection: connection && connection !== '--' ? connection : null }))
}

/** `bluetoothctl show` → controller facts; null when no controller is listed. */
export function parseBtShow(text: string): Omit<BluetoothState, 'paired'> | null {
  if (!/^Controller /m.test(text)) return null
  const field = (k: string) => text.match(new RegExp(`^\\s*${k}:\\s*(.*)$`, 'm'))?.[1].trim() ?? null
  return { powered: field('Powered') === 'yes', name: field('Alias') ?? field('Name'), discoverable: field('Discoverable') === 'yes' }
}

/** `bluetoothctl devices [Paired|Connected]` → address/name pairs. */
export function parseBtDevices(text: string): { address: string; name: string }[] {
  const out: { address: string; name: string }[] = []
  for (const m of text.matchAll(/^Device ([0-9A-F]{2}(?::[0-9A-F]{2}){5}) ?(.*)$/gim)) out.push({ address: m[1].toUpperCase(), name: m[2].trim() || m[1] })
  return out
}

/** `wpctl get-volume @DEFAULT_AUDIO_SINK@` → "Volume: 0.60 [MUTED]". */
export function parseWpVolume(text: string): { volume: number; muted: boolean } | null {
  const m = text.match(/Volume:\s*([\d.]+)/)
  if (!m) return null
  return { volume: Math.round(Number(m[1]) * 100), muted: /\[MUTED\]/.test(text) }
}

/** Sinks and Sources of the Audio section of `wpctl status`. */
export function parseWpStatus(text: string): { outputs: AudioDevice[]; inputs: AudioDevice[] } {
  const outputs: AudioDevice[] = [], inputs: AudioDevice[] = []
  let section: 'audio' | 'other' = 'other'
  let list: AudioDevice[] | null = null
  for (const raw of text.split('\n')) {
    const line = raw.replace(/[│├└─]/g, ' ')
    if (/^\S/.test(line)) { section = /^Audio/.test(line) ? 'audio' : 'other'; list = null; continue }
    if (section !== 'audio') continue
    const head = line.trim()
    if (/^Sinks:$/.test(head)) { list = outputs; continue }
    if (/^Sources:$/.test(head)) { list = inputs; continue }
    if (/^[A-Za-z ]+:$/.test(head) || head === '') { list = null; continue }
    const m = head.match(/^(\*)?\s*(\d+)\.\s+(.*?)(?:\s+\[vol:[^\]]*\])?$/)
    if (list && m) list.push({ id: Number(m[2]), name: m[3].trim(), is_default: m[1] === '*' })
  }
  return { outputs, inputs }
}

function durationSeconds(v: string | undefined): number | null {
  const m = v?.match(/([\d.]+)\s*(second|minute|hour|day)/)
  if (!m) return null
  const unit = { second: 1, minute: 60, hour: 3600, day: 86400 }[m[2] as 'second']
  return Math.round(Number(m[1]) * unit)
}

/** `upower -i <battery path>`. */
export function parseUpowerBattery(text: string): BatteryState {
  const f = (k: string) => text.match(new RegExp(`^\\s*${k}:\\s*(.*)$`, 'm'))?.[1].trim()
  const pct = f('percentage')
  const state = f('state') ?? 'unknown'
  return {
    present: f('present') !== 'no' && pct !== undefined,
    percentage: pct ? Math.round(Number(pct.replace('%', ''))) : null,
    state,
    time_to_full_s: durationSeconds(f('time to full')),
    time_to_empty_s: durationSeconds(f('time to empty')),
    on_battery: state === 'discharging',
  }
}

/** `lpstat -p -d` → printers and the default destination. */
export function parseLpstat(text: string): Printer[] {
  const def = text.match(/^system default destination:\s*(\S+)/m)?.[1] ?? null
  const out: Printer[] = []
  for (const m of text.matchAll(/^printer (\S+) (?:is (idle)|(now printing)|(disabled))?/gm)) {
    out.push({ name: m[1], state: m[2] ? 'idle' : m[3] ? 'printing' : m[4] ? 'disabled' : 'unknown', is_default: m[1] === def })
  }
  return out
}

/** `wlr-randr --json`. */
export function parseWlrRandr(text: string): Display[] {
  let data: unknown
  try { data = JSON.parse(text) } catch { return [] }
  if (!Array.isArray(data)) return []
  return data.map((o: Record<string, unknown>) => {
    const modes = Array.isArray(o.modes) ? (o.modes as Record<string, unknown>[]) : []
    const cur = modes.find((m) => m.current) ?? null
    return {
      name: String(o.name ?? ''), description: String(o.description ?? o.model ?? ''), enabled: o.enabled !== false,
      width: cur ? Number(cur.width) : null, height: cur ? Number(cur.height) : null,
      refresh: cur ? Math.round(Number(cur.refresh) * 100) / 100 : null,
      scale: typeof o.scale === 'number' ? o.scale : null,
    }
  })
}

/** `udisksctl status`: fixed-width columns located from the header line. */
export function parseUdisksStatus(text: string): Drive[] {
  const lines = text.split('\n')
  const header = lines.findIndex((l) => /^MODEL\s+REVISION\s+SERIAL\s+DEVICE/.test(l))
  if (header < 0) return []
  const h = lines[header]
  const cols = ['REVISION', 'SERIAL', 'DEVICE'].map((c) => h.indexOf(c))
  return lines.slice(header + 1).filter((l) => l.trim() && !/^-+$/.test(l.trim())).map((l) => ({
    model: l.slice(0, cols[0]).trim(), serial: l.slice(cols[1], cols[2]).trim(), device: l.slice(cols[2]).trim(),
  })).filter((d) => d.device)
}

// ---------- VPN (WSOS-INT-001) ----------
/** NetworkManager uuid of the device agent's managed connection (services/device-agent/src/vpn.ts). */
export const MANAGED_VPN_UUID = '6f1d9a52-3c47-4b8e-9a0d-57e2c1b4f0a3'
export const AGENT_POLICY_PATH = '/run/worksuite-device-agent/policy.json'
export interface VpnConnection { name: string; uuid: string; type: 'wireguard' | 'vpn'; active: boolean; device: string | null; managed: boolean }
export interface VpnState { connections: VpnConnection[]; user_vpn_allowed: boolean; vpn_required: boolean }
/** What Settings shows before importing; the private key is checked but never returned. */
export interface WgConfSummary { addresses: string[]; dns: string[]; peers: { public_key: string; endpoint: string | null; allowed_ips: string[] }[]; full_tunnel: boolean }

const WG_KEY = /^[A-Za-z0-9+/]{42}[AEIMQUYcgkosw480]=$/
const CIDR = /^([0-9.]+|[0-9a-f:]+)(\/\d{1,3})?$/i
const NM_UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/**
 * wg-quick .conf → summary, or the reason it can't be imported. Rejects PostUp/PreUp/PostDown/PreDown (shell commands
 * that wg-quick would run as root; NetworkManager ignores them, so a file relying on them would silently misbehave).
 */
export function parseWgConf(text: string): { ok: true; value: WgConfSummary } | { ok: false; error: string } {
  if (text.length > 64 * 1024 || text.includes('\0')) return { ok: false, error: 'invalid_file' }
  let section: 'interface' | 'peer' | null = null
  let priv: string | null = null
  const addresses: string[] = [], dns: string[] = []
  const peers: WgConfSummary['peers'] = []
  let interfaces = 0
  const list = (v: string) => v.split(',').map((s) => s.trim()).filter(Boolean)
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.replace(/#.*$/, '').trim()
    if (!line) continue
    const sec = /^\[(\w+)\]$/.exec(line)
    if (sec) {
      const name = sec[1].toLowerCase()
      if (name === 'interface') { section = 'interface'; interfaces++ } else if (name === 'peer') { section = 'peer'; peers.push({ public_key: '', endpoint: null, allowed_ips: [] }) } else return { ok: false, error: 'invalid_file' }
      continue
    }
    const kv = /^([A-Za-z]+)\s*=\s*(.*)$/.exec(line)
    if (!kv || !section) return { ok: false, error: 'invalid_file' }
    const k = kv[1].toLowerCase(), v = kv[2].trim()
    if (/^(pre|post)(up|down)$/.test(k)) return { ok: false, error: 'scripts_not_supported' }
    if (section === 'interface') {
      if (k === 'privatekey') priv = v
      else if (k === 'address') addresses.push(...list(v))
      else if (k === 'dns') dns.push(...list(v))
    } else {
      const p = peers[peers.length - 1]
      if (k === 'publickey') p.public_key = v
      else if (k === 'endpoint') p.endpoint = v
      else if (k === 'allowedips') p.allowed_ips.push(...list(v))
    }
  }
  if (interfaces !== 1 || !priv || !WG_KEY.test(priv)) return { ok: false, error: 'missing_private_key' }
  if (!peers.length || peers.some((p) => !WG_KEY.test(p.public_key) || !p.allowed_ips.every((a) => CIDR.test(a)))) return { ok: false, error: 'invalid_peer' }
  if (!addresses.length || !addresses.every((a) => CIDR.test(a))) return { ok: false, error: 'invalid_address' }
  return { ok: true, value: { addresses, dns, peers, full_tunnel: peers.some((p) => p.allowed_ips.some((a) => a === '0.0.0.0/0' || a === '::/0')) } }
}

/** `nmcli -t -f NAME,UUID,TYPE,ACTIVE,DEVICE connection show`; VPN-type profiles only, managed one first. */
export function parseVpnConnections(text: string): VpnConnection[] {
  return text.split('\n').filter((l) => l.trim()).map(splitTerse)
    .filter(([, , type]) => type === 'wireguard' || type === 'vpn')
    .map(([name, uuid, type, active, device]) => ({
      name, uuid, type: type as 'wireguard' | 'vpn', active: active === 'yes', device: device && device !== '--' ? device : null, managed: uuid === MANAGED_VPN_UUID,
    }))
    .sort((a, b) => Number(b.managed) - Number(a.managed) || a.name.localeCompare(b.name))
}

/** Interface name NetworkManager derives from the import file name: [A-Za-z0-9_=+.-], at most 15 characters. */
export function wgInterfaceName(fileName: string): string {
  const base = fileName.replace(/\.conf$/i, '').replace(/[^A-Za-z0-9_=+.-]/g, '').slice(0, 15)
  return base && base !== '.' && base !== '..' ? base : 'wg-import'
}

/** Policy user_vpn=block (signed device policy, published read-only by the device agent). */
export function userVpnAllowed(policyJson: string | null): boolean {
  if (!policyJson) return true
  try { return (JSON.parse(policyJson) as { user_vpn?: string }).user_vpn !== 'block' } catch { return true }
}

/** Policy vpn_required: the managed VPN stays up; Settings offers no Disconnect for it. */
export function vpnRequired(policyJson: string | null): boolean {
  if (!policyJson) return false
  try { return (JSON.parse(policyJson) as { vpn_required?: boolean }).vpn_required === true } catch { return false }
}

export interface VpnDeps {
  readPolicy(): string | null
  /** Writes the validated text to a private (0700 dir, 0600 file) temp path named for nmcli; cleanup removes both. */
  stage(fileName: string, text: string): Promise<{ path: string; cleanup(): Promise<void> }>
}

export const realVpnDeps: VpnDeps = {
  readPolicy() { try { return readFileSync(AGENT_POLICY_PATH, 'utf8') } catch { return null } },
  async stage(fileName, text) {
    const dir = await mkdtemp(join(tmpdir(), 'ws-vpn-'))
    const path = join(dir, fileName)
    await writeFile(path, text, { mode: 0o600 })
    return { path, cleanup: () => rm(dir, { recursive: true, force: true }) }
  },
}

// ---------- bridge ----------
const SSID_MAX = 32
const BT_ADDR = /^[0-9A-F]{2}(:[0-9A-F]{2}){5}$/i

function unavailable(r: { missing?: boolean; stderr: string }, tool: string): { available: false; reason: string } {
  return { available: false, reason: r.missing ? `${tool}_missing` : 'service_unavailable' }
}

export function systemBridge(exec: Exec = realExec, withStdin: WithStdin = realWithStdin, vpnDeps: VpnDeps = realVpnDeps) {
  return {
    async network(): Promise<Avail<NetworkState>> {
      const radio = await exec('nmcli', ['-t', '-f', 'WIFI', 'radio'])
      if (radio.code !== 0) return unavailable(radio, 'nmcli')
      const [dev, list] = await Promise.all([
        exec('nmcli', ['-t', '-f', 'DEVICE,TYPE,STATE,CONNECTION', 'device']),
        exec('nmcli', ['-t', '-f', 'IN-USE,SSID,SIGNAL,SECURITY', 'device', 'wifi', 'list']),
      ])
      return { available: true, value: { wifi_enabled: radio.stdout.trim() === 'enabled', devices: parseNmDevices(dev.stdout), networks: list.code === 0 ? parseWifiList(list.stdout) : [] } }
    },
    async setWifi(on: boolean): Promise<Avail<true>> {
      const r = await exec('nmcli', ['radio', 'wifi', on ? 'on' : 'off'])
      return r.code === 0 ? { available: true, value: true } : unavailable(r, 'nmcli')
    },
    /** Password goes to nmcli's stdin (`--ask`), never argv. Empty password = open network. */
    async wifiConnect(ssid: string, password: string): Promise<{ ok: true } | { ok: false; error: string }> {
      if (!ssid || ssid.length > SSID_MAX || /[\0\n]/.test(ssid) || /[\0\n]/.test(password)) return { ok: false, error: 'invalid_argument' }
      const r = await withStdin('nmcli', ['--ask', '-w', '45', 'device', 'wifi', 'connect', ssid], password ? `${password}\n` : '\n')
      if (r.code === 0) return { ok: true }
      if (r.stderr === 'spawn_failed') return { ok: false, error: 'unavailable' }
      return { ok: false, error: /secrets were required|password|802-1x|psk/i.test(r.stderr) ? 'bad_password' : 'connect_failed' }
    },
    // VPN (WSOS-INT-001): the managed "WorkSuite VPN" comes from the device agent; users may import WireGuard .conf
    // files unless policy user_vpn=block. NetworkManager keeps the private key in its root-only keyfile.
    async vpn(): Promise<Avail<VpnState>> {
      const r = await exec('nmcli', ['-t', '-f', 'NAME,UUID,TYPE,ACTIVE,DEVICE', 'connection', 'show'])
      if (r.code !== 0) return unavailable(r, 'nmcli')
      const policy = vpnDeps.readPolicy()
      return { available: true, value: { connections: parseVpnConnections(r.stdout), user_vpn_allowed: userVpnAllowed(policy), vpn_required: vpnRequired(policy) } }
    },
    /** Validated .conf text (read by main from the user's file-dialog pick) → `nmcli connection import type wireguard`. */
    async vpnImport(fileName: string, text: string): Promise<{ ok: true; value: { uuid: string | null; name: string } } | { ok: false; error: string }> {
      if (!userVpnAllowed(vpnDeps.readPolicy())) return { ok: false, error: 'blocked_by_policy' }
      const parsed = parseWgConf(text)
      if (!parsed.ok) return parsed
      const name = wgInterfaceName(fileName)
      const staged = await vpnDeps.stage(`${name}.conf`, text)
      try {
        const r = await exec('nmcli', ['connection', 'import', 'type', 'wireguard', 'file', staged.path])
        if (r.code !== 0) return { ok: false, error: r.missing ? 'unavailable' : /exist/i.test(r.stderr) ? 'already_exists' : 'import_failed' }
        const uuid = /\(([0-9a-f-]{36})\)/i.exec(r.stdout)?.[1] ?? null
        // Imported profiles do not connect by themselves; the user chooses when.
        if (uuid) await exec('nmcli', ['connection', 'modify', 'uuid', uuid, 'connection.autoconnect', 'no'])
        return { ok: true, value: { uuid, name } }
      } finally {
        await staged.cleanup()
      }
    },
    async vpnConnect(uuid: string, on: boolean): Promise<Avail<true>> {
      if (!NM_UUID.test(uuid)) return { available: false, reason: 'invalid_argument' }
      if (!on && uuid === MANAGED_VPN_UUID && vpnRequired(vpnDeps.readPolicy())) return { available: false, reason: 'required_by_organization' }
      const r = await exec('nmcli', on ? ['--wait', '30', 'connection', 'up', 'uuid', uuid] : ['connection', 'down', 'uuid', uuid])
      return r.code === 0 ? { available: true, value: true } : unavailable(r, 'nmcli')
    },
    /** The managed connection belongs to the organization; only the device agent removes it. */
    async vpnRemove(uuid: string): Promise<Avail<true>> {
      if (!NM_UUID.test(uuid)) return { available: false, reason: 'invalid_argument' }
      if (uuid === MANAGED_VPN_UUID) return { available: false, reason: 'managed_by_organization' }
      const list = await exec('nmcli', ['-t', '-f', 'NAME,UUID,TYPE,ACTIVE,DEVICE', 'connection', 'show'])
      if (!parseVpnConnections(list.stdout).some((c) => c.uuid === uuid)) return { available: false, reason: 'not_a_vpn' }
      const r = await exec('nmcli', ['connection', 'delete', 'uuid', uuid])
      return r.code === 0 ? { available: true, value: true } : unavailable(r, 'nmcli')
    },
    async bluetooth(): Promise<Avail<BluetoothState>> {
      const show = await exec('bluetoothctl', ['show'])
      if (show.code !== 0) return unavailable(show, 'bluetoothctl')
      const ctl = parseBtShow(show.stdout)
      if (!ctl) return { available: false, reason: 'no_adapter' }
      const [paired, connected] = await Promise.all([exec('bluetoothctl', ['devices', 'Paired']), exec('bluetoothctl', ['devices', 'Connected'])])
      const conn = new Set(parseBtDevices(connected.stdout).map((d) => d.address))
      return { available: true, value: { ...ctl, paired: parseBtDevices(paired.stdout).map((d) => ({ ...d, connected: conn.has(d.address) })) } }
    },
    async setBluetooth(on: boolean): Promise<Avail<true>> {
      const r = await exec('bluetoothctl', ['power', on ? 'on' : 'off'])
      return r.code === 0 ? { available: true, value: true } : unavailable(r, 'bluetoothctl')
    },
    async btConnect(address: string, on: boolean): Promise<Avail<true>> {
      if (!BT_ADDR.test(address)) return { available: false, reason: 'invalid_argument' }
      const r = await exec('bluetoothctl', [on ? 'connect' : 'disconnect', address])
      return r.code === 0 ? { available: true, value: true } : unavailable(r, 'bluetoothctl')
    },
    async sound(): Promise<Avail<SoundState>> {
      const vol = await exec('wpctl', ['get-volume', '@DEFAULT_AUDIO_SINK@'])
      const v = vol.code === 0 ? parseWpVolume(vol.stdout) : null
      if (!v) return unavailable(vol, 'wpctl')
      const st = await exec('wpctl', ['status'])
      return { available: true, value: { ...v, ...parseWpStatus(st.stdout) } }
    },
    async setVolume(percent: number): Promise<Avail<true>> {
      const p = Math.max(0, Math.min(100, Math.round(Number(percent) || 0)))
      const r = await exec('wpctl', ['set-volume', '@DEFAULT_AUDIO_SINK@', `${p}%`])
      return r.code === 0 ? { available: true, value: true } : unavailable(r, 'wpctl')
    },
    async setMute(muted: boolean): Promise<Avail<true>> {
      const r = await exec('wpctl', ['set-mute', '@DEFAULT_AUDIO_SINK@', muted ? '1' : '0'])
      return r.code === 0 ? { available: true, value: true } : unavailable(r, 'wpctl')
    },
    async setDefaultAudio(id: number): Promise<Avail<true>> {
      if (!Number.isInteger(id) || id < 0) return { available: false, reason: 'invalid_argument' }
      const r = await exec('wpctl', ['set-default', String(id)])
      return r.code === 0 ? { available: true, value: true } : unavailable(r, 'wpctl')
    },
    async battery(): Promise<Avail<BatteryState>> {
      const e = await exec('upower', ['-e'])
      if (e.code !== 0) return unavailable(e, 'upower')
      const bat = e.stdout.split('\n').map((s) => s.trim()).find((p) => /\/battery_/.test(p))
      if (!bat) return { available: false, reason: 'no_battery' }
      const i = await exec('upower', ['-i', bat])
      return i.code === 0 ? { available: true, value: parseUpowerBattery(i.stdout) } : unavailable(i, 'upower')
    },
    async printers(): Promise<Avail<Printer[]>> {
      const r = await exec('lpstat', ['-p', '-d'])
      // lpstat exits non-zero with "No destinations added." when CUPS runs but has no printers.
      if (r.code !== 0 && /no destinations/i.test(r.stdout + r.stderr)) return { available: true, value: [] }
      return r.code === 0 ? { available: true, value: parseLpstat(r.stdout) } : unavailable(r, 'lpstat')
    },
    async displays(): Promise<Avail<Display[]>> {
      const r = await exec('wlr-randr', ['--json'])
      return r.code === 0 ? { available: true, value: parseWlrRandr(r.stdout) } : unavailable(r, 'wlr-randr')
    },
    async disks(): Promise<Avail<Drive[]>> {
      const r = await exec('udisksctl', ['status'])
      return r.code === 0 ? { available: true, value: parseUdisksStatus(r.stdout) } : unavailable(r, 'udisksctl')
    },
  }
}

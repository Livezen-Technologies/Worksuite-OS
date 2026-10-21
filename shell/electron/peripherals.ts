// Settings → peripherals beyond system.ts: Bluetooth pairing (WSOS-INT-003), removable storage (WSOS-INT-004),
// power profiles and inhibitors (WSOS-INT-005), adding printers and their queues (WSOS-INT-006), input methods
// (WSOS-INT-011). Same rules as system.ts: stock CLIs with fixed argument arrays, never a shell; a missing tool or
// stopped service answers `{ available: false, reason }`; a LUKS passphrase only goes to udisksctl on stdin.
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { realExec, realWithStdin, type Avail, type Exec, type WithStdin } from './system'
import { parseBtDevices } from './system'
import { xdgDirs } from './xdgDirs'
import { printerExec, printersBridge } from './printers'

// ---------- Bluetooth ----------
export interface BtFound { address: string; name: string }
const BT_ADDR = /^[0-9A-F]{2}(:[0-9A-F]{2}){5}$/i

/** Devices seen by a scan that are not paired yet. bluetoothctl names unnamed devices by their address (dashes). */
export function newDevices(all: string, paired: string): BtFound[] {
  const have = new Set(parseBtDevices(paired).map((d) => d.address))
  return parseBtDevices(all).filter((d) => !have.has(d.address)).map((d) => ({ address: d.address, name: d.name.replace(/-/g, ':') === d.address ? '' : d.name }))
}

/** bluetoothctl output → a reason the UI can explain. */
export function btError(text: string): string {
  if (/AuthenticationFailed|AuthenticationRejected|AuthenticationCanceled/i.test(text)) return 'bt_auth_failed'
  if (/ConnectionAttemptFailed|page-timeout|not available/i.test(text)) return 'bt_unreachable'
  if (/AlreadyExists/i.test(text)) return 'bt_already_paired'
  if (/not ready|NotReady/i.test(text)) return 'bt_off'
  return 'bt_failed'
}

// ---------- removable storage ----------
export interface Volume {
  device: string; disk: string; label: string; size: string; fstype: string
  mountpoint: string | null; encrypted: boolean; unlocked: string | null
}
interface LsblkNode { name?: string; path?: string; size?: string; label?: string | null; fstype?: string | null; mountpoint?: string | null; mountpoints?: (string | null)[]; rm?: boolean | string; hotplug?: boolean | string; type?: string; tran?: string | null; children?: LsblkNode[] }
const truthy = (v: unknown) => v === true || v === '1' || v === 1
const DEV = /^\/dev\/[A-Za-z0-9._/-]{1,64}$/

/** `lsblk -J -o PATH,SIZE,LABEL,FSTYPE,MOUNTPOINT,RM,HOTPLUG,TYPE,TRAN` → removable volumes (partitions or whole-disk filesystems). */
export function parseLsblk(json: string): Volume[] {
  let doc: { blockdevices?: LsblkNode[] }
  try { doc = JSON.parse(json) } catch { return [] }
  const out: Volume[] = []
  const mp = (n: LsblkNode) => n.mountpoint ?? n.mountpoints?.find((m) => !!m) ?? null
  for (const disk of doc.blockdevices ?? []) {
    if (disk.type !== 'disk' || !(truthy(disk.rm) || truthy(disk.hotplug) || disk.tran === 'usb')) continue
    const parts = disk.children?.length ? disk.children : disk.fstype ? [disk] : []
    for (const p of parts) {
      if (!p.path || !p.fstype) continue
      const encrypted = p.fstype === 'crypto_LUKS'
      const clear = encrypted ? p.children?.find((c) => c.type === 'crypt') ?? null : null
      out.push({
        device: p.path, disk: disk.path ?? '', label: (clear?.label ?? p.label) || '', size: p.size ?? '', fstype: clear?.fstype ?? p.fstype,
        mountpoint: clear ? mp(clear) : mp(p), encrypted, unlocked: clear?.path ?? null,
      })
    }
  }
  return out
}

/** udisksctl stderr → a clear message key (WSOS-INT-004 "clear error messages"). */
export function udisksError(text: string): string {
  if (/target is busy|DeviceBusy/i.test(text)) return 'storage_busy'
  if (/NotAuthorized|not authorized/i.test(text)) return 'not_authorized'
  if (/wrong passphrase|incorrect passphrase|Failed to activate device|No key available/i.test(text)) return 'bad_passphrase'
  if (/unknown filesystem|wrong fs type|NotSupported|Error mounting/i.test(text)) return 'storage_unreadable'
  if (/NotMounted|not mounted/i.test(text)) return 'storage_not_mounted'
  return 'storage_failed'
}

/** "Mounted /dev/sdb1 at /media/u/USB." → mount point. */
export function mountedAt(text: string): string | null {
  return /\bat (\/\S+?)\.?\s*$/m.exec(text.trim())?.[1] ?? null
}

// ---------- power ----------
export interface PowerProfiles { active: string; profiles: string[]; degraded: string | null }
export interface Inhibitor { what: string; who: string; why: string; mode: string }

/** `powerprofilesctl list`: "* balanced:" marks the active one; "Degraded: yes (lap-detected)" under performance. */
export function parsePowerProfiles(text: string): PowerProfiles | null {
  const profiles: string[] = []; let active = ''; let degraded: string | null = null
  for (const line of text.split('\n')) {
    const m = /^(\*)?\s*([a-z-]+):\s*$/.exec(line)
    if (m) { profiles.push(m[2]); if (m[1]) active = m[2]; continue }
    const d = /^\s*Degraded:\s*yes\s*\(([^)]*)\)/.exec(line)
    if (d) degraded = d[1]
  }
  return profiles.length && active ? { active, profiles, degraded } : null
}

/** `busctl --json=short call … ListInhibitors` → a(ssssuu) = what, who, why, mode, uid, pid. */
export function parseInhibitors(json: string): Inhibitor[] {
  try {
    const d = JSON.parse(json) as { data?: unknown[] }
    const rows = (d.data?.[0] ?? []) as unknown[][]
    return rows.filter((r) => Array.isArray(r) && r.length >= 4).map((r) => ({ what: String(r[0]), who: String(r[1]), why: String(r[2]), mode: String(r[3]) }))
  } catch { return [] }
}

// ---------- printing ----------
// Printing lives in printers.ts; the parsers are re-exported here for the callers that import them from this module.
export { cupsError, parseJobs, parseLpinfo, parsePrinterIssues, printerUri, queueName, type FoundPrinter, type PrintJob, type PrinterIssue } from './printers'

// ---------- input methods (fcitx5) ----------
/** Input methods Settings offers. Ids are fcitx5 names (fcitx5-m17n for Sinhala and Tamil). */
export const INPUT_METHODS = ['keyboard-us', 'm17n_si_wijesekera', 'm17n_si_singlish', 'm17n_ta_tamil99', 'm17n_ta_phonetic'] as const
export type InputMethodId = (typeof INPUT_METHODS)[number]
const isIm = (s: string): s is InputMethodId => (INPUT_METHODS as readonly string[]).includes(s)

/** Enabled methods from a fcitx5 profile (Groups/0/Items/N Name=…), in order. */
/** Earlier images named the Sinhala keyboard m17n_si_wijesekara; m17n-db's file is si-wijesekera.mim, so fcitx5 never loaded it. */
const RENAMED_IMS: Record<string, string> = { m17n_si_wijesekara: 'm17n_si_wijesekera' }

export function parseFcitxProfile(text: string): string[] {
  const out: string[] = []; let inItem = false
  for (const raw of text.split('\n')) {
    const line = raw.trim()
    if (line.startsWith('[')) { inItem = /^\[Groups\/0\/Items\/\d+\]$/.test(line); continue }
    const m = /^Name=(.+)$/.exec(line)
    if (inItem && m) { const n = m[1].trim(); out.push(RENAMED_IMS[n] ?? n) }
  }
  return out
}

/** A fcitx5 profile with one group; the first method is the default layout. */
export function renderFcitxProfile(methods: string[], layout = 'us'): string {
  const ims = methods.filter(isIm)
  if (!ims.includes('keyboard-us')) ims.unshift('keyboard-us')
  const lines = ['[Groups/0]', 'Name=Default', `Default Layout=${layout}`, `DefaultIM=${ims[ims.length > 1 ? 1 : 0]}`, '']
  ims.forEach((id, i) => lines.push(`[Groups/0/Items/${i}]`, `Name=${id}`, 'Layout=', ''))
  lines.push('[GroupOrder]', '0=Default', '')
  return lines.join('\n')
}

export interface InputState { enabled: string[]; available: InputMethodId[] }
/** The taskbar switcher (#58): running = fcitx5 answers; current = its active method (null when not running). */
export interface ImStatus { running: boolean; current: string | null; enabled: string[] }
/** The session's fcitx5 (services/session/systemd/user/worksuite-input-method.service). */
export const IM_SERVICE = 'worksuite-input-method.service'
const IM_NAME = /^[A-Za-z0-9_-]{1,64}$/
const pause = (ms: number) => new Promise((r) => setTimeout(r, ms))

// ---------- screen capture indicator (WSOS-INT-013) ----------
/** `pw-dump` → running screen-capture streams from xdg-desktop-portal-wlr (node.name xdpw_stream…). */
export const SCREENCAST_STOP = '/usr/lib/worksuite/worksuite-screencast-stop'

export function activeCaptures(json: string): number {
  try {
    const objs = JSON.parse(json) as { type?: string; info?: { state?: string; props?: Record<string, unknown> } }[]
    return objs.filter((o) => o.type === 'PipeWire:Interface:Node' && String(o.info?.props?.['node.name'] ?? '').startsWith('xdpw_stream')
      && o.info?.props?.['media.class'] === 'Video/Source' && (o.info?.state === 'running' || o.info?.state === 'idle')).length
  } catch { return 0 }
}

// ---------- bridge ----------
const ok = <T>(value: T): Avail<T> => ({ available: true, value })
const fail = (reason: string): { available: false; reason: string } => ({ available: false, reason })
const tool = (r: { missing?: boolean }, name: string, reason: string) => fail(r.missing ? `${name}_missing` : reason)

export interface FsDeps { read(p: string): Promise<string | null>; write(p: string, s: string): Promise<void> }
const realFs: FsDeps = {
  async read(p) { try { return await readFile(p, 'utf8') } catch { return null } },
  async write(p, s) { await mkdir(dirname(p), { recursive: true }); await writeFile(p, s, { mode: 0o644 }) },
}

export function peripheralsBridge(home: string, exec: Exec = realExec, withStdin: WithStdin = realWithStdin, fs: FsDeps = realFs, wait: (ms: number) => Promise<unknown> = pause) {
  const userProfile = join(xdgDirs(home).config, 'fcitx5', 'profile')
  // pkexec's exit status matters for printing, which realExec flattens to 1.
  const printers = printersBridge(exec === realExec ? printerExec : exec)
  const enabledIms = async () => {
    const text = (await fs.read(userProfile)) ?? (await fs.read('/etc/xdg/fcitx5/profile'))
    return text ? parseFcitxProfile(text) : ['keyboard-us']
  }
  /** `fcitx5-remote -n`: the active method's name; exit 1 and no output while fcitx5 is not running. */
  const currentIm = async () => {
    const r = await exec('fcitx5-remote', ['-n'])
    const name = r.stdout.trim()
    return { missing: !!r.missing, name: r.code === 0 && IM_NAME.test(name) ? name : null }
  }
  return {
    // Bluetooth (WSOS-INT-003)
    async btScan(): Promise<Avail<BtFound[]>> {
      const s = await exec('bluetoothctl', ['--timeout', '8', 'scan', 'on'])
      if (s.missing) return fail('bluetoothctl_missing')
      const [all, paired] = await Promise.all([exec('bluetoothctl', ['devices']), exec('bluetoothctl', ['devices', 'Paired'])])
      return all.code === 0 ? ok(newDevices(all.stdout, paired.stdout)) : tool(all, 'bluetoothctl', 'service_unavailable')
    },
    /** Pair (just-works / confirmation handled by a NoInputNoOutput agent), then trust and connect. */
    async btPair(address: string): Promise<Avail<true>> {
      if (!BT_ADDR.test(address)) return fail('invalid_argument')
      const p = await exec('bluetoothctl', ['--agent', 'NoInputNoOutput', '--timeout', '30', 'pair', address])
      if (p.code !== 0 || /Failed to pair|org\.bluez\.Error/i.test(p.stdout + p.stderr)) return tool(p, 'bluetoothctl', btError(p.stdout + p.stderr))
      const t = await exec('bluetoothctl', ['trust', address])
      if (t.code !== 0) return fail(btError(t.stdout + t.stderr))
      await exec('bluetoothctl', ['connect', address])
      return ok(true)
    },
    async btRemove(address: string): Promise<Avail<true>> {
      if (!BT_ADDR.test(address)) return fail('invalid_argument')
      const r = await exec('bluetoothctl', ['remove', address])
      return r.code === 0 ? ok(true) : tool(r, 'bluetoothctl', btError(r.stdout + r.stderr))
    },

    // Removable storage (WSOS-INT-004)
    async volumes(): Promise<Avail<Volume[]>> {
      const r = await exec('lsblk', ['-J', '-o', 'NAME,PATH,SIZE,LABEL,FSTYPE,MOUNTPOINT,RM,HOTPLUG,TYPE,TRAN'])
      return r.code === 0 ? ok(parseLsblk(r.stdout)) : tool(r, 'lsblk', 'service_unavailable')
    },
    async mount(device: string): Promise<Avail<string>> {
      if (!DEV.test(device)) return fail('invalid_argument')
      const r = await exec('udisksctl', ['mount', '--no-user-interaction', '-b', device])
      return r.code === 0 ? ok(mountedAt(r.stdout) ?? '') : tool(r, 'udisksctl', udisksError(r.stderr + r.stdout))
    },
    /** Unlock a LUKS USB drive (passphrase on stdin, never argv), then mount the cleartext device. */
    async unlock(device: string, passphrase: string): Promise<Avail<string>> {
      if (!DEV.test(device) || !passphrase || passphrase.length > 1024) return fail('invalid_argument')
      const u = await withStdin('udisksctl', ['unlock', '--no-user-interaction', '-b', device, '--key-file', '/dev/stdin'], passphrase)
      if (u.code !== 0) return fail(udisksError(u.stderr))
      const vols = await this.volumes()
      const clear = vols.available ? vols.value.find((v) => v.device === device)?.unlocked : null
      return clear ? this.mount(clear) : ok('')
    },
    /** Safe eject: unmount, lock if encrypted, then power the drive off. */
    async eject(device: string): Promise<Avail<true>> {
      if (!DEV.test(device)) return fail('invalid_argument')
      const vols = await this.volumes()
      if (!vols.available) return vols
      const v = vols.value.find((x) => x.device === device)
      if (!v) return fail('storage_gone')
      for (const other of vols.value.filter((x) => x.disk === v.disk)) {
        if (other.mountpoint) {
          const r = await exec('udisksctl', ['unmount', '--no-user-interaction', '-b', other.unlocked ?? other.device])
          if (r.code !== 0) return tool(r, 'udisksctl', udisksError(r.stderr + r.stdout))
        }
        if (other.unlocked) {
          const r = await exec('udisksctl', ['lock', '--no-user-interaction', '-b', other.device])
          if (r.code !== 0) return tool(r, 'udisksctl', udisksError(r.stderr + r.stdout))
        }
      }
      if (!DEV.test(v.disk)) return ok(true)
      const p = await exec('udisksctl', ['power-off', '--no-user-interaction', '-b', v.disk])
      return p.code === 0 ? ok(true) : tool(p, 'udisksctl', udisksError(p.stderr + p.stdout))
    },

    // Power (WSOS-INT-005)
    async powerProfiles(): Promise<Avail<PowerProfiles>> {
      const r = await exec('powerprofilesctl', ['list'])
      const p = r.code === 0 ? parsePowerProfiles(r.stdout) : null
      return p ? ok(p) : tool(r, 'powerprofilesctl', 'service_unavailable')
    },
    async setPowerProfile(name: string): Promise<Avail<true>> {
      if (!['power-saver', 'balanced', 'performance'].includes(name)) return fail('invalid_argument')
      const r = await exec('powerprofilesctl', ['set', name])
      return r.code === 0 ? ok(true) : tool(r, 'powerprofilesctl', 'service_unavailable')
    },
    async inhibitors(): Promise<Avail<Inhibitor[]>> {
      const r = await exec('busctl', ['--json=short', 'call', 'org.freedesktop.login1', '/org/freedesktop/login1', 'org.freedesktop.login1.Manager', 'ListInhibitors'])
      return r.code === 0 ? ok(parseInhibitors(r.stdout)) : tool(r, 'busctl', 'service_unavailable')
    },

    // Printing (WSOS-INT-006): see printers.ts.
    findPrinters: () => printers.findPrinters(),
    addPrinter: (uri: string, display: string, driver?: string) => printers.addPrinter(uri, display, driver),
    removePrinter: (name: string) => printers.removePrinter(name),
    printQueue: () => printers.printQueue(),
    cancelJob: (id: string) => printers.cancelJob(id),

    async screenCapture(): Promise<Avail<number>> {
      const r = await exec('pw-dump', [])
      return r.code === 0 ? ok(activeCaptures(r.stdout)) : tool(r, 'pw-dump', 'service_unavailable')
    },
    /** Emergency stop (SRS §7.1): destroys every xdpw stream and restarts xdpw, closing all ScreenCast sessions. */
    async stopScreenCapture(): Promise<Avail<number>> {
      const r = await exec(SCREENCAST_STOP, [])
      if (r.code !== 0) return tool(r, 'worksuite-screencast-stop', 'failed')
      const n = Number.parseInt(r.stdout.trim(), 10)
      return ok(Number.isFinite(n) ? n : 0)
    },

    // Input methods (WSOS-INT-011)
    async inputMethods(): Promise<Avail<InputState>> {
      return ok({ enabled: await enabledIms(), available: [...INPUT_METHODS] })
    },
    /** Taskbar indicator (#58): the enabled methods and the one fcitx5 has active. */
    async imStatus(): Promise<Avail<ImStatus>> {
      const [enabled, cur] = await Promise.all([enabledIms(), currentIm()])
      if (cur.missing) return fail('fcitx5_missing')
      return ok({ running: cur.name !== null, current: cur.name, enabled })
    },
    /**
     * Taskbar switcher (#58): make `id` the active method now, no restart. fcitx5 not running (the tester's laptop: the
     * click did nothing) → start the session's fcitx5 service and try again. The switch is global because
     * /etc/xdg/fcitx5/config shares the input state between windows (ShareInputState=All); otherwise the method chosen
     * from the taskbar applied only to the taskbar and the app went back to English. The answer is what fcitx5 reports
     * afterwards, not what was asked.
     */
    async setCurrentIm(id: string): Promise<Avail<string>> {
      if (!isIm(id)) return fail('invalid_argument')
      if (!(await enabledIms()).includes(id)) return fail('im_not_enabled')
      let cur = await currentIm()
      if (cur.missing) return fail('fcitx5_missing')
      if (cur.name === null) {
        const st = await exec('systemctl', ['--user', 'start', IM_SERVICE])
        if (st.code !== 0) return fail('im_not_running')
        for (let i = 0; i < 10 && cur.name === null; i++) { await wait(300); cur = await currentIm() }
        if (cur.name === null) return fail('im_not_running')
      }
      if (cur.name === id) return ok(id)
      // `-s` activates the method; Ctrl+Space keeps toggling between the keyboard and it.
      const s = await exec('fcitx5-remote', ['-s', id])
      if (s.code !== 0) return fail('im_failed')
      const after = await currentIm()
      return after.name === id ? ok(id) : fail('im_not_applied')
    },
    async setInputMethods(ids: string[]): Promise<Avail<true>> {
      if (!ids.every(isIm)) return fail('invalid_argument')
      await fs.write(userProfile, renderFcitxProfile(ids))
      // Running fcitx5 re-reads its configuration; when it isn't running the profile applies at next sign-in.
      await exec('fcitx5-remote', ['-r'])
      return ok(true)
    },
  }
}
export type PeripheralsBridge = ReturnType<typeof peripheralsBridge>

type Handle = (channel: string, fn: (...args: string[]) => unknown) => void
/** IPC for the bridge above, registered from main.ts through its sender-checked `handle`. */
export function startPeripheralsHost(handle: Handle, home: string, b: PeripheralsBridge = peripheralsBridge(home)) {
  handle('ws:btScan', () => b.btScan())
  handle('ws:btPair', (a) => b.btPair(a))
  handle('ws:btRemove', (a) => b.btRemove(a))
  handle('ws:volumes', () => b.volumes())
  handle('ws:volMount', (d) => b.mount(d))
  handle('ws:volUnlock', (d, p) => b.unlock(d, p))
  handle('ws:volEject', (d) => b.eject(d))
  handle('ws:powerProfiles', () => b.powerProfiles())
  handle('ws:setPowerProfile', (n) => b.setPowerProfile(n))
  handle('ws:powerInhibitors', () => b.inhibitors())   // 'ws:inhibitors' is the session-end overlay's (sessionHost.ts)
  handle('ws:findPrinters', () => b.findPrinters())
  handle('ws:addPrinter', (u, n, d) => b.addPrinter(u, n, d || 'everywhere'))
  handle('ws:removePrinter', (n) => b.removePrinter(n))
  handle('ws:printQueue', () => b.printQueue())
  handle('ws:cancelJob', (id) => b.cancelJob(id))
  handle('ws:screenCapture', () => b.screenCapture())
  handle('ws:stopScreenCapture', () => b.stopScreenCapture())
  handle('ws:inputMethods', () => b.inputMethods())
  handle('ws:setInputMethods', (...ids) => b.setInputMethods(ids))
  handle('ws:imStatus', () => b.imStatus())
  handle('ws:setCurrentIm', (id) => b.setCurrentIm(id))
}

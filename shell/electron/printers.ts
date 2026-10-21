// Settings › Printers (WSOS-INT-006, issue #51): printers and their state, adding them (network, IPP, IP address, USB)
// with driver detection, removing them, the default printer, per-user preferences, the queue, pausing and test pages.
// Stock CUPS tools with fixed argument arrays, never a shell.
//
// On a real machine the administrative calls (lpinfo -v, lpadmin, cupsenable/cupsdisable) are CUPS-Get-Devices /
// CUPS-Add-Modify-Printer requests that cupsd only allows the SystemGroup (lpadmin) to make. The live user and
// directory accounts are not in that group, so they got "Forbidden" and nothing could be added. These calls now run
// directly first (no prompt for members of lpadmin), and on "Forbidden" through pkexec worksuite-printer-admin
// (polkit lk.worksuite.printers: lpadmin/sudo members without a password, anyone else after an administrator says yes).
// Per-user settings (default printer, preferences) are lpoptions in ~/.cups and need no administrator.
import { execFile } from 'node:child_process'
import type { Avail, Exec } from './system'

export const PRINTER_ADMIN = '/usr/lib/worksuite/worksuite-printer-admin'
export const TEST_PAGE = '/usr/share/cups/data/testprint'

/** Exec with the real exit status (pkexec reports a dismissed prompt as 126, refused as 127) and time for lpinfo. */
export const printerExec: Exec = (cmd, args) => new Promise((resolve) => {
  execFile(cmd, args, { timeout: 60_000, env: { ...process.env, LC_ALL: 'C' } }, (err, stdout, stderr) => {
    const e = err as (NodeJS.ErrnoException & { code?: unknown }) | null
    const missing = e?.code === 'ENOENT'
    resolve({ code: !e ? 0 : typeof e.code === 'number' ? e.code : 1, stdout: String(stdout), stderr: String(stderr), missing })
  })
})

// ---------- types ----------
export interface FoundPrinter { uri: string; name: string; makeModel?: string; deviceId?: string; kind?: 'network' | 'usb' }
export interface PrintJob { id: string; printer: string; user: string; size: string; held?: boolean }
export interface PrinterIssue { name: string; reason: string }
export interface PrinterInfo {
  name: string; description: string; location: string; uri: string
  state: 'idle' | 'printing' | 'paused' | 'unknown'; message: string | null; isDefault: boolean
}
export interface PrinterDriver { id: string; label: string; recommended: boolean }
export interface PrinterOption { key: string; label: string; choices: string[]; current: string }
export interface PrinterPrefs { options: PrinterOption[]; orientation: string; copies: number }

/** Option keys Settings lets people change: paper, colour, two-sided, quality (and the tray and paper type). */
export const PREF_KEYS = ['PageSize', 'ColorModel', 'Duplex', 'cupsPrintQuality', 'OutputMode', 'print-color-mode', 'InputSlot', 'MediaType'] as const
const ORIENTATIONS = ['3', '4', '5', '6']   // portrait, landscape, reverse landscape, reverse portrait (RFC 8011)

const NAME = /^[A-Za-z0-9_-]{1,127}$/
const JOB = /^[A-Za-z0-9_-]{1,127}-\d{1,9}$/

// ---------- parsing ----------
/** `lpinfo -v` / `lpinfo -l -v` → printers CUPS can reach (network, IPP, dnssd and USB devices). */
export function parseLpinfo(text: string): FoundPrinter[] {
  const out: FoundPrinter[] = []
  const push = (p: FoundPrinter) => { if (printerUri(p.uri) && !out.some((x) => x.uri === p.uri)) out.push(p) }
  if (/^Device:/m.test(text)) {
    // Long form: "Device: uri = …" then indented "class = …", "info = …", "make-and-model = …", "device-id = …".
    for (const block of text.split(/^Device:\s*/m).slice(1)) {
      const f: Record<string, string> = {}
      for (const l of block.split('\n')) { const m = /^\s*([\w-]+)\s*=\s*(.*)$/.exec(l); if (m) f[m[1]] = m[2].trim() }
      if (!f.uri || !/^\w+:\/\//.test(f.uri)) continue
      const kind = f.uri.startsWith('usb:') || f.class === 'direct' ? 'usb' : 'network'
      const mm = f['make-and-model'] && f['make-and-model'] !== 'Unknown' ? f['make-and-model'] : undefined
      push({ uri: f.uri, name: f.info && f.info !== 'Unknown' ? f.info : mm ?? nameFromUri(f.uri), makeModel: mm, deviceId: f['device-id'] || undefined, kind })
    }
    return out
  }
  for (const line of text.split('\n')) {
    const m = /^\s*(network|direct)\s+(\w+:\/\/\S+)\s*$/.exec(line)
    if (m) push({ uri: m[2], name: nameFromUri(m[2]), kind: m[1] === 'direct' ? 'usb' : 'network' })
  }
  return out
}

function nameFromUri(uri: string): string {
  try {
    const u = new URL(uri)
    if (u.protocol === 'usb:') return decodeURIComponent(`${u.hostname} ${u.pathname.replace(/^\//, '')}`).trim()
    return decodeURIComponent(u.hostname.split('._')[0] || u.hostname) || uri
  } catch { return uri }
}

/** Queue name from a display name: letters, digits, '_' and '-' only (CUPS rejects '/', '#', spaces). */
export function queueName(display: string): string {
  return display.normalize('NFKD').replace(/[^A-Za-z0-9_-]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 64) || 'Printer'
}

/** A printer address the user typed or picked: IPP (ipp, ipps, dnssd), JetDirect (socket), LPD or a USB device. */
export function printerUri(uri: string): string | null {
  if (uri.length > 512 || /[\s\0-\x1f]/.test(uri)) return null
  try {
    const u = new URL(uri)
    return ['ipp:', 'ipps:', 'dnssd:', 'socket:', 'lpd:', 'usb:'].includes(u.protocol) && u.hostname && !u.username && !u.password ? uri : null
  } catch { return null }
}

/** Whether CUPS can drive the printer without a driver: IPP Everywhere / AirPrint, IPP-over-USB through ipp-usb. */
export const driverless = (uri: string) => /^(ipps?|dnssd):\/\//.test(uri)

/** A PPD/driver name lpinfo -m printed: no option-like or path-escaping values. */
export function driverId(id: string): string | null {
  return id === 'everywhere' || (/^[A-Za-z0-9_.:/+@,=-]{1,255}$/.test(id) && !id.startsWith('-') && !id.includes('..')) ? id : null
}

/** `lpinfo -m` → drivers ("drv:///hpcups.drv/hp-laserjet_m110.ppd HP LaserJet m110, hpcups 3.25"). */
export function parseDrivers(text: string, uri: string): PrinterDriver[] {
  const out: PrinterDriver[] = []
  if (driverless(uri)) out.push({ id: 'everywhere', label: 'IPP Everywhere', recommended: true })
  for (const line of text.split('\n')) {
    const m = /^(\S+)\s+(.+)$/.exec(line.trim())
    if (!m || !driverId(m[1]) || out.some((d) => d.id === m[1])) continue
    out.push({ id: m[1], label: m[2].trim(), recommended: false })
  }
  if (out.length && !out.some((d) => d.recommended)) out[0].recommended = true
  return out
}

/** `lpstat -o` / `lpstat -l -o` → jobs ("HP-1 alice 1024 Tue …"); held jobs carry job-hold-until-specified. */
export function parseJobs(text: string): PrintJob[] {
  const out: PrintJob[] = []
  for (const l of text.split('\n')) {
    const m = /^(\S+)-(\d+)\s+(\S+)\s+(\d+)\s/.exec(l)
    if (m) { out.push({ id: `${m[1]}-${m[2]}`, printer: m[1], user: m[3], size: m[4] }); continue }
    if (out.length && /^\s+(Alerts|Status):.*job-hold-until-specified/.test(l)) out[out.length - 1].held = true
  }
  return out
}

/** `lpstat -l -p` → the printer's own explanation ("Alerts:"/indented reason lines) when it is stopped or failing. */
export function parsePrinterIssues(text: string): PrinterIssue[] {
  const out: PrinterIssue[] = []
  let cur: string | null = null; let disabled = false
  for (const line of text.split('\n')) {
    const p = /^printer (\S+) (.*)$/.exec(line)
    if (p) { cur = p[1]; disabled = /disabled/.test(p[2]); continue }
    if (!cur) continue
    const alert = /^\s+Alerts:\s*(.+)$/.exec(line)
    const reason = alert ? alert[1].trim() : disabled && /^\s+\S/.test(line) && !/:/.test(line) ? line.trim() : null
    if (reason && reason !== 'none' && !out.some((i) => i.name === cur)) out.push({ name: cur, reason })
  }
  return out
}

/** `lpstat -l -p`, `lpstat -v` and `lpstat -d` → the printers with state, message, address and the default. */
export function parsePrinters(long: string, devices: string, def: string): PrinterInfo[] {
  const out: PrinterInfo[] = []
  const dflt = /destination:\s*(\S+)/.exec(def)?.[1] ?? null
  const uris = new Map([...devices.matchAll(/^device for (\S+?):\s*(\S+)/gm)].map((m) => [m[1], m[2]]))
  let cur: PrinterInfo | null = null
  for (const line of long.split('\n')) {
    const p = /^printer (\S+) (.*)$/.exec(line)
    if (p) {
      const s = p[2]
      cur = { name: p[1], description: '', location: '', uri: uris.get(p[1]) ?? '', isDefault: p[1] === dflt, message: null,
        state: /disabled/.test(s) ? 'paused' : /now printing/.test(s) ? 'printing' : /is idle/.test(s) ? 'idle' : 'unknown' }
      out.push(cur); continue
    }
    if (!cur) continue
    const kv = /^\s+(Description|Location|Alerts):\s*(.*)$/.exec(line)
    if (kv?.[1] === 'Description') cur.description = kv[2].trim()
    else if (kv?.[1] === 'Location') cur.location = kv[2].trim()
    else if (kv?.[1] === 'Alerts') { if (!cur.message && kv[2].trim() && kv[2].trim() !== 'none') cur.message = kv[2].trim() }
    else if (!kv && !cur.description && /^\s+\S/.test(line) && !/:/.test(line) && !/^\s+\(/.test(line)) cur.message = line.trim()
  }
  return out
}

/** `lpoptions -p NAME -l` → changeable options with their choices; '*' marks the current one. */
export function parseOptions(text: string): PrinterOption[] {
  const out: PrinterOption[] = []
  for (const line of text.split('\n')) {
    const m = /^([^/:\s]+)\/([^:]*):\s*(.*)$/.exec(line.trim())
    if (!m || !(PREF_KEYS as readonly string[]).includes(m[1])) continue
    const raw = m[3].split(/\s+/).filter(Boolean)
    const choices = raw.map((c) => c.replace(/^\*/, ''))
    const current = raw.find((c) => c.startsWith('*'))?.slice(1) ?? choices[0] ?? ''
    if (choices.length > 1) out.push({ key: m[1], label: m[2].trim() || m[1], choices, current })
  }
  return out
}

/** `lpoptions -p NAME` → key=value pairs ("copies=1 orientation-requested=3 printer-info='Office printer'"). */
export function parseLpoptions(text: string): Record<string, string> {
  const out: Record<string, string> = {}
  for (const m of text.matchAll(/([\w-]+)=('[^']*'|"[^"]*"|\S+)/g)) out[m[1]] = m[2].replace(/^['"]|['"]$/g, '')
  return out
}

/** `lp` → "request id is Office-12 (1 file(s))". */
export const requestId = (text: string) => /request id is (\S+)/.exec(text)?.[1] ?? ''

export function cupsError(text: string): string {
  if (/Forbidden|not authorized|Unauthorized|requires authentication|Not allowed/i.test(text)) return 'not_authorized'
  if (/Unable to connect|No route|timed out|Unable to get printer attributes|Unable to query printer|not responding/i.test(text)) return 'printer_unreachable'
  if (/everywhere|IPP Everywhere|driverless/i.test(text)) return 'printer_not_driverless'
  if (/Bad device-uri|Bad device URI|Unknown device/i.test(text)) return 'printer_bad_address'
  if (/Unable to copy PPD|Bad PPD|driver/i.test(text)) return 'printer_no_driver'
  if (/does not exist|Unknown destination|not found/i.test(text)) return 'printer_gone'
  if (/scheduler is not running|Unable to connect to server|cupsd/i.test(text)) return 'service_unavailable'
  return 'printer_failed'
}

// ---------- bridge ----------
const ok = <T>(value: T): Avail<T> => ({ available: true, value })
const fail = (reason: string): { available: false; reason: string } => ({ available: false, reason })
type Run = Awaited<ReturnType<Exec>>
const failRun = (r: Run, tool: string) => fail(r.missing ? `${tool}_missing` : cupsError(r.stderr + r.stdout))
/** The first line CUPS or lpadmin printed, for the person to read (or quote to support) under the reason (#51). */
export function cupsDetail(text: string): string | undefined {
  const line = text.split('\n').map((l) => l.trim()).find((l) => l && !/^(auth_cancelled|Forbidden)$/.test(l))
  return line ? line.replace(/[\0-\x1f]/g, ' ').slice(0, 300) : undefined
}
/** A queue IPP Everywhere could not set up properly: CUPS leaves a raw queue that prints unrendered data (#51). */
export const isRawQueue = (lpoptions: string) => /printer-make-and-model='?Local Raw Printer/i.test(lpoptions)

export function printersBridge(exec: Exec = printerExec) {
  /** An administrative CUPS call: directly (lpadmin group), then through the polkit-gated helper on "Forbidden". */
  async function admin(cmd: string, args: string[], helper: string[]): Promise<Run> {
    const r = await exec(cmd, args)
    if (r.code === 0 || r.missing || cupsError(r.stderr + r.stdout) !== 'not_authorized') return r
    const p = await exec('pkexec', ['/usr/lib/worksuite/worksuite-printer-admin', ...helper])   // PRINTER_ADMIN
    if (p.missing) return r
    // pkexec: 126 = the administrator prompt was dismissed, 127 = not authorised.
    if (p.code === 126) return { ...p, stderr: 'auth_cancelled' }
    if (p.code === 127) return { ...p, stderr: 'Forbidden' }
    return p
  }
  const adminFail = (r: Run, tool: string) => (r.stderr === 'auth_cancelled' ? fail('auth_cancelled') : failRun(r, tool))

  return {
    async printers(): Promise<Avail<PrinterInfo[]>> {
      const [l, v, d] = await Promise.all([exec('lpstat', ['-l', '-p']), exec('lpstat', ['-v']), exec('lpstat', ['-d'])])
      if (l.missing) return fail('lpstat_missing')
      // lpstat exits non-zero with "No destinations added." when CUPS runs but has no printers.
      if (l.code !== 0 && /no destinations/i.test(l.stdout + l.stderr)) return ok([])
      if (l.code !== 0) return fail(cupsError(l.stderr))
      return ok(parsePrinters(l.stdout, v.stdout, d.stdout))
    },
    /** Network (dnssd/IPP via Avahi), and USB printers (ipp-usb, usb backend). lpinfo needs an administrator. */
    async findPrinters(): Promise<Avail<FoundPrinter[]>> {
      const r = await admin('lpinfo', ['--timeout', '10', '-l', '-v'], ['devices'])
      return r.code === 0 ? ok(parseLpinfo(r.stdout)) : adminFail(r, 'lpinfo')
    },
    /** Drivers for a device: IPP Everywhere when it is driverless, else the PPDs matching its IEEE 1284 id or model. */
    async printerDrivers(uri: string, makeModel: string, deviceId: string): Promise<Avail<PrinterDriver[]>> {
      if (!printerUri(uri) || makeModel.length > 255 || deviceId.length > 1024 || /[\0-\x1f]/.test(makeModel + deviceId)) return fail('invalid_argument')
      const by = deviceId ? ['--device-id', deviceId] : makeModel ? ['--make-and-model', makeModel] : null
      if (!by) return ok(parseDrivers('', uri))
      const r = await admin('lpinfo', [...by, '-m'], ['drivers', by[0] === '--device-id' ? 'id' : 'mm', by[1]])
      // No match is "lpinfo: No drivers found" (non-zero): driverless printers still have IPP Everywhere.
      if (r.code !== 0 && !/no drivers found/i.test(r.stderr + r.stdout)) return adminFail(r, 'lpinfo')
      return ok(parseDrivers(r.code === 0 ? r.stdout : '', uri))
    },
    /** A queue for the printer; with IPP Everywhere CUPS checks the printer answers before creating it. */
    async addPrinter(uri: string, display: string, driver = 'everywhere'): Promise<Avail<string>> {
      const u = printerUri(uri)
      const m = driverId(driver)
      if (!u || !m || !display.trim() || /[\0-\x1f]/.test(display)) return fail('invalid_argument')
      // JetDirect, LPD and the plain USB backend print raw data: they need a driver (USB IPP printers come through ipp-usb).
      if (m === 'everywhere' && !driverless(u)) return fail('printer_no_driver')
      const name = queueName(display)
      const desc = display.trim().slice(0, 127)
      // #51: a failed add must not leave a half-made queue behind ("Local Raw Printer"); only a queue this call
      // created is rolled back, never one of the same name that was already there.
      const existed = (await exec('lpstat', ['-p', name])).code === 0
      const rollback = async () => {
        if (existed || (await exec('lpstat', ['-p', name])).code !== 0) return
        await admin('lpadmin', ['-x', name], ['remove', name])
      }
      const r = await admin('lpadmin', ['-p', name, '-E', '-v', u, '-m', m, '-D', desc], ['add', name, u, m, desc])
      if (r.code !== 0) {
        await rollback()
        const f = adminFail(r, 'lpadmin')
        const detail = f.reason === 'auth_cancelled' || r.missing ? undefined : cupsDetail(r.stderr + '\n' + r.stdout)
        return detail ? { ...f, detail } : f
      }
      if (m === 'everywhere' && !existed && isRawQueue((await exec('lpoptions', ['-p', name])).stdout)) {
        await rollback()
        return fail('printer_not_driverless')
      }
      return ok(name)
    },
    async removePrinter(name: string): Promise<Avail<true>> {
      if (!NAME.test(name)) return fail('invalid_argument')
      const r = await admin('lpadmin', ['-x', name], ['remove', name])
      return r.code === 0 ? ok(true) : adminFail(r, 'lpadmin')
    },
    /** The person's default printer (~/.cups/lpoptions): no administrator, kept across sign-ins. */
    async setDefaultPrinter(name: string): Promise<Avail<true>> {
      if (!NAME.test(name)) return fail('invalid_argument')
      const r = await exec('lpoptions', ['-d', name])
      return r.code === 0 ? ok(true) : failRun(r, 'lpoptions')
    },
    /** Pause (cupsdisable: jobs wait) or resume (cupsenable, and accept jobs again). */
    async pausePrinter(name: string, pause: boolean): Promise<Avail<true>> {
      if (!NAME.test(name)) return fail('invalid_argument')
      const r = pause ? await admin('cupsdisable', [name], ['pause', name]) : await admin('cupsenable', [name], ['resume', name])
      if (r.code !== 0) return adminFail(r, pause ? 'cupsdisable' : 'cupsenable')
      if (!pause) await exec('cupsaccept', [name])
      return ok(true)
    },
    async printTestPage(name: string): Promise<Avail<string>> {
      if (!NAME.test(name)) return fail('invalid_argument')
      const r = await exec('lp', ['-d', name, '-t', 'Test page', TEST_PAGE])
      return r.code === 0 ? ok(requestId(r.stdout)) : failRun(r, 'lp')
    },
    async printerPrefs(name: string): Promise<Avail<PrinterPrefs>> {
      if (!NAME.test(name)) return fail('invalid_argument')
      const [l, o] = await Promise.all([exec('lpoptions', ['-p', name, '-l']), exec('lpoptions', ['-p', name])])
      if (l.code !== 0) return failRun(l, 'lpoptions')
      const cur = parseLpoptions(o.stdout)
      const copies = Number.parseInt(cur.copies ?? '1', 10)
      return ok({ options: parseOptions(l.stdout), orientation: ORIENTATIONS.includes(cur['orientation-requested']) ? cur['orientation-requested'] : '3', copies: copies >= 1 && copies <= 99 ? copies : 1 })
    },
    /** Saves the person's preferences for a printer (lpoptions -p NAME -o key=value). Values must be ones it offers. */
    async setPrinterPrefs(name: string, values: Record<string, string>): Promise<Avail<true>> {
      if (!NAME.test(name) || !values || typeof values !== 'object') return fail('invalid_argument')
      const l = await exec('lpoptions', ['-p', name, '-l'])
      if (l.code !== 0) return failRun(l, 'lpoptions')
      const offered = new Map(parseOptions(l.stdout).map((o) => [o.key, o.choices]))
      const args = ['-p', name]
      for (const [k, v] of Object.entries(values)) {
        const valid = k === 'orientation-requested' ? ORIENTATIONS.includes(v)
          : k === 'copies' ? /^\d{1,2}$/.test(v) && Number(v) >= 1
          : offered.get(k)?.includes(v) ?? false
        if (!valid) return fail('invalid_argument')
        args.push('-o', `${k}=${v}`)
      }
      if (args.length === 2) return ok(true)
      const r = await exec('lpoptions', args)
      return r.code === 0 ? ok(true) : failRun(r, 'lpoptions')
    },
    async printQueue(): Promise<Avail<{ jobs: PrintJob[]; issues: PrinterIssue[] }>> {
      const [o, l] = await Promise.all([exec('lpstat', ['-l', '-o']), exec('lpstat', ['-l', '-p'])])
      if (o.missing) return fail('lpstat_missing')
      return ok({ jobs: parseJobs(o.stdout), issues: parsePrinterIssues(l.stdout) })
    },
    async cancelJob(id: string): Promise<Avail<true>> {
      if (!JOB.test(id)) return fail('invalid_argument')
      const r = await exec('cancel', [id])
      return r.code === 0 ? ok(true) : failRun(r, 'cancel')
    },
    /** Hold a waiting job or let it print (lp -i ID -H hold|resume); people may do this to their own jobs. */
    async holdJob(id: string, hold: boolean): Promise<Avail<true>> {
      if (!JOB.test(id)) return fail('invalid_argument')
      const r = await exec('lp', ['-i', id, '-H', hold ? 'hold' : 'resume'])
      return r.code === 0 ? ok(true) : failRun(r, 'lp')
    },
  }
}
export type PrintersBridge = ReturnType<typeof printersBridge>

type Handle = (channel: string, fn: (...args: string[]) => unknown) => void
/** IPC for the bridge above (the queue, adding and removing are the existing ws:* channels in peripherals.ts). */
export function startPrintersHost(handle: Handle, b: PrintersBridge = printersBridge()) {
  handle('ws:printers', () => b.printers())
  handle('ws:printerDrivers', (u, mm, id) => b.printerDrivers(String(u ?? ''), String(mm ?? ''), String(id ?? '')))
  handle('ws:setDefaultPrinter', (n) => b.setDefaultPrinter(n))
  handle('ws:pausePrinter', (n, p) => b.pausePrinter(n, p === 'pause'))
  handle('ws:printTestPage', (n) => b.printTestPage(n))
  handle('ws:printerPrefs', (n) => b.printerPrefs(n))
  handle('ws:setPrinterPrefs', (n, ...kv) => {
    const values: Record<string, string> = {}
    for (let i = 0; i + 1 < kv.length; i += 2) values[kv[i]] = kv[i + 1]
    return b.setPrinterPrefs(n, values)
  })
  handle('ws:holdJob', (id, h) => b.holdJob(id, h === 'hold'))
}

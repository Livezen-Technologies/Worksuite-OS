// Renderer side of electron/peripherals.ts (WSOS-INT-003…006, INT-011) and the sync error list (WSOS-SYN-004).
// Outside Electron there is no bridge and the sections say so instead of showing sample data.
export type Avail<T> = { available: true; value: T } | { available: false; reason: string }
export interface BtFound { address: string; name: string }
export interface Volume { device: string; disk: string; label: string; size: string; fstype: string; mountpoint: string | null; encrypted: boolean; unlocked: string | null }
export interface PowerProfiles { active: string; profiles: string[]; degraded: string | null }
export interface Inhibitor { what: string; who: string; why: string; mode: string }
export interface FoundPrinter { uri: string; name: string; makeModel?: string; deviceId?: string; kind?: 'network' | 'usb' }
export interface PrintJob { id: string; printer: string; user: string; size: string; held?: boolean }
export interface PrinterInfo {
  name: string; description: string; location: string; uri: string
  state: 'idle' | 'printing' | 'paused' | 'unknown'; message: string | null; isDefault: boolean
}
export interface PrinterDriver { id: string; label: string; recommended: boolean }
export interface PrinterOption { key: string; label: string; choices: string[]; current: string }
export interface PrinterPrefs { options: PrinterOption[]; orientation: string; copies: number }
export interface PrinterIssue { name: string; reason: string }
export interface InputState { enabled: string[]; available: string[] }
/** Taskbar input-method switcher (#58): whether fcitx5 runs and which method it has active. */
export interface ImStatus { running: boolean; current: string | null; enabled: string[] }
export interface FailedChange { mutation_id: string; module: string; object_id: string; last_error: string }
type Reply<T> = { ok: true; value: T } | { ok: false; error: string }

export interface PeripheralsApi {
  btScan(): Promise<Avail<BtFound[]>>
  btPair(address: string): Promise<Avail<true>>
  btRemove(address: string): Promise<Avail<true>>
  volumes(): Promise<Avail<Volume[]>>
  volMount(device: string): Promise<Avail<string>>
  volUnlock(device: string, passphrase: string): Promise<Avail<string>>
  volEject(device: string): Promise<Avail<true>>
  powerProfiles(): Promise<Avail<PowerProfiles>>
  setPowerProfile(name: string): Promise<Avail<true>>
  inhibitors(): Promise<Avail<Inhibitor[]>>
  findPrinters(): Promise<Avail<FoundPrinter[]>>
  /** driver: 'everywhere' (driverless IPP) or a driver id from printerDrivers. */
  addPrinter(uri: string, name: string, driver?: string): Promise<Avail<string>>
  printers(): Promise<Avail<PrinterInfo[]>>
  printerDrivers(uri: string, makeModel: string, deviceId: string): Promise<Avail<PrinterDriver[]>>
  setDefaultPrinter(name: string): Promise<Avail<true>>
  pausePrinter(name: string, pause: boolean): Promise<Avail<true>>
  /** Value: the job id. */
  printTestPage(name: string): Promise<Avail<string>>
  printerPrefs(name: string): Promise<Avail<PrinterPrefs>>
  setPrinterPrefs(name: string, values: Record<string, string>): Promise<Avail<true>>
  holdJob(id: string, hold: boolean): Promise<Avail<true>>
  removePrinter(name: string): Promise<Avail<true>>
  printQueue(): Promise<Avail<{ jobs: PrintJob[]; issues: PrinterIssue[] }>>
  cancelJob(id: string): Promise<Avail<true>>
  /** Running screen-capture streams (WSOS-INT-013). */
  screenCapture(): Promise<Avail<number>>
  /** Emergency stop: ends every ScreenCast session (worksuite-screencast-stop). Value: streams stopped. */
  stopScreenCapture(): Promise<Avail<number>>
  inputMethods(): Promise<Avail<InputState>>
  setInputMethods(ids: string[]): Promise<Avail<true>>
  imStatus(): Promise<Avail<ImStatus>>
  /** Value: the method fcitx5 reports active afterwards. */
  setCurrentIm(id: string): Promise<Avail<string>>
  syncFailed(): Promise<Reply<FailedChange[]>>
  syncRetry(mutationId: string): Promise<Reply<true>>
}

declare global {
  interface Window { worksuitePeripherals?: PeripheralsApi }
}

export const peripheralsApi = (): PeripheralsApi | null => (typeof window !== 'undefined' && window.worksuitePeripherals) || null

/** Error reasons the bridge returns that have their own message; anything else gets the generic one. */
export const KNOWN_REASONS = ['bt_auth_failed', 'bt_unreachable', 'bt_already_paired', 'bt_off', 'storage_busy', 'not_authorized', 'bad_passphrase',
  'storage_unreadable', 'storage_gone', 'printer_unreachable', 'printer_not_driverless', 'printer_bad_address', 'printer_no_driver', 'printer_gone', 'auth_cancelled', 'service_unavailable', 'invalid_argument',
  'fcitx5_missing', 'im_not_running', 'im_not_applied', 'im_not_enabled', 'im_failed'] as const
export type KnownReason = (typeof KNOWN_REASONS)[number]
export const knownReason = (r: string): KnownReason | null =>
  (KNOWN_REASONS as readonly string[]).includes(r) ? (r as KnownReason) : r.endsWith('_missing') ? 'service_unavailable' : null

/** Server error text on a failed change → permission, validation or other (WSOS-SYN-004). */
export function failureKind(lastError: string): 'permission' | 'validation' | 'other' {
  if (/\b(403|forbidden|permission|not_allowed|unauthori[sz]ed)\b/i.test(lastError)) return 'permission'
  if (/\b(400|409|422|invalid|validation|required|too_long)\b/i.test(lastError)) return 'validation'
  return 'other'
}

/** How a printer is reached when its address is typed in: IPP (most network printers), IPPS, JetDirect (port 9100) or LPD. */
export type AddressKind = 'ipp' | 'ipps' | 'socket' | 'lpd'
const IPV4 = /^(?:(?:25[0-5]|2[0-4]\d|1?\d?\d)\.){3}(?:25[0-5]|2[0-4]\d|1?\d?\d)$/
const HOST = /^(?:(?:25[0-5]|2[0-4]\d|1?\d?\d)(?:\.(?:25[0-5]|2[0-4]\d|1?\d?\d)){3}|\[[0-9A-Fa-f:.]+\]|(?=.{1,253}$)[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?)*)(?::\d{1,5})?$/

/** A typed host name or IP address → the printer's URI, or null when it is not a valid host. */
export function addressUri(kind: AddressKind, host: string, queue = ''): string | null {
  let h = host.trim()
  const q = queue.trim().replace(/^\/+/, '')
  if (/^[0-9A-Fa-f]*:[0-9A-Fa-f:]+$/.test(h) && h.split(':').length > 2) h = `[${h}]`   // bare IPv6
  // Only digits and dots is meant as an IPv4 address: 300.1.1.1 is a typo, not a host name.
  if (!HOST.test(h) || (/^[\d.]+(:\d+)?$/.test(h) && !IPV4.test(h.replace(/:\d+$/, '')))) return null
  if (q.includes('..')) return null
  if (q && !/^[A-Za-z0-9._~/-]{1,128}$/.test(q)) return null
  switch (kind) {
    case 'ipp': case 'ipps': return `${kind}://${h}/${q || 'ipp/print'}`
    case 'socket': return `socket://${/:\d+$/.test(h) && !h.endsWith(']') ? h : `${h}:9100`}`
    case 'lpd': return `lpd://${h}/${q || 'queue'}`
  }
}

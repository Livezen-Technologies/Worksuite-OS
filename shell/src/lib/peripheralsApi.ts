// Renderer side of electron/peripherals.ts (WSOS-INT-003…006, INT-011) and the sync error list (WSOS-SYN-004).
// Outside Electron there is no bridge and the sections say so instead of showing sample data.
export type Avail<T> = { available: true; value: T } | { available: false; reason: string }
export interface BtFound { address: string; name: string }
export interface Volume { device: string; disk: string; label: string; size: string; fstype: string; mountpoint: string | null; encrypted: boolean; unlocked: string | null }
export interface PowerProfiles { active: string; profiles: string[]; degraded: string | null }
export interface Inhibitor { what: string; who: string; why: string; mode: string }
export interface FoundPrinter { uri: string; name: string }
export interface PrintJob { id: string; printer: string; user: string; size: string }
export interface PrinterIssue { name: string; reason: string }
export interface InputState { enabled: string[]; available: string[] }
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
  addPrinter(uri: string, name: string): Promise<Avail<string>>
  removePrinter(name: string): Promise<Avail<true>>
  printQueue(): Promise<Avail<{ jobs: PrintJob[]; issues: PrinterIssue[] }>>
  cancelJob(id: string): Promise<Avail<true>>
  /** Running screen-capture streams (WSOS-INT-013). */
  screenCapture(): Promise<Avail<number>>
  /** Emergency stop: ends every ScreenCast session (worksuite-screencast-stop). Value: streams stopped. */
  stopScreenCapture(): Promise<Avail<number>>
  inputMethods(): Promise<Avail<InputState>>
  setInputMethods(ids: string[]): Promise<Avail<true>>
  syncFailed(): Promise<Reply<FailedChange[]>>
  syncRetry(mutationId: string): Promise<Reply<true>>
}

declare global {
  interface Window { worksuitePeripherals?: PeripheralsApi }
}

export const peripheralsApi = (): PeripheralsApi | null => (typeof window !== 'undefined' && window.worksuitePeripherals) || null

/** Error reasons the bridge returns that have their own message; anything else gets the generic one. */
export const KNOWN_REASONS = ['bt_auth_failed', 'bt_unreachable', 'bt_already_paired', 'bt_off', 'storage_busy', 'not_authorized', 'bad_passphrase',
  'storage_unreadable', 'storage_gone', 'printer_unreachable', 'printer_not_driverless', 'service_unavailable', 'invalid_argument'] as const
export type KnownReason = (typeof KNOWN_REASONS)[number]
export const knownReason = (r: string): KnownReason | null =>
  (KNOWN_REASONS as readonly string[]).includes(r) ? (r as KnownReason) : r.endsWith('_missing') ? 'service_unavailable' : null

/** Server error text on a failed change → permission, validation or other (WSOS-SYN-004). */
export function failureKind(lastError: string): 'permission' | 'validation' | 'other' {
  if (/\b(403|forbidden|permission|not_allowed|unauthori[sz]ed)\b/i.test(lastError)) return 'permission'
  if (/\b(400|409|422|invalid|validation|required|too_long)\b/i.test(lastError)) return 'validation'
  return 'other'
}

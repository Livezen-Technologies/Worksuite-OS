// Typed renderer API. In Electron the preload exposes `window.worksuite` with named functions only
// (WSOS-SEC-001, §10.3); in a plain browser (dev/design review) a local stub answers instead.
export interface WorkSuiteApi {
  authenticate(user: string, password: string): Promise<{ ok: boolean; message?: string }>
  lock(): Promise<void>
  logout(): Promise<void>
  power(action: 'suspend' | 'restart' | 'shutdown'): Promise<void>
  launchApp(appId: string): Promise<void>
  openLink(url: string): Promise<void>
  // WorkSuite cloud identity through the credentials broker (SRS §8.1). Tokens never reach the renderer.
  cloudSignIn(serverUrl: string, mode: 'personal' | 'enterprise'): Promise<CloudResult<CloudAccount>>
  /** choice: 'none' when nothing is unsent; 'export' or 'discard' otherwise ("wait" = syncNow, then 'none'). */
  cloudSignOut(accountId: string, choice: SignOutChoice): Promise<CloudResult<{ exported: string | null }>>
  syncUnsent(accountId: string): Promise<CloudResult<number>>
  syncNow(): Promise<CloudResult<unknown>>
  cloudAccounts(): Promise<CloudResult<CloudAccount[]>>
  /** Settings > About this device (WSOS-MDM-007, WSOS-WIPE-007): device agent status, or local facts when it isn't running. */
  deviceInfo(): Promise<DeviceInfo>
  /** Enterprise enrollment through the device agent; asks for an administrator password (polkit). */
  enrollDevice(serverUrl: string, code: string): Promise<CloudResult<{ device_id: string; org_name: string | null }>>
}

export interface DevicePolicies {
  version: string; update_ring: string | null; update_mode: string | null; maintenance_window: string | null
  lock_timeout_max_s: number | null; offline_access_days: number | null; usb_storage: string | null; bluetooth: boolean | null
  app_allowlist_size: number
}
export interface DeviceInfo {
  agent: boolean
  device: { hostname: string; os_version: string; arch: string; kernel_version: string; encrypted: boolean | null } | null
  managed: boolean
  org_name: string | null
  server: string | null
  last_check_in: number | null
  policies: DevicePolicies | null
}

/** Policy → plain sentences for the management notice. Only what the policy actually sets. */
export function policyLines(p: DevicePolicies | null): string[] {
  if (!p) return []
  const out: string[] = []
  if (p.app_allowlist_size > 0) out.push(`Only approved apps can be installed (${p.app_allowlist_size} approved)`)
  if (p.update_ring || p.update_mode) out.push(`Updates: ${[p.update_ring && `${p.update_ring} ring`, p.update_mode && `${p.update_mode} mode`].filter(Boolean).join(', ')}${p.maintenance_window ? `, restarts ${p.maintenance_window}` : ''}`)
  if (p.lock_timeout_max_s) out.push(`Screen locks after at most ${Math.round(p.lock_timeout_max_s / 60)} min idle`)
  if (p.offline_access_days) out.push(`Offline sign-in allowed for ${p.offline_access_days} days`)
  if (p.usb_storage === 'block') out.push('USB storage is blocked')
  else if (p.usb_storage === 'read_only') out.push('USB storage is read-only')
  if (p.bluetooth === false) out.push('Bluetooth is turned off')
  return out
}

export type SignOutChoice = 'none' | 'export' | 'discard'

export interface CloudAccount { id: string; name: string | null; server_url: string; state?: string }
export type CloudResult<T> = { ok: true; value: T } | { ok: false; error: string }

declare global {
  interface Window { worksuite?: WorkSuiteApi }
}

const stub: WorkSuiteApi = {
  async authenticate(_user, password) {
    return password.length > 0 ? { ok: true } : { ok: false, message: 'Enter your password.' }
  },
  async lock() {},
  async logout() {},
  async power() {},
  async launchApp() {},
  async openLink() {},
  async cloudSignIn(serverUrl, _mode) {
    stubAccounts = [{ id: 'preview:u-1', name: 'Hasarinda', server_url: serverUrl, state: 'signed_in' }]
    return { ok: true, value: stubAccounts[0] }
  },
  async cloudSignOut(id, choice) {
    stubAccounts = stubAccounts.filter((a) => a.id !== id)
    stubUnsent = 0
    return { ok: true, value: { exported: choice === 'export' ? '~/Documents/WorkSuite unsent changes.json' : null } }
  },
  async syncUnsent() { return { ok: true, value: stubUnsent } },
  async syncNow() { stubUnsent = Math.max(0, stubUnsent - 1); return { ok: true, value: true } },
  async enrollDevice(_url, code) {
    return code === 'BAD-CODE' ? { ok: false, error: 'enrollment_rejected' } : { ok: true, value: { device_id: 'preview-device', org_name: 'Livezen Technologies' } }
  },
  async deviceInfo() {
    return {
      agent: true, managed: true, org_name: 'Livezen Technologies', server: 'work.livezentech.com', last_check_in: Date.now() - 4 * 60_000,
      device: { hostname: 'LZT-LAP-0142', os_version: 'WorkSuite OS 1.0 (preview)', arch: 'amd64', kernel_version: '6.12', encrypted: true },
      policies: { version: 'preview', update_ring: 'pilot', update_mode: 'automatic', maintenance_window: '02:00-04:00', lock_timeout_max_s: 300, offline_access_days: 7, usb_storage: 'read_only', bluetooth: null, app_allowlist_size: 42 },
    }
  },
  async cloudAccounts() { return { ok: true, value: stubAccounts } },
}

let stubAccounts: CloudAccount[] = []
// Preview only: pretend three offline edits are waiting so the sign-out prompt can be seen.
let stubUnsent = 3

/** Broker error codes → text for the user. */
export function cloudErrorText(code: string): string {
  switch (code) {
    case 'discovery_failed': return 'That server didn’t answer as a WorkSuite server. Check the address.'
    case 'insecure_url': return 'The server must use https.'
    case 'sign_in_timeout': return 'Sign-in wasn’t finished in the browser. Try again.'
    case 'access_denied': return 'Sign-in was cancelled.'
    case 'broker_unavailable': return 'The sign-in service isn’t running. Try again in a moment.'
    case 'device_not_enrolled': return 'This computer isn’t enrolled with your organization yet. Ask IT to enroll it, then sign in again.'
    case 'bootstrap_failed':
    case 'bootstrap_invalid': return 'Signed in, but WorkSuite couldn’t load your organization’s settings. Try again.'
    case 'auth_cancelled': return 'Enrollment needs an administrator password. Nothing was changed.'
    case 'enrollment_rejected': return 'The server didn’t accept that enrollment code. Check it with your IT admin; codes expire quickly.'
    case 'invalid_code': return 'Enter the enrollment code exactly as your IT admin gave it.'
    case 'agent_unavailable': return 'The device agent isn’t running, so this computer can’t be enrolled right now.'
    case 'export_failed': return 'Couldn’t save the unsent changes. Nothing was signed out.'
    default: return 'Sign-in didn’t work. Check your connection and try again.'
  }
}

/** "work.example.com" → "https://work.example.com"; personal mode uses WorkSuite Cloud. */
export function serverUrlFor(mode: 'personal' | 'enterprise', server: string): string {
  if (mode === 'personal') return 'https://worksuitecloud.com'
  const s = server.trim()
  return /^[a-z]+:\/\//i.test(s) ? s : `https://${s}`
}

export const os: WorkSuiteApi = (typeof window !== 'undefined' && window.worksuite) || stub

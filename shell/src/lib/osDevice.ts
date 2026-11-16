// Device, policy, security, monitoring, lock and account types of the renderer API (from os.ts).

export interface DevicePolicies {
  version: string; update_ring: string | null; update_mode: string | null; maintenance_window: string | null
  lock_timeout_max_s: number | null; offline_access_days: number | null; usb_storage: string | null; bluetooth: boolean | null
  app_allowlist_size: number
  /** Employee monitoring (#22) on in the signed policy. */
  activity_monitoring?: boolean
  /** On-device AI assistant (services/ai): false = off for everyone; ai_models = catalog ids allowed. */
  ai_assistant?: boolean | null; ai_models?: string[] | null
  /** Desktop widgets (WorkSuite Desktop's Home on the wallpaper): false = off for everyone. Kiosk: always off. */
  desktop_widgets?: boolean | null; kiosk?: boolean
  /** WhatsApp (WhatsApp Web window): false = off on this device. */
  whatsapp?: boolean | null
  /** Screenshots and the snipping tool; clipboard history (Super+V). 'disabled' = off; kiosks: always off. */
  screen_capture?: 'allowed' | 'disabled' | null; clipboard_history?: 'allowed' | 'disabled' | null
  /** Remote support without asking first (issue #19): disclosed to the user here and in the session indicator. */
  remote_support_unattended?: boolean
  /** Software Management and the Update Manager's download limit (KiB/s, 0 = none). */
  software_install?: 'any' | 'approved' | 'request' | 'block' | null; software_uninstall?: boolean | null; software_update?: boolean | null
  update_bandwidth_kbps?: number | null
}
export type KioskApp = { type: 'url'; url: string } | { type: 'module'; id: string } | { type: 'desktop'; id: string }
export interface KioskSummary { user: string; app: KioskApp; allowed_urls: string[]; idle_reset_minutes: number; show_on_screen_keyboard: boolean; exit_pin: boolean
  /** Policy kiosk.orientation and kiosk.screen_off (older agents send neither). */
  orientation?: 'landscape' | 'portrait' | 'landscape-flipped' | 'portrait-flipped'; screen_off?: { from: string; until: string } | null }
export interface DeviceInfo {
  agent: boolean
  device: { hostname: string; os_version: string; arch: string; kernel_version: string; encrypted: boolean | null } | null
  managed: boolean
  org_name: string | null
  server: string | null
  last_check_in: number | null
  policies: DevicePolicies | null
  /** Settings › Managed › Kiosk mode: this device's kiosk as the policy sets it (never the exit PIN); null = not a kiosk. */
  kiosk?: KioskSummary | null
  /** WSOS-IDN-004: provisioning requires enrollment (and so a connection) before first use. */
  provisioning?: { require_enrollment: boolean; server: string | null }
  /** Processor and memory (electron/device.ts hostSpecs). */
  specs?: { cpu_model: string | null; cpu_cores: number | null; memory_bytes: number | null }
}

export interface SecurityScanRecord { id?: string; kind: string; trigger: string; started: number; finished: number; files: number; detections: number; errors?: number; error?: string }
/** /run/worksuite-device-agent/security.json (services/device-agent/src/security.ts securityStatus). */
export interface SecurityStatus {
  overall: 'protected' | 'attention' | 'at_risk' | 'unavailable'
  issues: string[]
  managed: boolean
  scanning?: boolean
  firewall: { active: boolean; policy_rules: number; log_blocked: boolean }
  isolation: { since: number; until: number } | null
  antivirus: { enabled: boolean; installed: boolean; engine: string | null; signatures: number | null; signatures_at: number | null; signatures_age_days: number | null; updates: string; schedule: string; exclusions: number
    last_scan: SecurityScanRecord | null; last_full_scan: number | null
    /** #64 (absent from older agents): a scan can run now; the running scan's progress; recent scans, newest first. */
    ready?: boolean
    progress?: { kind: string; started: number; files: number; detections: number; errors: number; current: string | null; elapsed_ms: number } | null
    scans?: SecurityScanRecord[] }
  threats: { active: number; quarantined: number }
  history: { id: string; at: number; path: string; signature: string; action: string }[]
  firewall_alerts: { at: number; dst: string; dport: number | null; proto: string }[]
  retention_days: number
  /** #38 protection layers; absent from older agents. */
  realtime?: { enabled: boolean; prevention: boolean; state: string; downloads: boolean }
  protected_folders?: { folders: string[]; mode: 'block' | 'audit'; state: string }
  app_control?: { denied: number }
  web?: { dns_blocked: number; dns_feeds: number; dns_filter: boolean; dns_feed_entries: number }
  threat_intel?: { feeds: number; entries: number; updated: number | null; errors: string[] }
  auto_patch?: 'immediate' | 'window' | 'off'
  events?: { id: string; at: number; kind: string; path: string; exe: string | null; signature: string | null; enforced: boolean; resolved: string | null }[]
  suspended?: { id: string; at: number; path: string; exe: string | null; pid: number | null }[]
  quarantine?: { id: string; at: number; path: string; signature: string }[]
}
/** One day of activity (electron/activity.ts DayReport): aggregates only. */
export interface ActivityDay { day: string; active_s: number; idle_s: number; locked_s: number; first_active: number | null; last_active: number | null
  apps: { app_id: string; name: string; active_s: number; switches: number }[]; events: { at: number; type: string }[]
  /** #39: only when the organization's policy turns website domains on. */
  domains?: { domain: string; active_s: number }[] }
/** #39: the current state the shell last sent for the organization's live view. */
export interface ActivityLive { state: 'active' | 'idle' | 'locked'; app_id: string | null; at: number }
export interface ActivityStatus { enabled: boolean; org_name: string | null; retention_days: number; idle_threshold_s: number; disclosure_needed: boolean; last_sent: number | null; days: ActivityDay[]
  web_domains?: boolean; live?: ActivityLive | null }
/** What the organization's server holds about the user (desktop/v1/activity). */
export interface ActivityRemote { items: (ActivityDay & { device_id: string })[]; device_events: { device_id: string; at: number; type: 'startup' | 'shutdown' }[]; live: { device_id: string; state: string; app_id: string | null; at: number }[] }

export interface LockSettings { timeout_s: number; max_s: number | null; choices: number[] }
export interface InstalledApp { id: string; name: string; generic_name: string | null; comment: string | null; icon: string | null; categories: string[]; keywords: string[]; wm_class?: string | null }

export type SignOutChoice = 'none' | 'export' | 'discard'

export interface CloudAccount { id: string; name: string | null; server_url: string; state?: string }
/** Device agent methods Settings › WorkSuite Security calls (electron/securityCenter.ts securityAction). */
export type SecurityMethod = 'RestoreQuarantined' | 'DeleteQuarantined' | 'ResolveSuspendedProcess' | 'CancelSecurityScan' | 'UpdateSecurityDefinitions'
export type CloudResult<T> = { ok: true; value: T } | { ok: false; error: string }

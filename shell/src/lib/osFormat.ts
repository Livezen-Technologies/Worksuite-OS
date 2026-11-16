// Text helpers for the renderer API's values: durations, sizes, error codes, policies, sign-in targets (from os.ts).
import { formatDecimal, formatNumber, t } from '../i18n'
import { errorMessage } from './errors'
import { type DevicePolicies, type DeviceInfo, type CloudAccount } from './osDevice'

/** "about 1 h 20 min" from seconds. */
export function formatDuration(s: number | null): string | null {
  if (s === null || s <= 0) return null
  const h = Math.floor(s / 3600), m = Math.round((s % 3600) / 60)
  return h ? (m ? t('time.aboutHM', { h, m }) : t('time.aboutH', { h })) : t('time.aboutM', { m })
}

export function formatBytes(n: number | null): string {
  if (n == null) return '—'
  const a = Math.abs(n)
  const s = a >= 1e9 ? `${formatDecimal(a / 1e9, 1)} GB` : a >= 1e6 ? `${formatNumber(Math.round(a / 1e6))} MB` : `${formatNumber(Math.max(1, Math.round(a / 1e3)))} kB`
  return n < 0 ? t('bytes.freed', { size: s }) : s
}

/** Package service error → text. Its own messages are already written for people. */
export function packageErrorText(code: string): string {
  switch (code) {
    case 'not_authorized': return t('rec.err.notAuthorized')
    case 'cancelled': return ''
    case 'service_unavailable': return t('pkg.err.service')
    case 'invalid_argument': return t('pkg.err.invalid')
    case 'failed': return t('rec.err.default')
    // Anything else is PackageKit's/dpkg's own text: a sentence from lib/errors.ts instead (details for administrators).
    default: return errorMessage(code, 'package')
  }
}

/** Taskbar chip text: null when the device isn't managed (WSOS-MDM-007). */
export function managedLabel(info: DeviceInfo | null): string | null {
  if (!info?.managed) return null
  return info.policies?.update_ring ? t('mdm.managedRing', { ring: info.policies.update_ring }) : t('mdm.managed')
}

/** Policy → plain sentences for the management notice. Only what the policy actually sets. */
export function policyLines(p: DevicePolicies | null): string[] {
  if (!p) return []
  const out: string[] = []
  if (p.app_allowlist_size > 0) out.push(t('mdm.allowlist', { count: p.app_allowlist_size }))
  if (p.update_ring || p.update_mode) out.push(t('mdm.updates', { list: [p.update_ring && t('mdm.ring', { ring: p.update_ring }), p.update_mode && t('mdm.mode', { mode: p.update_mode }), p.maintenance_window && t('mdm.restarts', { window: p.maintenance_window })].filter(Boolean).join(', ') }))
  if (p.lock_timeout_max_s) out.push(t('mdm.lock', { min: Math.round(p.lock_timeout_max_s / 60) }))
  if (p.offline_access_days) out.push(t('mdm.offline', { days: p.offline_access_days }))
  if (p.usb_storage === 'block') out.push(t('mdm.usbBlocked'))
  else if (p.usb_storage === 'read_only') out.push(t('mdm.usbRO'))
  if (p.bluetooth === false) out.push(t('mdm.btOff'))
  if (p.desktop_widgets === false) out.push(t('mdm.widgetsOff'))
  if (p.whatsapp === false) out.push(t('mdm.whatsappOff'))
  if (p.screen_capture === 'disabled') out.push(t('mdm.captureOff'))
  if (p.clipboard_history === 'disabled') out.push(t('mdm.clipboardOff'))
  if (p.remote_support_unattended) out.push(t('mdm.remoteUnattended'))
  if (p.ai_assistant === false) out.push(t('mdm.aiOff'))
  if (p.activity_monitoring === true) out.push(t('mdm.monitoringOn'))
  else if (p.ai_models?.length) out.push(t('mdm.aiLimited', { count: p.ai_models.length }))
  return out
}

export function lockChoiceLabel(s: number): string {
  if (s === 0) return t('time.never')
  if (s < 3600) return t('time.min', { n: Math.round(s / 60) })
  return s === 3600 ? t('time.hour') : t('time.hours', { n: formatNumber(Math.round(s / 360) / 10) })
}

/** Broker error codes → text for the user. */
export function cloudErrorText(code: string): string {
  switch (code) {
    case 'discovery_failed': return t('cloud.err.discovery')
    case 'insecure_url': return t('cloud.err.insecure')
    case 'invalid_url': return t('cloud.err.invalidUrl')
    case 'credentials_in_url': return t('cloud.err.credentialsInUrl')
    case 'dns_failed': return t('cloud.err.dns')
    case 'unreachable': return t('cloud.err.unreachable')
    case 'network_timeout': return t('cloud.err.netTimeout')
    case 'tls_failed': return t('cloud.err.tls')
    case 'sign_in_timeout': return t('cloud.err.timeout')
    case 'access_denied': return t('cloud.err.denied')
    case 'broker_unavailable': return t('cloud.err.broker')
    case 'device_not_enrolled': return t('cloud.err.notEnrolled')
    case 'bootstrap_failed':
    case 'bootstrap_invalid': return t('cloud.err.bootstrap')
    case 'auth_cancelled': return t('cloud.err.authCancelled')
    case 'sign_in_cancelled': return t('cloud.err.signInCancelled')
    case 'locked': return t('cloud.err.locked')
    case 'browser_failed': return t('cloud.err.browser')
    case 'enrollment_rejected': return t('cloud.err.rejected')
    case 'invalid_code': return t('cloud.err.code')
    case 'agent_unavailable': return t('cloud.err.agent')
    case 'export_failed': return t('cloud.err.export')
    default: return t('cloud.err.default')
  }
}

/**
 * Where "Sign in" goes without asking: the organization this device is enrolled with or provisioned for, else the
 * server of an earlier sign-in, else WorkSuite Cloud (same order as signInTarget() in electron/webapps.ts).
 */
export function defaultSignInTarget(info: Pick<DeviceInfo, 'server' | 'provisioning'> | null, accounts: Pick<CloudAccount, 'server_url'>[]): { mode: 'personal' | 'enterprise'; server: string } {
  const https = (u: string | null | undefined): u is string => { try { return !!u && new URL(u).protocol === 'https:' } catch { return false } }
  const org = [info?.server, info?.provisioning?.server].find(https)
  if (org) return { mode: 'enterprise', server: org }
  const prev = accounts.find((a) => https(a.server_url))
  if (prev && !new URL(prev.server_url).hostname.endsWith('worksuitecloud.com')) return { mode: 'enterprise', server: prev.server_url }
  return { mode: 'personal', server: '' }
}

/** "work.example.com" → "https://work.example.com"; personal mode uses WorkSuite Cloud. */
export function serverUrlFor(mode: 'personal' | 'enterprise', server: string): string {
  if (mode === 'personal') return 'https://worksuitecloud.com'
  const s = server.trim()
  return /^[a-z]+:\/\//i.test(s) ? s : `https://${s}`
}

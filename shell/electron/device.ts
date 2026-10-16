// Device agent integration for the shell: status for Settings > About this device and enrollment over lk.worksuite.DeviceAgent1.
import dbus from 'dbus-next'
import { readFileSync } from 'node:fs'
import os from 'node:os'

export const STATUS_PATH = '/run/worksuite-device-agent/status.json'

export const DEVICE_TOKEN_PATH = '/run/worksuite-device-agent/device-token'

/**
 * The device credential for X-WS-Device, or null when the device isn't enrolled (no device in the agent's status, or no
 * token file). Read fresh on every call so a revoked/unenrolled device stops sending it at once. Main process only.
 */
export function deviceCredential(statusPath = STATUS_PATH, tokenPath = DEVICE_TOKEN_PATH): string | null {
  try {
    if (!JSON.parse(readFileSync(statusPath, 'utf8'))?.device) return null
    return readFileSync(tokenPath, 'utf8').trim() || null
  } catch { return null }
}

export const PROVISIONING_PATH = '/etc/worksuite/provisioning.json'

/**
 * WSOS-IDN-004: OEM / installer provisioning (root-owned, e.g. {"require_enrollment": true, "server": "https://..."}).
 * When enrollment is required, first-run setup cannot be skipped and needs a connection to enroll.
 */
export function provisioning(path = PROVISIONING_PATH): { require_enrollment: boolean; server: string | null } {
  try {
    const p = JSON.parse(readFileSync(path, 'utf8'))
    const server = typeof p.server === 'string' && /^https:\/\//.test(p.server) ? p.server : null
    return { require_enrollment: p.require_enrollment === true, server }
  } catch { return { require_enrollment: false, server: null } }
}

/** Device agent status file (0644, written by worksuite-device-agent); local facts if the agent isn't running. */
export function deviceInfo(statusPath = STATUS_PATH, provisioningPath = PROVISIONING_PATH) {
  return { ...agentInfo(statusPath), provisioning: provisioning(provisioningPath) }
}

function agentInfo(statusPath: string) {
  try {
    const st = JSON.parse(readFileSync(statusPath, 'utf8'))
    return { agent: true, device: st.device ?? null, managed: !!st.managed, org_name: st.org_name ?? null, server: st.server ?? null, last_check_in: st.last_check_in ?? null, policies: st.policies ?? null, kiosk: st.kiosk ?? null }
  } catch {
    let osVersion = 'unknown'
    try { osVersion = /^PRETTY_NAME="?([^"\n]*)/m.exec(readFileSync('/etc/os-release', 'utf8'))?.[1] ?? osVersion } catch { /* keep unknown */ }
    return {
      agent: false, managed: false, org_name: null, server: null, last_check_in: null, policies: null, kiosk: null,
      device: { hostname: os.hostname(), os_version: osVersion, arch: process.arch === 'arm64' ? 'arm64' : 'amd64', kernel_version: os.release(), encrypted: null },
    }
  }
}

/** One D-Bus call to lk.worksuite.DeviceAgent1.Enroll: the device id, or the D-Bus error name and message. */
export type EnrollCall = (serverUrl: string, token: string) => Promise<{ ok: true; id: string } | { ok: false; name: string; message: string }>

/** The real call on the system bus; polkit (lk.worksuite.device.enroll, auth_admin) asks for an administrator. */
export const busEnroll: EnrollCall = async (serverUrl, token) => {
  const bus = dbus.systemBus()
  try {
    const obj = await bus.getProxyObject('lk.worksuite.DeviceAgent1', '/lk/worksuite/DeviceAgent1')
    const id = await obj.getInterface('lk.worksuite.DeviceAgent1').Enroll(serverUrl, token)
    return { ok: true, id: String(id) }
  } catch (e) {
    const err = e as { type?: string; text?: string; message?: string }
    return { ok: false, name: err.type ?? 'org.freedesktop.DBus.Error.Failed', message: err.text ?? err.message ?? '' }
  } finally { bus.disconnect() }
}

/**
 * Device enrollment (§9.3) is the named D-Bus method lk.worksuite.DeviceAgent1.Enroll behind the polkit action
 * lk.worksuite.device.enroll (WSOS-ARC-002). The enrollment code is a D-Bus argument: never in argv or logs.
 */
export async function enrollDevice(serverUrl: string, code: string, statusPath = STATUS_PATH, call: EnrollCall = busEnroll): Promise<{ ok: true; value: { device_id: string; org_name: string | null } } | { ok: false; error: string }> {
  let url: URL
  try { url = new URL(serverUrl) } catch { return { ok: false, error: 'insecure_url' } }
  if (url.protocol !== 'https:') return { ok: false, error: 'insecure_url' }
  const token = code.trim()
  if (!/^[A-Za-z0-9-]{4,128}$/.test(token)) return { ok: false, error: 'invalid_code' }
  const r = await call(url.toString(), token).catch(() => ({ ok: false as const, name: 'org.freedesktop.DBus.Error.ServiceUnknown', message: '' }))
  if (r.ok || r.message === 'ALREADY_ENROLLED') return { ok: true, value: { device_id: r.ok ? r.id : '', org_name: deviceInfo(statusPath).org_name } }
  if (r.name === 'lk.worksuite.Error.NotAuthorized') return { ok: false, error: 'auth_cancelled' }
  if (/ServiceUnknown|NameHasNoOwner|NoReply|Disconnected|AccessDenied/.test(r.name)) return { ok: false, error: 'agent_unavailable' }
  if (r.message === 'INSECURE_URL') return { ok: false, error: 'insecure_url' }
  return { ok: false, error: 'enrollment_rejected' }
}

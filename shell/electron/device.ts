// Device agent integration for the shell: status for Settings > About this device and enrollment via pkexec.
import { spawn } from 'node:child_process'
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
    return { agent: true, device: st.device ?? null, managed: !!st.managed, org_name: st.org_name ?? null, server: st.server ?? null, last_check_in: st.last_check_in ?? null, policies: st.policies ?? null }
  } catch {
    let osVersion = 'unknown'
    try { osVersion = /^PRETTY_NAME="?([^"\n]*)/m.exec(readFileSync('/etc/os-release', 'utf8'))?.[1] ?? osVersion } catch { /* keep unknown */ }
    return {
      agent: false, managed: false, org_name: null, server: null, last_check_in: null, policies: null,
      device: { hostname: os.hostname(), os_version: osVersion, arch: process.arch === 'arm64' ? 'arm64' : 'amd64', kernel_version: os.release(), encrypted: null },
    }
  }
}

/**
 * Device enrollment (§9.3) runs the agent CLI as root through pkexec (polkit action lk.worksuite.device.enroll,
 * admin auth). Fixed arguments; the enrollment code goes on stdin, never into argv or logs.
 */
export function enrollDevice(serverUrl: string, code: string, statusPath = STATUS_PATH): Promise<{ ok: true; value: { device_id: string; org_name: string | null } } | { ok: false; error: string }> {
  let url: URL
  try { url = new URL(serverUrl) } catch { return Promise.resolve({ ok: false, error: 'insecure_url' }) }
  if (url.protocol !== 'https:') return Promise.resolve({ ok: false, error: 'insecure_url' })
  const token = code.trim()
  if (!/^[A-Za-z0-9-]{4,128}$/.test(token)) return Promise.resolve({ ok: false, error: 'invalid_code' })
  return new Promise((resolve) => {
    const child = spawn('pkexec', ['/usr/bin/worksuite-device-agent', 'enroll', '--server', url.toString()], { stdio: ['pipe', 'pipe', 'pipe'] })
    let out = '', err = ''
    child.stdout.on('data', (d) => { out += d })
    child.stderr.on('data', (d) => { err += d })
    child.on('error', () => resolve({ ok: false, error: 'agent_unavailable' }))
    child.on('close', (status) => {
      // pkexec: 126 = authentication dismissed or failed, 127 = not authorized.
      if (status === 126 || status === 127) return resolve({ ok: false, error: 'auth_cancelled' })
      const info = deviceInfo(statusPath)
      if (status === 0 || /ALREADY_ENROLLED/.test(err)) {
        let id = ''
        try { id = String(JSON.parse(out)) } catch { /* already enrolled: no id printed */ }
        return resolve({ ok: true, value: { device_id: id, org_name: info.org_name } })
      }
      if (/not running/.test(err)) return resolve({ ok: false, error: 'agent_unavailable' })
      if (/INSECURE_URL/.test(err)) return resolve({ ok: false, error: 'insecure_url' })
      resolve({ ok: false, error: 'enrollment_rejected' })
    })
    child.stdin.end(token + '\n')
  })
}

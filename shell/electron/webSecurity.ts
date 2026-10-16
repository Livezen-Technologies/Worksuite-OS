// Web-content security policy of the shell (WSOS-SEC-001/002/003/006), kept free of Electron imports so it is unit-tested.
import { readFileSync } from 'node:fs'

/** URL schemes the shell may hand to the system (WSOS-SEC-006). Everything else (file:, javascript:, data:, smb:, …) is refused. */
export const ALLOWED_SCHEMES: ReadonlySet<string> = new Set(['https:', 'mailto:', 'tel:', 'worksuite:'])

export function externalAllowed(raw: string): boolean {
  let u: URL
  try { u = new URL(raw) } catch { return false }
  if (!ALLOWED_SCHEMES.has(u.protocol)) return false
  // Credentials in a URL are a phishing vector and never needed for a hand-off.
  return !u.username && !u.password
}

/** webPreferences every shell renderer gets (WSOS-SEC-001). */
export function shellWebPreferences(preload: string) {
  return {
    preload, sandbox: true, contextIsolation: true, nodeIntegration: false, nodeIntegrationInWorker: false,
    nodeIntegrationInSubFrames: false, webSecurity: true, allowRunningInsecureContent: false, webviewTag: false,
  }
}

/** Production CSP of the shell bundle (WSOS-SEC-002): no inline script or style, no remote origins. */
export const SHELL_CSP = [
  "default-src 'self'", "script-src 'self'", "style-src 'self'", "img-src 'self' data:", "font-src 'self'",
  "connect-src 'self'", "object-src 'none'", "base-uri 'none'", "form-action 'none'", "frame-src 'none'", "frame-ancestors 'none'",
].join('; ')

// Per-origin web permission grants (WSOS-SEC-003). Default deny; an administrator (MDM-managed file) may grant named
// permissions to exact HTTPS origins, e.g. {"https://meet.example.org": ["media", "notifications"]}.
export const WEB_PERMISSIONS_FILE = '/etc/worksuite/web-permissions.json'
// Permissions that can be granted at all; anything else (openExternal, serial, hid, usb, …) is never grantable.
export const GRANTABLE: ReadonlySet<string> = new Set(['media', 'notifications', 'clipboard-sanitized-write', 'fullscreen', 'geolocation', 'display-capture'])

export type PermissionGrants = ReadonlyMap<string, ReadonlySet<string>>

export function parseGrants(json: string): PermissionGrants {
  const out = new Map<string, Set<string>>()
  let data: unknown
  try { data = JSON.parse(json) } catch { return out }
  if (!data || typeof data !== 'object' || Array.isArray(data)) return out
  for (const [origin, perms] of Object.entries(data as Record<string, unknown>)) {
    let u: URL
    try { u = new URL(origin) } catch { continue }
    if (u.protocol !== 'https:' || u.origin !== origin || !Array.isArray(perms)) continue
    const ok = perms.filter((p): p is string => typeof p === 'string' && GRANTABLE.has(p))
    if (ok.length) out.set(origin, new Set(ok))
  }
  return out
}

export function loadGrants(file = WEB_PERMISSIONS_FILE, read: (f: string) => string = (f) => readFileSync(f, 'utf8')): PermissionGrants {
  try { return parseGrants(read(file)) } catch { return new Map() }
}

export function permissionAllowed(grants: PermissionGrants, requestingUrl: string | undefined, permission: string): boolean {
  if (!requestingUrl) return false
  let origin: string
  try { const u = new URL(requestingUrl); if (u.protocol !== 'https:') return false; origin = u.origin } catch { return false }
  return grants.get(origin)?.has(permission) === true
}

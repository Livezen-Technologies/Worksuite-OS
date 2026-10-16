// Captive-portal detection (WSOS-INT-001). NetworkManager's connectivity check (live-build
// …/NetworkManager/conf.d/20-worksuite-connectivity.conf) reports none | portal | limited | full | unknown; the shell
// polls `nmcli -t networking connectivity` and this pure state machine decides when to notify, open the
// "Sign in to network" window and close it again. main.ts owns the Electron side (notification, sandboxed window).

export type Connectivity = 'none' | 'portal' | 'limited' | 'full' | 'unknown'
/** URL NetworkManager probes; also the page the sign-in window starts from (the portal intercepts it). */
export const CONNECTIVITY_CHECK_URL = 'http://network-test.debian.org/nm'
/** Path the agent's kill switch rules are written to while the managed VPN kill switch is loaded. */
export const KILLSWITCH_MARKER = '/run/worksuite-device-agent/vpn-killswitch.nft'

export function parseConnectivity(text: string): Connectivity {
  const v = text.trim().toLowerCase()
  return v === 'none' || v === 'portal' || v === 'limited' || v === 'full' ? v : 'unknown'
}

export interface PortalState { connectivity: Connectivity; windowOpen: boolean; notified: boolean }
export type PortalAction = 'notify_portal' | 'open_window' | 'close_window' | 'notify_blocked_by_killswitch' | 'notify_signed_in'
export const initialPortalState: PortalState = { connectivity: 'unknown', windowOpen: false, notified: false }

/**
 * One poll result → next state + actions.
 * - entering `portal`: notify once and open the sign-in window, unless the managed VPN kill switch is loaded; then
 *   the window could not reach the portal anyway, so explain instead (no exception is opened, see docs).
 * - `full` while the window is open: close it (and say so); the next portal episode notifies again.
 * - `user_closed` / `user_opened`: the window was closed by the user or reopened from the notification.
 */
export function portalStep(s: PortalState, ev: { connectivity: Connectivity; killSwitch: boolean } | 'user_closed' | 'user_opened'): { state: PortalState; actions: PortalAction[] } {
  if (ev === 'user_closed') return { state: { ...s, windowOpen: false }, actions: [] }
  if (ev === 'user_opened') {
    if (s.connectivity !== 'portal' || s.windowOpen) return { state: s, actions: [] }
    return { state: { ...s, windowOpen: true }, actions: ['open_window'] }
  }
  const { connectivity, killSwitch } = ev
  const actions: PortalAction[] = []
  let next: PortalState = { ...s, connectivity }
  if (connectivity === 'portal') {
    if (!s.notified) {
      next.notified = true
      if (killSwitch) actions.push('notify_blocked_by_killswitch')
      else { actions.push('notify_portal'); if (!s.windowOpen) { actions.push('open_window'); next.windowOpen = true } }
    }
  } else if (connectivity === 'full') {
    if (s.windowOpen) { actions.push('close_window', 'notify_signed_in'); next.windowOpen = false }
    next.notified = false
  } else if (connectivity === 'none') {
    next = { ...next, notified: false }   // left the network: a new portal later notifies again
  }
  return { state: next, actions }
}

/** Sign-in window navigation allowlist: http(s) only, no credentials in the URL, no local file/data/javascript. */
export function portalNavAllowed(raw: string): boolean {
  try {
    const u = new URL(raw)
    return (u.protocol === 'http:' || u.protocol === 'https:') && !u.username && !u.password
  } catch { return false }
}

// Settings › Network and the first-run network step (#42): what the Wi-Fi card says, and when the join form closes.
// The form follows NetworkManager's own state, not only nmcli's exit: a join that timed out in nmcli while
// NetworkManager went on to connect closes the form and drops the stale error as soon as the network shows connected.
import type { NetworkState } from './os'

export type WifiPhase = 'none' | 'off' | 'connected' | 'connecting' | 'disconnected'

/** The Wi-Fi device's phase from `nmcli device` (states "connecting (configuring)", "deactivating", …). */
export function wifiPhase(n: NetworkState): WifiPhase {
  const dev = n.devices.find((d) => d.type === 'wifi')
  if (!dev) return 'none'
  if (!n.wifi_enabled || dev.state === 'unavailable') return 'off'
  if (dev.state === 'connected' || n.networks.some((w) => w.in_use)) return 'connected'
  if (/^connecting/.test(dev.state)) return 'connecting'
  return 'disconnected'
}

export type Join = { ssid: string; secure: boolean; password: string; error: string | null; busy: boolean }

/** The join form after a network refresh: closed (and its error with it) once that SSID is the one in use. */
export function reconcileJoin(join: Join | null, n: NetworkState | null): Join | null {
  if (!join || !n) return join
  return n.networks.some((w) => w.in_use && w.ssid === join.ssid) ? null : join
}

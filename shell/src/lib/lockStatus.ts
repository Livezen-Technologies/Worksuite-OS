// Lock screen and greeter status (#25): what the Wi-Fi / battery indicators and the unread counts show. Pure, so the
// rules are tested without a bridge; StatusIndicators.tsx polls the bridge and draws them.
import type { Avail, BatteryState, NetworkState } from './os'
import type { Notice } from './syncNotices'

export type NetSummary =
  | { kind: 'wifi'; ssid: string | null; signal: number | null }
  | { kind: 'wired' }
  | { kind: 'off' }
  | { kind: 'disconnected' }
  | { kind: 'unknown' }

/** One connection summary from NetworkManager's device list: wired beats Wi-Fi, as NetworkManager routes it. */
export function netSummary(r: Avail<NetworkState> | null): NetSummary {
  if (!r || !r.available) return { kind: 'unknown' }
  const up = r.value.devices.filter((d) => d.state === 'connected')
  if (up.some((d) => d.type === 'ethernet')) return { kind: 'wired' }
  const wifi = up.find((d) => d.type === 'wifi')
  if (wifi) {
    const net = r.value.networks.find((n) => n.in_use) ?? r.value.networks.find((n) => n.ssid === wifi.connection)
    return { kind: 'wifi', ssid: wifi.connection ?? net?.ssid ?? null, signal: net ? net.signal : null }
  }
  return r.value.wifi_enabled ? { kind: 'disconnected' } : { kind: 'off' }
}

/** Wi-Fi strength in 0–3 bars (NetworkManager's 0–100 signal); null signal shows full bars. */
export function wifiBars(signal: number | null): 0 | 1 | 2 | 3 {
  if (signal == null) return 3
  return signal >= 67 ? 3 : signal >= 34 ? 2 : signal > 0 ? 1 : 0
}

export interface BatterySummary { percent: number | null; charging: boolean; full: boolean; low: boolean }

/** UPower's display device; null when the machine has no battery or UPower is unavailable (nothing is drawn). */
export function batterySummary(r: Avail<BatteryState> | null): BatterySummary | null {
  if (!r || !r.available || !r.value.present) return null
  const b = r.value
  const percent = b.percentage == null ? null : Math.max(0, Math.min(100, Math.round(b.percentage)))
  const full = b.state === 'fully-charged'
  // Only a battery that says so is charging: on AC at a charge threshold ("pending-charge") it is just plugged in,
  // as the taskbar and Settings › Power say (#43).
  const charging = !b.on_battery && b.state === 'charging'
  return { percent, charging, full, low: b.on_battery && percent != null && percent <= 15 }
}

// App names that carry messages (WorkSuite Mail and Chat, and the messengers users install from the App Center).
const MESSAGE_APP = /mail|chat|messag|talk|thunderbird|evolution|geary|whatsapp|telegram|signal|teams|slack|element|matrix/i

export const isMessage = (n: Pick<Notice, 'app'>): boolean => !!n.app && MESSAGE_APP.test(n.app)

/**
 * Unread counts for the lock screen: the `unread` newest notices are the ones nobody has opened the centre for
 * (useNotices puts fresh ones on top and counts them). Only numbers leave here, never a title or body.
 */
export function unreadCounts(notices: readonly Pick<Notice, 'app'>[], unread: number): { messages: number; notifications: number } {
  const fresh = notices.slice(0, Math.max(0, Math.min(unread, notices.length)))
  const messages = fresh.filter(isMessage).length
  return { messages, notifications: fresh.length - messages }
}

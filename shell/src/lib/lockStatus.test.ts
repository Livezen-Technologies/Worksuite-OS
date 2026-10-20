// #25: the lock screen's Wi-Fi / battery indicators and unread counts follow NetworkManager, UPower and the centre.
import { describe, expect, it } from 'vitest'
import { batterySummary, netSummary, unreadCounts, wifiBars } from './lockStatus'

const net = (devices: { device: string; type: string; state: string; connection: string | null }[], wifi_enabled = true, networks = [{ ssid: 'Office', signal: 50, security: 'WPA2', in_use: true }]) =>
  ({ available: true as const, value: { wifi_enabled, devices, networks } })
const bat = (v: Partial<{ present: boolean; percentage: number | null; state: string; on_battery: boolean }>) =>
  ({ available: true as const, value: { present: true, percentage: 50, state: 'discharging', on_battery: true, time_to_full_s: null, time_to_empty_s: null, ...v } })

describe('netSummary', () => {
  it('reports the connected Wi-Fi network and its signal', () => {
    expect(netSummary(net([{ device: 'wlan0', type: 'wifi', state: 'connected', connection: 'Office' }]))).toEqual({ kind: 'wifi', ssid: 'Office', signal: 50 })
  })
  it('prefers a wired link, and tells off from disconnected', () => {
    expect(netSummary(net([{ device: 'eth0', type: 'ethernet', state: 'connected', connection: 'Wired' }, { device: 'wlan0', type: 'wifi', state: 'connected', connection: 'Office' }])).kind).toBe('wired')
    expect(netSummary(net([{ device: 'wlan0', type: 'wifi', state: 'disconnected', connection: null }])).kind).toBe('disconnected')
    expect(netSummary(net([], false)).kind).toBe('off')
    expect(netSummary({ available: false, reason: 'service_unavailable' }).kind).toBe('unknown')
    expect(netSummary(null).kind).toBe('unknown')
  })
  it('maps signal to bars', () => {
    expect([wifiBars(90), wifiBars(50), wifiBars(10), wifiBars(0), wifiBars(null)]).toEqual([3, 2, 1, 0, 3])
  })
})

describe('batterySummary', () => {
  it('hides without a battery', () => {
    expect(batterySummary(bat({ present: false }))).toBeNull()
    expect(batterySummary({ available: false, reason: 'no_battery' })).toBeNull()
  })
  it('reads charging, full and low', () => {
    expect(batterySummary(bat({ state: 'charging', on_battery: false, percentage: 73.6 }))).toEqual({ percent: 74, charging: true, full: false, low: false })
    expect(batterySummary(bat({ state: 'fully-charged', on_battery: false, percentage: 100 }))?.full).toBe(true)
    expect(batterySummary(bat({ percentage: 9 }))).toEqual({ percent: 9, charging: false, full: false, low: true })
  })
})

describe('unreadCounts', () => {
  const list = [{ app: 'WorkSuite Mail' }, { app: 'Firefox' }, { app: 'WhatsApp' }, {}]
  it('counts only the unread newest notices, split into messages and the rest', () => {
    expect(unreadCounts(list, 3)).toEqual({ messages: 2, notifications: 1 })
    expect(unreadCounts(list, 0)).toEqual({ messages: 0, notifications: 0 })
    expect(unreadCounts(list, 99)).toEqual({ messages: 2, notifications: 2 })
  })
})

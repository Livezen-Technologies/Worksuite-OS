// #42: the Wi-Fi card follows NetworkManager, and the join form closes on a confirmed connection.
import { describe, expect, it } from 'vitest'
import { reconcileJoin, wifiPhase } from './wifiState'
import type { NetworkState } from './os'

const net = (state: string, inUse?: string, enabled = true): NetworkState => ({
  wifi_enabled: enabled,
  devices: [{ device: 'wlp2s0', type: 'wifi', state, connection: inUse ?? null }],
  networks: [{ ssid: 'Office', signal: 70, security: 'WPA2', in_use: inUse === 'Office' }, { ssid: 'Cafe', signal: 30, security: '', in_use: false }],
})

describe('wifiPhase', () => {
  it('reads connecting, connected, disconnected and off', () => {
    expect(wifiPhase(net('connecting (getting IP configuration)'))).toBe('connecting')
    expect(wifiPhase(net('connected', 'Office'))).toBe('connected')
    expect(wifiPhase(net('disconnected'))).toBe('disconnected')
    expect(wifiPhase(net('unavailable', undefined, false))).toBe('off')
    expect(wifiPhase({ wifi_enabled: true, devices: [], networks: [] })).toBe('none')
  })
})

describe('reconcileJoin', () => {
  const join = { ssid: 'Office', secure: true, password: '', error: 'Timed out', busy: false }
  it('closes the form and its stale timeout once that network is in use', () => {
    expect(reconcileJoin(join, net('connected', 'Office'))).toBeNull()
  })
  it('keeps it while that network is not connected', () => {
    expect(reconcileJoin(join, net('connecting (configuring)'))).toBe(join)
    expect(reconcileJoin({ ...join, ssid: 'Cafe' }, net('connected', 'Office'))?.ssid).toBe('Cafe')
    expect(reconcileJoin(null, net('connected', 'Office'))).toBeNull()
  })
})

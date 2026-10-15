import { describe, expect, it } from 'vitest'
import {
  parseBtDevices, parseBtShow, parseLpstat, parseNmDevices, parseUdisksStatus, parseUpowerBattery, parseWifiList,
  parseWlrRandr, parseWpStatus, parseWpVolume, splitTerse, systemBridge, type Exec,
} from './system'

describe('nmcli', () => {
  it('splits terse output with escapes', () => {
    expect(splitTerse('*:My\\:Net:70:WPA2')).toEqual(['*', 'My:Net', '70', 'WPA2'])
  })
  it('parses wifi list, dedupes and sorts', () => {
    const out = parseWifiList(' :Cafe:40:--\n*:Office:55:WPA2 802.1X\n :Office:80:WPA2 802.1X\n :Home:90:WPA2\n ::30:WPA2\n')
    expect(out).toEqual([
      { ssid: 'Office', signal: 55, security: 'WPA2 802.1X', in_use: true },
      { ssid: 'Home', signal: 90, security: 'WPA2', in_use: false },
      { ssid: 'Cafe', signal: 40, security: '', in_use: false },
    ])
  })
  it('parses devices', () => {
    expect(parseNmDevices('wlan0:wifi:connected:Office\neth0:ethernet:unavailable:--\nlo:loopback:unmanaged:--\n')).toEqual([
      { device: 'wlan0', type: 'wifi', state: 'connected', connection: 'Office' },
      { device: 'eth0', type: 'ethernet', state: 'unavailable', connection: null },
    ])
  })
})

describe('bluetoothctl', () => {
  it('parses show', () => {
    expect(parseBtShow('Controller 00:1A:7D:DA:71:13 (public)\n\tName: host\n\tAlias: LZT-LAP\n\tPowered: yes\n\tDiscoverable: no\n'))
      .toEqual({ powered: true, name: 'LZT-LAP', discoverable: false })
    expect(parseBtShow('No default controller available\n')).toBeNull()
  })
  it('parses devices', () => {
    expect(parseBtDevices('Device AA:BB:CC:DD:EE:FF MX Keys\nDevice 11:22:33:44:55:66\n')).toEqual([
      { address: 'AA:BB:CC:DD:EE:FF', name: 'MX Keys' }, { address: '11:22:33:44:55:66', name: '11:22:33:44:55:66' },
    ])
  })
})

describe('wpctl', () => {
  it('parses volume', () => {
    expect(parseWpVolume('Volume: 0.60\n')).toEqual({ volume: 60, muted: false })
    expect(parseWpVolume('Volume: 0.35 [MUTED]\n')).toEqual({ volume: 35, muted: true })
    expect(parseWpVolume('error')).toBeNull()
  })
  it('parses status sinks and sources', () => {
    const s = `PipeWire 'pipewire-0' [1.2.7, user@host, cookie:1]
 └─ Clients:
        33. WirePlumber

Audio
 ├─ Devices:
 │      42. Built-in Audio                      [alsa]
 │
 ├─ Sinks:
 │  *   46. Built-in Audio Analog Stereo        [vol: 0.60]
 │      51. HDMI Output                         [vol: 1.00]
 │
 ├─ Sources:
 │  *   47. Built-in Audio Analog Stereo        [vol: 1.00]
 │
 ├─ Filters:
 │
 └─ Streams:

Video
 ├─ Sinks:
 │      70. Fake video
`
    expect(parseWpStatus(s)).toEqual({
      outputs: [{ id: 46, name: 'Built-in Audio Analog Stereo', is_default: true }, { id: 51, name: 'HDMI Output', is_default: false }],
      inputs: [{ id: 47, name: 'Built-in Audio Analog Stereo', is_default: true }],
    })
  })
})

describe('upower', () => {
  it('parses battery', () => {
    const b = parseUpowerBattery(`  native-path:          BAT0
  power supply:         yes
  battery
    present:             yes
    state:               charging
    time to full:        1.3 hours
    percentage:          74%
`)
    expect(b).toEqual({ present: true, percentage: 74, state: 'charging', time_to_full_s: 4680, time_to_empty_s: null, on_battery: false })
  })
})

describe('lpstat', () => {
  it('parses printers and default', () => {
    expect(parseLpstat('printer HP_M507 is idle.  enabled since Mon\nprinter Lab now printing Lab-12.  enabled since Mon\nprinter Old disabled since Mon -\n\treason unknown\nsystem default destination: HP_M507\n')).toEqual([
      { name: 'HP_M507', state: 'idle', is_default: true },
      { name: 'Lab', state: 'printing', is_default: false },
      { name: 'Old', state: 'disabled', is_default: false },
    ])
  })
})

describe('wlr-randr', () => {
  it('parses json', () => {
    const j = JSON.stringify([{ name: 'eDP-1', description: 'BOE 0x0BCA', enabled: true, scale: 1.25,
      modes: [{ width: 1920, height: 1200, refresh: 60.001, preferred: true, current: true }, { width: 1280, height: 800, refresh: 60, current: false }] }])
    expect(parseWlrRandr(j)).toEqual([{ name: 'eDP-1', description: 'BOE 0x0BCA', enabled: true, width: 1920, height: 1200, refresh: 60, scale: 1.25 }])
    expect(parseWlrRandr('nope')).toEqual([])
  })
})

describe('udisksctl', () => {
  it('parses status', () => {
    const s = `MODEL                     REVISION  SERIAL               DEVICE
--------------------------------------------------------------------------
Samsung SSD 980 1TB       3B4QFXO7  S64ANS0T123456       nvme0n1
SanDisk Ultra             1.00      4C530001             sda
`
    expect(parseUdisksStatus(s)).toEqual([
      { model: 'Samsung SSD 980 1TB', serial: 'S64ANS0T123456', device: 'nvme0n1' },
      { model: 'SanDisk Ultra', serial: '4C530001', device: 'sda' },
    ])
  })
})

describe('bridge', () => {
  it('reports unavailable when a tool is missing', async () => {
    const exec: Exec = async () => ({ code: 1, stdout: '', stderr: '', missing: true })
    const b = systemBridge(exec, async () => ({ code: 1, stderr: 'spawn_failed' }))
    expect(await b.network()).toEqual({ available: false, reason: 'nmcli_missing' })
    expect(await b.displays()).toEqual({ available: false, reason: 'wlr-randr_missing' })
    expect(await b.wifiConnect('Office', 'x')).toEqual({ ok: false, error: 'unavailable' })
  })
  it('sends the wifi password on stdin only', async () => {
    const calls: { args: string[]; input: string }[] = []
    const b = systemBridge(async () => ({ code: 0, stdout: '', stderr: '' }), async (_c, args, input) => { calls.push({ args, input }); return { code: 0, stderr: '' } })
    expect(await b.wifiConnect('Office', 's3cret')).toEqual({ ok: true })
    expect(calls[0].args).not.toContain('s3cret')
    expect(calls[0].args).toContain('--ask')
    expect(calls[0].input).toBe('s3cret\n')
    expect(await b.wifiConnect('bad\nssid', 'x')).toEqual({ ok: false, error: 'invalid_argument' })
  })
  it('clamps volume and treats no printers as empty', async () => {
    const seen: string[][] = []
    const b = systemBridge(async (cmd, args) => { seen.push([cmd, ...args]); return cmd === 'lpstat' ? { code: 1, stdout: '', stderr: 'lpstat: No destinations added.' } : { code: 0, stdout: '', stderr: '' } })
    await b.setVolume(140)
    expect(seen[0]).toEqual(['wpctl', 'set-volume', '@DEFAULT_AUDIO_SINK@', '100%'])
    expect(await b.printers()).toEqual({ available: true, value: [] })
  })
  it('reports no battery on desktops', async () => {
    const b = systemBridge(async () => ({ code: 0, stdout: '/org/freedesktop/UPower/devices/line_power_AC\n/org/freedesktop/UPower/devices/DisplayDevice\n', stderr: '' }))
    expect(await b.battery()).toEqual({ available: false, reason: 'no_battery' })
  })
})

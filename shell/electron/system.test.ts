import { describe, expect, it } from 'vitest'
import {
  parseBtDevices, parseBtShow, parseLpstat, parseNmDevices, parseUdisksStatus, parseUpowerBattery, batteryFrom, parsePowerSupplyUevent, parseWifiList,
  parseWlrRandr, parseWpStatus, parseWpVolume, splitTerse, systemBridge, parseWifiProfiles, wifiConnectError, type Exec,
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

// `upower -d` on a real laptop (upower 1.90, trixie): a Logitech mouse battery listed before the laptop's, the
// laptop battery still saying "pending-charge" seconds after the charger was pulled, and the daemon on battery (#43).
const dump = (onBattery: 'yes' | 'no', acOnline: 'yes' | 'no', batState: string) => `Device: /org/freedesktop/UPower/devices/battery_hidpp_battery_0
  native-path:          hidpp_battery_0
  model:                MX Master 3
  power supply:         no
  updated:              Tue 20 Oct 2026 10:00:00
  battery
    present:             yes
    state:               discharging
    percentage:          55%

Device: /org/freedesktop/UPower/devices/line_power_AC
  native-path:          AC
  power supply:         yes
  line-power
    warning-level:       none
    online:              ${acOnline}
    icon-name:          'ac-adapter-symbolic'

Device: /org/freedesktop/UPower/devices/battery_BAT0
  native-path:          BAT0
  vendor:               SMP
  power supply:         yes
  has history:          yes
  battery
    present:             yes
    rechargeable:        yes
    state:               ${batState}
    warning-level:       none
    energy:              31.2 Wh
    time to empty:       2.4 hours
    time to full:        50.0 minutes
    percentage:          67%
    capacity:            91.2%

Device: /org/freedesktop/UPower/devices/DisplayDevice
  power supply:         yes
  battery
    present:             yes
    state:               ${batState}
    percentage:          67%

Daemon:
  daemon-version:  1.90.2
  on-battery:      ${onBattery}
  lid-is-closed:   no
  lid-is-present:  yes
  critical-action: PowerOff
`

describe('batteryFrom (#43)', () => {
  it('on battery although the battery still says pending-charge; ignores the mouse', () => {
    expect(batteryFrom(dump('yes', 'no', 'pending-charge'), [])).toEqual({ present: true, percentage: 67, state: 'discharging', time_to_full_s: null, time_to_empty_s: 8640, on_battery: true })
  })
  it('charging and plugged in', () => {
    expect(batteryFrom(dump('no', 'yes', 'charging'), [])).toMatchObject({ state: 'charging', on_battery: false, time_to_full_s: 3000, time_to_empty_s: null })
    expect(batteryFrom(dump('no', 'yes', 'pending-charge'), [])).toMatchObject({ state: 'pending-charge', on_battery: false })
    // A stale "discharging" on AC is plugged in, not on battery.
    expect(batteryFrom(dump('no', 'yes', 'discharging'), [])).toMatchObject({ state: 'pending-charge', on_battery: false })
  })
  it('without the daemon line, uses line power, then the kernel AC', () => {
    const noDaemon = dump('yes', 'no', 'unknown').replace(/Daemon:[\s\S]*$/, '')
    expect(batteryFrom(noDaemon, [])?.on_battery).toBe(true)
    const noAc = noDaemon.replace(/Device: \/org\/freedesktop\/UPower\/devices\/line_power_AC[\s\S]*?\n\n/, '')
    const ac = (online: string) => [parsePowerSupplyUevent('ADP1', `POWER_SUPPLY_TYPE=Mains\nPOWER_SUPPLY_ONLINE=${online}\n`), parsePowerSupplyUevent('hid-mouse', 'POWER_SUPPLY_TYPE=Battery\nPOWER_SUPPLY_SCOPE=Device\nPOWER_SUPPLY_ONLINE=1\n')]
    expect(batteryFrom(noAc, ac('0'))?.on_battery).toBe(true)
    expect(batteryFrom(noAc, ac('1'))).toMatchObject({ on_battery: false, state: 'unknown' })
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
  // #42 on a real laptop: nmcli's -w 45 expired while NetworkManager was still in its DHCP step; it connected a few
  // seconds later, yet the UI kept the form and a "timeout" error.
  const nm = (o: { saved?: boolean; states: string[]; inUse?: string }) => {
    const seen: string[][] = []
    let poll = 0
    const exec: Exec = async (_c, args) => {
      seen.push(args)
      const a = args.join(' ')
      if (a === '-t -f NAME,UUID,TYPE connection show') return { code: 0, stdout: o.saved ? 'Office:0b6f-uuid:802-11-wireless\nWired connection 1:7c1e-uuid:802-3-ethernet\n' : 'Wired connection 1:7c1e-uuid:802-3-ethernet\n', stderr: '' }
      if (a === '-g 802-11-wireless.ssid connection show uuid 0b6f-uuid') return { code: 0, stdout: 'Office\n', stderr: '' }
      if (a.startsWith('-t -f DEVICE,TYPE,STATE,CONNECTION device')) { const st = o.states[Math.min(poll++, o.states.length - 1)]; return { code: 0, stdout: `wlp2s0:wifi:${st}:Office\nlo:loopback:connected (externally):lo\n`, stderr: '' } }
      if (a.startsWith('-t -f IN-USE,SSID,SIGNAL,SECURITY device wifi list')) return { code: 0, stdout: `${o.inUse === 'Office' ? '*' : ' '}:Office:78:WPA2\n :Cafe:40:WPA2\n`, stderr: '' }
      if (a.startsWith('-w 45 connection up')) return { code: 1, stdout: '', stderr: 'Error: Timeout expired (45 seconds)' }
      return { code: 0, stdout: '', stderr: '' }
    }
    const stdin: string[][] = []
    const b = systemBridge(exec, async (_c, args) => { stdin.push(args); return { code: 1, stderr: 'Error: Timeout expired (45 seconds)' } }, undefined, () => [], async () => undefined)
    return { b, seen, stdin }
  }
  it('#42: a timeout while NetworkManager is still activating is not an error', async () => {
    expect(await nm({ states: ['connecting (getting IP configuration)', 'connected'], inUse: 'Office' }).b.wifiConnect('Office', 's3cret')).toEqual({ ok: true })
    expect(await nm({ states: ['connecting (configuring)'] }).b.wifiConnect('Office', 's3cret')).toEqual({ ok: true, pending: true })
    expect(await nm({ states: ['disconnected'] }).b.wifiConnect('Office', 's3cret')).toEqual({ ok: false, error: 'timeout' })
  })
  it('#42: a saved network joins with its stored secret; a new password replaces the profile', async () => {
    const a = nm({ saved: true, states: ['connected'], inUse: 'Office' })
    expect(await a.b.wifiConnect('Office', '')).toEqual({ ok: true })
    expect(a.seen).toContainEqual(['-w', '45', 'connection', 'up', 'uuid', '0b6f-uuid'])
    expect(a.stdin).toEqual([])
    const c = nm({ saved: true, states: ['disconnected'] })
    await c.b.wifiConnect('Office', 'n3w')
    expect(c.seen).toContainEqual(['connection', 'delete', 'uuid', '0b6f-uuid'])
    expect(c.stdin[0]).toEqual(['--ask', '-w', '45', 'device', 'wifi', 'connect', 'Office'])
  })
  it('#42: marks saved networks', async () => {
    const v = await nm({ saved: true, states: ['disconnected'] }).b.network()
    expect(v.available && v.value.networks.map((w) => [w.ssid, w.saved])).toEqual([['Office', true], ['Cafe', false]])
  })
  it('#42: parses saved Wi-Fi profiles', () => {
    expect(parseWifiProfiles('Office:0b6f:802-11-wireless\nVPN:1:vpn\nHome\\:5G:2:802-11-wireless\n')).toEqual([{ name: 'Office', uuid: '0b6f' }, { name: 'Home:5G', uuid: '2' }])
  })
  it('Wi-Fi: unblocks the radio before turning it on, rescans, disconnects the network in use (#31)', async () => {
    const seen: string[][] = []
    const b = systemBridge(async (cmd, args) => {
      seen.push([cmd, ...args])
      if (args.includes('DEVICE,TYPE,STATE,CONNECTION')) return { code: 0, stdout: 'wlan0:wifi:connected:Office\neth0:ethernet:unavailable:--\n', stderr: '' }
      if (args[1] === 'wifi' && args[2] === 'rescan') return { code: 1, stdout: '', stderr: 'Error: Scanning not allowed immediately following previous scan.' }
      return { code: 0, stdout: '', stderr: '' }
    })
    expect(await b.setWifi(true)).toEqual({ available: true, value: true })
    expect(seen.slice(0, 2)).toEqual([['rfkill', 'unblock', 'wlan'], ['nmcli', 'radio', 'wifi', 'on']])
    seen.length = 0
    await b.setWifi(false)
    expect(seen).toEqual([['nmcli', 'radio', 'wifi', 'off']])
    expect(await b.wifiRescan()).toEqual({ available: true, value: true })
    seen.length = 0
    expect(await b.wifiDisconnect()).toEqual({ available: true, value: true })
    expect(seen[1]).toEqual(['nmcli', 'device', 'disconnect', 'wlan0'])
    const idle = systemBridge(async () => ({ code: 0, stdout: 'wlan0:wifi:disconnected:--\n', stderr: '' }))
    expect(await idle.wifiDisconnect()).toEqual({ available: false, reason: 'not_connected' })
  })
  it('Wi-Fi connect errors say what went wrong', () => {
    expect(wifiConnectError('Error: Connection activation failed: Secrets were required, but not provided.')).toBe('bad_password')
    expect(wifiConnectError('Error: No network with SSID \'Cafe\' found.')).toBe('not_found')
    expect(wifiConnectError('Error: No Wi-Fi device found.')).toBe('no_adapter')
    expect(wifiConnectError('Error: Timeout expired (45 seconds)')).toBe('timeout')
    expect(wifiConnectError('Error: something else')).toBe('connect_failed')
  })
  it('Bluetooth: a stopped bluetoothd is reported, not waited for; a blocked controller is unblocked or reported (#31)', async () => {
    const stopped = systemBridge(async (cmd) => (cmd === 'systemctl' ? { code: 1, stdout: 'inactive\n', stderr: '' } : { code: 0, stdout: '', stderr: '' }))
    expect(await stopped.bluetooth()).toEqual({ available: false, reason: 'service_stopped' })
    const seen: string[][] = []
    const blocked = systemBridge(async (cmd, args) => { seen.push([cmd, ...args]); return cmd === 'bluetoothctl' ? { code: 0, stdout: 'Failed to set power on: org.bluez.Error.Blocked\n', stderr: '' } : { code: 0, stdout: '', stderr: '' } })
    expect(await blocked.setBluetooth(true)).toEqual({ available: false, reason: 'blocked' })
    expect(seen).toEqual([['rfkill', 'unblock', 'bluetooth'], ['bluetoothctl', 'power', 'on']])
  })
  it('clamps volume and treats no printers as empty', async () => {
    const seen: string[][] = []
    const b = systemBridge(async (cmd, args) => { seen.push([cmd, ...args]); return cmd === 'lpstat' ? { code: 1, stdout: '', stderr: 'lpstat: No destinations added.' } : { code: 0, stdout: '', stderr: '' } })
    await b.setVolume(140)
    expect(seen[0]).toEqual(['wpctl', 'set-volume', '@DEFAULT_AUDIO_SINK@', '100%'])
    expect(await b.printers()).toEqual({ available: true, value: [] })
  })
  it('reports no battery on desktops', async () => {
    const b = systemBridge(async () => ({ code: 0, stdout: 'Device: /org/freedesktop/UPower/devices/line_power_AC\n  power supply:         yes\n  line-power\n    online:              yes\n\nDaemon:\n  on-battery:      no\n', stderr: '' }), undefined, undefined, () => [])
    expect(await b.battery()).toEqual({ available: false, reason: 'no_battery' })
  })
  it('#43: reads the battery from sysfs when UPower is missing', async () => {
    const b = systemBridge(async () => ({ code: 1, stdout: '', stderr: '', missing: true }), undefined, undefined, () => [
      parsePowerSupplyUevent('AC', 'POWER_SUPPLY_NAME=AC\nPOWER_SUPPLY_TYPE=Mains\nPOWER_SUPPLY_ONLINE=0\n'),
      parsePowerSupplyUevent('BAT0', 'POWER_SUPPLY_NAME=BAT0\nPOWER_SUPPLY_TYPE=Battery\nPOWER_SUPPLY_STATUS=Discharging\nPOWER_SUPPLY_PRESENT=1\nPOWER_SUPPLY_CAPACITY=62\n'),
    ])
    expect(await b.battery()).toEqual({ available: true, value: { present: true, percentage: 62, state: 'discharging', time_to_full_s: null, time_to_empty_s: null, on_battery: true } })
    const none = systemBridge(async () => ({ code: 1, stdout: '', stderr: '', missing: true }), undefined, undefined, () => [])
    expect(await none.battery()).toEqual({ available: false, reason: 'upower_missing' })
  })
})

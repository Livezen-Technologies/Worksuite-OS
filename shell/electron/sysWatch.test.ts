import { describe, expect, it, vi } from 'vitest'
import dbus from 'dbus-next'
import { SYS_MATCH_RULES, debouncer, startSysWatch, sysChangeKind } from './sysWatch'

describe('live taskbar status (#28)', () => {
  it('maps service signals to the state they change', () => {
    expect(sysChangeKind({ path: '/org/freedesktop/NetworkManager/Devices/3', interface: 'org.freedesktop.DBus.Properties', member: 'PropertiesChanged' })).toBe('network')
    expect(sysChangeKind({ path: '/org/freedesktop/NetworkManager', interface: 'org.freedesktop.NetworkManager', member: 'StateChanged' })).toBe('network')
    expect(sysChangeKind({ path: '/org/bluez/hci0/dev_AA_BB', interface: 'org.freedesktop.DBus.Properties', member: 'PropertiesChanged' })).toBe('bluetooth')
    expect(sysChangeKind({ path: '/', interface: 'org.freedesktop.DBus.ObjectManager', member: 'InterfacesAdded', body: ['/org/bluez/hci0/dev_CC'] })).toBe('bluetooth')
    expect(sysChangeKind({ path: '/org/freedesktop/UPower/devices/battery_BAT0', interface: 'org.freedesktop.DBus.Properties', member: 'PropertiesChanged' })).toBe('battery')
    expect(sysChangeKind({ path: '/org/freedesktop/login1', interface: 'org.freedesktop.login1.Manager', member: 'PrepareForSleep' })).toBeNull()
    expect(sysChangeKind({ path: '/', member: 'InterfacesAdded', body: ['/org/other'] })).toBeNull()
  })

  it('coalesces bursts into one update per kind', () => {
    vi.useFakeTimers()
    const got: string[] = []
    const d = debouncer((k) => got.push(k), 400)
    d.push('network'); d.push('network'); d.push('battery'); d.push('network')
    vi.advanceTimersByTime(399); expect(got).toEqual([])
    vi.advanceTimersByTime(1); expect(got.sort()).toEqual(['battery', 'network'])
    d.push('network'); d.stop(); vi.advanceTimersByTime(1000); expect(got).toHaveLength(2)
    vi.useRealTimers()
  })

  it('subscribes to the three services and broadcasts their changes', async () => {
    vi.useFakeTimers()
    const calls: string[] = []
    let onMsg: (m: never) => void = () => {}
    const bus = {
      call: async (m: InstanceType<typeof dbus.Message>) => { calls.push(String((m.body as string[])[0])); return null },
      on: (e: string, cb: (m: never) => void) => { if (e === 'message') onMsg = cb },
    }
    const sent: unknown[][] = []
    const stop = await startSysWatch((ch, p) => sent.push([ch, p]), bus as never)
    expect(calls).toEqual(SYS_MATCH_RULES)
    onMsg({ type: dbus.MessageType.SIGNAL, path: '/org/freedesktop/UPower/devices/line_power_AC', member: 'PropertiesChanged' } as never)
    onMsg({ type: dbus.MessageType.METHOD_RETURN, path: '/org/bluez/hci0' } as never)
    vi.advanceTimersByTime(500)
    expect(sent).toEqual([['ws:sysChanged', 'battery']])
    stop()
    vi.useRealTimers()
  })
})

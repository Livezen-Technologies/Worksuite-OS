import { describe, expect, it } from 'vitest'
import type { HwDevice } from './os'
import { deviceStatus, deviceSub, driversInUse, groupDevices, newDevices, offerLocked, offerTag, offerVersion } from './hardware'

const D = (id: string, p: Partial<HwDevice> = {}): HwDevice => ({ id, name: id, vendor: null, kind: 'other', bus: 'usb', built_in: false, driver: 'usbhid', driver_version: null, driver_proprietary: false, ids: '0:0', ...p })

describe('hardware view', () => {
  it('groups connected before built in and drops empty groups', () => {
    expect(groupDevices([D('b', { built_in: true, bus: 'pci' }), D('a')]).map((g) => [g.name, g.items.map((d) => d.id)])).toEqual([['Connected', ['a']], ['Built in', ['b']]])
    expect(groupDevices([D('b', { built_in: true })]).map((g) => g.name)).toEqual(['Built in'])
  })
  it('status and subtitle come from the device', () => {
    expect(deviceStatus(D('x', { driver: null })).label).toBe('No driver in use')
    expect(deviceSub(D('x', { kind: 'camera', vendor: 'Acme' }))).toBe('Camera · USB · Acme')
  })
  it('new devices only after the first poll, never built-in', () => {
    expect(newDevices(null, [D('a')])).toEqual([])
    expect(newDevices([D('a')], [D('a'), D('b'), D('c', { built_in: true })]).map((d) => d.id)).toEqual(['b'])
  })
  it('drivers in use, one per module', () => {
    expect(driversInUse([D('a', { name: 'Kbd' }), D('b', { name: 'Mouse' }), D('c', { driver: null })])).toEqual([{ driver: 'usbhid', version: null, proprietary: false, devices: ['Kbd', 'Mouse'] }])
  })
  it('offer tags', () => {
    const o = { id: 'x', device_id: null, name: 'n', summary: '', from_version: null, to_version: '2', license: 'proprietary' as const, category: 'optional' as const, size_bytes: null, restart: false }
    expect(offerTag(o).tag).toBe('PROPRIETARY')
    expect(offerVersion(o)).toBe('new · 2')
    expect(offerLocked({ ...o, category: 'security' })).toBe(true)
  })
})

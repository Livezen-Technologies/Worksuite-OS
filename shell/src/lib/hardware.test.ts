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

describe('driver job phases (#45)', () => {
  it('splits "<offer>|<step>" and reads older offer-only phases as installing', async () => {
    const { driverJobPhase } = await import('./hardware')
    expect(driverJobPhase('fwupd:0123|downloading')).toEqual({ offer: 'fwupd:0123', step: 'downloading' })
    expect(driverJobPhase('fw:firmware-iwlwifi|done')).toEqual({ offer: 'fw:firmware-iwlwifi', step: 'done' })
    expect(driverJobPhase('gpu:nvidia-driver')).toEqual({ offer: 'gpu:nvidia-driver', step: 'installing' })
    expect(driverJobPhase('fw:firmware-realtek|failed')).toEqual({ offer: 'fw:firmware-realtek', step: 'failed' })
  })
  it('names why a driver did not install, from the service\'s real errors (#59)', async () => {
    const { driverFailureText } = await import('./hardware')
    expect(driverFailureText('/etc/apt/sources.list: missing Signed-By')).toMatch(/software source/)
    expect(driverFailureText("apt-get update: E: Failed to fetch https://deb.debian.org/debian/dists/trixie/InRelease  Temporary failure resolving 'deb.debian.org'")).toMatch(/couldn’t be reached/)
    expect(driverFailureText("apt-get: E: Package 'firmware-x' has no installation candidate")).toMatch(/isn’t available/)
    expect(driverFailureText('apt-get: dpkg: error processing package firmware-x (--configure):')).toBe('It couldn’t be installed.')
  })
  it('#69: names the stage (sources check, download, install) and the source that blocks installs', async () => {
    const { driverFailureKind, driverFailureText, driverFailureTitle } = await import('./hardware')
    const src = '/etc/apt/sources.list.d/vendor.list: repository ppa.example.com is not an approved source'
    expect(driverFailureKind(src)).toBe('sources')
    expect(driverFailureTitle('sources')).toBe('Software source not approved')
    expect(driverFailureText(src)).toContain('/etc/apt/sources.list.d/vendor.list isn’t signed or approved')
    expect(driverFailureText(src)).toContain('Try again')
    expect(driverFailureKind('/etc/apt/sources.list: trusted=yes turns off signature checks')).toBe('sources')
    expect(driverFailureKind("apt-get update: E: Failed to fetch https://deb.debian.org/x  Temporary failure resolving 'deb.debian.org'")).toBe('download')
    expect(driverFailureKind('apt-get: dpkg: error processing package tp-smapi-dkms (--configure):')).toBe('install')
    expect(driverFailureKind('anything', 'downloading')).toBe('download')
  })
})

import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { listDevices, pciNames } from './hardware'

describe('listDevices (sysfs)', () => {
  let root: string
  const put = (rel: string, files: Record<string, string>, driver?: string) => {
    const d = path.join(root, rel)
    mkdirSync(d, { recursive: true })
    for (const [k, v] of Object.entries(files)) writeFileSync(path.join(d, k), v + '\n')
    if (driver) { mkdirSync(path.join(root, 'drivers', driver), { recursive: true }); symlinkSync(path.join(root, 'drivers', driver), path.join(d, 'driver')) }
  }
  beforeEach(() => {
    root = mkdtempSync(path.join(tmpdir(), 'ws-hw-'))
    const usb = 'sys/bus/usb/devices'
    put(`${usb}/1-2`, { idVendor: '046d', idProduct: '082d', product: 'HD Pro Webcam C920', manufacturer: 'Logitech', removable: 'removable' })
    put(`${usb}/1-2/1-2:1.0`, { bInterfaceClass: '0e', bInterfaceProtocol: '00' }, 'uvcvideo')
    put(`${usb}/1-3`, { idVendor: '03f0', idProduct: '0001' })
    put(`${usb}/1-3/1-3:1.0`, { bInterfaceClass: '07', bInterfaceProtocol: '02' })
    put(`${usb}/1-1`, { idVendor: '05e3', idProduct: '0610', product: 'Hub' })
    put(`${usb}/1-1/1-1:1.0`, { bInterfaceClass: '09', bInterfaceProtocol: '00' }, 'hub')
    put(`${usb}/usb1`, { idVendor: '1d6b', idProduct: '0002' })
    put('sys/bus/pci/devices/0000:00:14.3', { class: '0x028000', vendor: '0x8086', device: '0xa0f0' }, 'iwlwifi')
    put('sys/bus/pci/devices/0000:00:00.0', { class: '0x060000', vendor: '0x8086', device: '0x9a14' })
    put('sys/module/iwlwifi', { version: '' })
    mkdirSync(path.join(root, 'usr/share/misc'), { recursive: true })
    writeFileSync(path.join(root, 'usr/share/misc/pci.ids'), '# x\n8086  Intel Corporation\n\ta0f0  Wi-Fi 6 AX201\n\t\t8086 0244  sub\n10de  NVIDIA\n')
  })
  afterEach(() => rmSync(root, { recursive: true, force: true }))

  it('lists real devices with their bound driver, skipping hubs and bridges', () => {
    const d = listDevices(root)
    expect(d.map((x) => x.id).sort()).toEqual(['pci:0000:00:14.3', 'usb:1-2', 'usb:1-3'])
    expect(d.find((x) => x.id === 'usb:1-2')).toMatchObject({ name: 'HD Pro Webcam C920', vendor: 'Logitech', kind: 'camera', driver: 'uvcvideo', built_in: false, ids: '046d:082d' })
    expect(d.find((x) => x.id === 'usb:1-3')).toMatchObject({ name: 'Printer', kind: 'printer', driver: null, driver_proprietary: null })
    expect(d.find((x) => x.id === 'pci:0000:00:14.3')).toMatchObject({ name: 'Wi-Fi 6 AX201', vendor: 'Intel Corporation', kind: 'wireless', driver: 'iwlwifi', built_in: true, driver_version: null, driver_proprietary: false })
  })

  it('returns nothing when sysfs is missing', () => {
    expect(listDevices(path.join(root, 'nope'))).toEqual([])
  })

  it('pciNames keeps only wanted ids', () => {
    const m = pciNames('8086  Intel\n\t1234  A\n\t5678  B\n', new Set(['8086', '8086:5678']))
    expect([...m]).toEqual([['8086', 'Intel'], ['8086:5678', 'B']])
  })
})

// Wi-Fi and Bluetooth diagnosis (#31) over a fake sysfs: adapters with drivers, rfkill switches, hardware without a
// driver or without firmware, stopped and missing services, and the fixes (rfkill unblock, systemctl restart).
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { applyFix, diagnose, diagnosisText, readAdapters, readRfkill } from './radios'
import type { Exec } from './system'

let root: string
const put = (rel: string, files: Record<string, string> = {}) => {
  const d = path.join(root, rel)
  mkdirSync(d, { recursive: true })
  for (const [k, v] of Object.entries(files)) writeFileSync(path.join(d, k), v + '\n')
  return d
}
const link = (target: string, at: string) => { mkdirSync(path.dirname(path.join(root, at)), { recursive: true }); symlinkSync(path.join(root, target), path.join(root, at)) }
const PCI_WIFI = 'sys/devices/pci0000:00/0000:00:14.3'
const USB_BT = 'sys/devices/pci0000:00/0000:00:14.0/usb1/1-10/1-10:1.0'

/** Intel Wi-Fi (iwlwifi, wlan0/phy0) and a USB Bluetooth controller (btusb, hci0), each with an rfkill switch. */
function laptop({ wifiSoft = false, btHard = false } = {}) {
  put(PCI_WIFI, { class: '0x028000', vendor: '0x8086', device: '0xa0f0' })
  put('sys/bus/drivers/iwlwifi'); link('sys/bus/drivers/iwlwifi', `${PCI_WIFI}/driver`)
  put('sys/bus/pci/devices'); link(PCI_WIFI, 'sys/bus/pci/devices/0000:00:14.3')
  put('sys/class/ieee80211/phy0')
  put('sys/class/net/wlan0'); link(PCI_WIFI, 'sys/class/net/wlan0/device'); link('sys/class/ieee80211/phy0', 'sys/class/net/wlan0/phy80211')
  put('sys/class/rfkill/rfkill0', { type: 'wlan', soft: wifiSoft ? '1' : '0', hard: '0' }); link('sys/class/ieee80211/phy0', 'sys/class/rfkill/rfkill0/device')
  put(USB_BT); put('sys/bus/drivers/btusb'); link('sys/bus/drivers/btusb', `${USB_BT}/driver`)
  put('sys/class/bluetooth/hci0'); link(USB_BT, 'sys/class/bluetooth/hci0/device')
  put('sys/class/rfkill/rfkill1', { type: 'bluetooth', soft: '0', hard: btHard ? '1' : '0' }); link('sys/class/bluetooth/hci0', 'sys/class/rfkill/rfkill1/device')
  put('usr/sbin'); writeFileSync(path.join(root, 'usr/sbin/wpa_supplicant'), '')
  put('usr/share/misc'); writeFileSync(path.join(root, 'usr/share/misc/pci.ids'), '8086  Intel Corporation\n\ta0f0  Wi-Fi 6 AX201\n')
}

/** systemctl answers: unit → is-active output; absent = no such unit. */
function systemctl(units: Record<string, string>, calls: string[][] = []): Exec {
  return async (cmd, args) => {
    calls.push([cmd, ...args])
    if (cmd !== 'systemctl') return { code: 0, stdout: '', stderr: '' }
    const unit = args[1]
    if (args[0] === 'is-active') return units[unit] === 'active' ? { code: 0, stdout: 'active\n', stderr: '' } : { code: 1, stdout: 'inactive\n', stderr: '' }
    if (args[0] === 'cat') return unit in units ? { code: 0, stdout: '[Unit]\n', stderr: '' } : { code: 1, stdout: '', stderr: `No files found for ${unit}.` }
    return { code: 0, stdout: '', stderr: '' }
  }
}
const running = systemctl({ 'NetworkManager.service': 'active', 'bluetooth.service': 'active' })

beforeEach(() => { root = mkdtempSync(path.join(tmpdir(), 'ws-radio-')) })
afterEach(() => rmSync(root, { recursive: true, force: true }))

describe('sysfs', () => {
  it('reads adapters, their drivers and rfkill owners', () => {
    laptop({ wifiSoft: true })
    expect(readRfkill(root)).toEqual([{ type: 'wlan', soft: true, hard: false, owner: 'phy0' }, { type: 'bluetooth', soft: false, hard: false, owner: 'hci0' }])
    expect(readAdapters('wifi', root)).toEqual([{ name: 'wlan0', device: null, driver: 'iwlwifi', bus: 'pci:0000:00:14.3', soft_blocked: true, hard_blocked: false }])
    expect(readAdapters('bluetooth', root)).toEqual([{ name: 'hci0', device: null, driver: 'btusb', bus: 'usb:1-10', soft_blocked: false, hard_blocked: false }])
  })
  it('a platform switch without an owning radio blocks every radio of its type', () => {
    laptop()
    put('sys/class/rfkill/rfkill2', { type: 'wlan', soft: '0', hard: '1' })
    expect(readAdapters('wifi', root)[0]).toMatchObject({ hard_blocked: true })
  })
})

describe('diagnose', () => {
  it('reports a working laptop as ok, with the adapter named from pci.ids', async () => {
    laptop()
    const d = await diagnose('wifi', { exec: running, root })
    expect(d).toMatchObject({ status: 'ok', service: 'active', problems: [], adapters: [{ name: 'wlan0', device: 'Wi-Fi 6 AX201', driver: 'iwlwifi' }] })
    expect(diagnosisText(d)).toContain('adapter wlan0 (Wi-Fi 6 AX201): driver iwlwifi')
  })
  it('soft block → off, fixable; hard block → problem, not fixable from here', async () => {
    laptop({ wifiSoft: true, btHard: true })
    const w = await diagnose('wifi', { exec: running, root })
    expect(w.status).toBe('off')
    expect(w.problems).toEqual([{ code: 'soft_blocked', device: 'Wi-Fi 6 AX201', fix: 'unblock' }])
    const b = await diagnose('bluetooth', { exec: running, root })
    expect(b.status).toBe('problem')
    expect(b.problems).toEqual([{ code: 'hard_blocked', device: 'hci0', fix: null }])
  })
  it('hardware without a driver, or with a driver but no interface (firmware), points to Drivers', async () => {
    put('sys/bus/pci/devices/0000:02:00.0', { class: '0x028000', vendor: '0x14c3', device: '0x0616' })
    let d = await diagnose('wifi', { exec: running, root })
    expect(d.status).toBe('problem')
    expect(d.problems).toContainEqual({ code: 'no_driver', device: 'Wireless adapter', fix: 'find_driver' })
    expect(d.problems).toContainEqual({ code: 'supplicant_missing', device: null, fix: null })
    put('sys/bus/drivers/mt7921e'); link('sys/bus/drivers/mt7921e', 'sys/bus/pci/devices/0000:02:00.0/driver')
    d = await diagnose('wifi', { exec: running, root })
    expect(d.problems).toContainEqual({ code: 'no_interface', device: 'Wireless adapter', fix: 'find_driver' })
  })
  it('no hardware at all, stopped and missing services', async () => {
    let d = await diagnose('bluetooth', { exec: systemctl({ 'bluetooth.service': 'inactive' }), root })
    expect(d.problems).toEqual([{ code: 'service_stopped', device: null, fix: 'restart_service' }, { code: 'no_hardware', device: null, fix: null }])
    d = await diagnose('bluetooth', { exec: systemctl({}), root })
    expect(d.service).toBe('missing')
    expect(d.problems[0]).toEqual({ code: 'service_missing', device: null, fix: null })
  })
})

describe('fixes', () => {
  it('unblocks with rfkill and restarts with systemctl, reporting refusals', async () => {
    const calls: string[][] = []
    expect(await applyFix('bluetooth', 'unblock', systemctl({}, calls))).toEqual({ ok: true })
    expect(await applyFix('wifi', 'restart_service', systemctl({}, calls))).toEqual({ ok: true })
    expect(calls).toEqual([['rfkill', 'unblock', 'bluetooth'], ['systemctl', 'restart', 'NetworkManager.service']])
    expect(await applyFix('wifi', 'unblock', async () => ({ code: 1, stdout: '', stderr: '', missing: true }))).toEqual({ ok: false, error: 'rfkill_missing' })
    expect(await applyFix('wifi', 'restart_service', async () => ({ code: 1, stdout: '', stderr: 'Failed: Access denied' }))).toEqual({ ok: false, error: 'not_allowed' })
    expect(await applyFix('wifi', 'find_driver', running)).toEqual({ ok: false, error: 'invalid_argument' })
  })
})

// Settings › Devices: what is plugged in and which kernel driver is bound, read straight from sysfs as the
// logged-in user (no privileges, no commands). Nothing here installs or changes drivers.
import { existsSync, readFileSync, readdirSync, readlinkSync } from 'node:fs'
import path from 'node:path'

export type HwKind = 'printer' | 'keyboard' | 'mouse' | 'camera' | 'network' | 'wireless' | 'graphics' | 'audio' | 'storage' | 'bluetooth' | 'input' | 'other'
export interface HwDevice {
  id: string            // "usb:1-2" | "pci:0000:00:14.3"
  name: string
  vendor: string | null
  kind: HwKind
  bus: 'usb' | 'pci'
  built_in: boolean
  driver: string | null // bound kernel driver, null = nothing bound
  driver_version: string | null
  /** From /sys/module/<driver>/taint ("P" = proprietary); null when unknown or built into the kernel. */
  driver_proprietary: boolean | null
  ids: string           // "046d:082d"
}

const PCI_IDS = ['/usr/share/misc/pci.ids', '/usr/share/hwdata/pci.ids']

function read(p: string): string | null {
  try { return readFileSync(p, 'utf8').trim() || null } catch { return null }
}
function driverOf(dir: string): string | null {
  try { return path.basename(readlinkSync(path.join(dir, 'driver'))) } catch { return null }
}
function list(dir: string): string[] {
  try { return readdirSync(dir) } catch { return [] }
}

/** pci.ids → vendor and device names for the ids present (only those lines are kept). */
export function pciNames(text: string, wanted: Set<string>): Map<string, string> {
  const out = new Map<string, string>()
  let vendor = ''
  for (const line of text.split('\n')) {
    if (!line || line[0] === '#') continue
    if (line[0] !== '\t') {
      const m = /^([0-9a-f]{4})\s+(.*)$/.exec(line)
      if (!m) { vendor = ''; continue }
      vendor = m[1]
      if (wanted.has(vendor)) out.set(vendor, m[2])
    } else if (line[1] !== '\t' && vendor) {
      const m = /^\t([0-9a-f]{4})\s+(.*)$/.exec(line)
      if (m && wanted.has(`${vendor}:${m[1]}`)) out.set(`${vendor}:${m[1]}`, m[2])
    }
  }
  return out
}

// PCI class (first byte, or first two for subclasses) → kind; bridges, host controllers etc. aren't shown.
function pciKind(cls: string): HwKind | null {
  const c = cls.replace(/^0x/, '').padStart(6, '0')
  const base = c.slice(0, 2), sub = c.slice(0, 4)
  if (base === '02') return sub === '0280' ? 'wireless' : 'network'
  if (base === '03') return 'graphics'
  if (sub === '0401' || sub === '0403') return 'audio'
  if (base === '01') return 'storage'
  if (base === '0d') return sub === '0d11' ? 'bluetooth' : 'wireless'
  if (sub === '0480') return 'camera'
  return null
}

function usbKind(ifaces: { cls: string; proto: string }[]): HwKind | null {
  const has = (c: string) => ifaces.find((i) => i.cls === c)
  if (has('09') && ifaces.every((i) => i.cls === '09')) return null // hubs
  if (has('07')) return 'printer'
  if (has('0e')) return 'camera'
  if (has('e0')) return 'bluetooth'
  const hid = ifaces.filter((i) => i.cls === '03')
  if (hid.some((i) => i.proto === '01')) return 'keyboard'
  if (hid.some((i) => i.proto === '02')) return 'mouse'
  if (hid.length) return 'input'
  if (has('08')) return 'storage'
  if (has('01')) return 'audio'
  if (has('02') || has('0a')) return 'network'
  return 'other'
}

const KIND_NAME: Record<HwKind, string> = {
  printer: 'Printer', keyboard: 'Keyboard', mouse: 'Mouse', camera: 'Camera', network: 'Network adapter', wireless: 'Wireless adapter',
  graphics: 'Graphics', audio: 'Audio', storage: 'Storage', bluetooth: 'Bluetooth adapter', input: 'Input device', other: 'USB device',
}

export function listDevices(root = '/'): HwDevice[] {
  const sys = (...p: string[]) => path.join(root, 'sys', ...p)
  const modVersion = (d: string | null) => (d ? read(sys('module', d, 'version')) : null)
  const modProp = (d: string | null) => {
    if (!d || !existsSync(sys('module', d))) return null
    return (read(sys('module', d, 'taint')) ?? '').includes('P')
  }
  const out: HwDevice[] = []

  // USB: top-level devices only ("1-2", "3-1.4"), not interfaces ("1-2:1.0") or root hubs ("usb1").
  for (const name of list(sys('bus', 'usb', 'devices'))) {
    if (!/^\d+-[\d.]+$/.test(name)) continue
    const dir = sys('bus', 'usb', 'devices', name)
    const ifaces = list(dir).filter((n) => n.startsWith(`${name}:`)).map((n) => ({
      cls: (read(path.join(dir, n, 'bInterfaceClass')) ?? '').toLowerCase(),
      proto: (read(path.join(dir, n, 'bInterfaceProtocol')) ?? '').toLowerCase(),
      driver: driverOf(path.join(dir, n)),
    }))
    const kind = usbKind(ifaces)
    if (!kind) continue
    const vid = read(path.join(dir, 'idVendor')) ?? '????', pid = read(path.join(dir, 'idProduct')) ?? '????'
    const driver = ifaces.map((i) => i.driver).find((d) => d && d !== 'usbfs') ?? null
    const vendor = read(path.join(dir, 'manufacturer'))
    out.push({ id: `usb:${name}`, name: read(path.join(dir, 'product')) ?? KIND_NAME[kind], vendor, kind, bus: 'usb',
      built_in: read(path.join(dir, 'removable')) === 'fixed', driver, driver_version: modVersion(driver), driver_proprietary: modProp(driver), ids: `${vid}:${pid}` })
  }

  // PCI: the classes people recognise (network, graphics, audio, storage, wireless).
  const pci = list(sys('bus', 'pci', 'devices')).map((addr) => {
    const dir = sys('bus', 'pci', 'devices', addr)
    const strip = (v: string | null) => (v ?? '').replace(/^0x/, '').toLowerCase()
    return { addr, dir, kind: pciKind(read(path.join(dir, 'class')) ?? ''), vid: strip(read(path.join(dir, 'vendor'))), did: strip(read(path.join(dir, 'device'))) }
  }).filter((d) => d.kind)
  const wanted = new Set(pci.flatMap((d) => [d.vid, `${d.vid}:${d.did}`]))
  const idsFile = PCI_IDS.map((p) => path.join(root, p)).find((p) => existsSync(p))
  const names = idsFile && pci.length ? pciNames(readFileSync(idsFile, 'utf8'), wanted) : new Map<string, string>()
  for (const d of pci) {
    const driver = driverOf(d.dir)
    const vendor = names.get(d.vid) ?? null
    const model = names.get(`${d.vid}:${d.did}`)
    out.push({ id: `pci:${d.addr}`, name: model ?? KIND_NAME[d.kind!], vendor, kind: d.kind!, bus: 'pci', built_in: true,
      driver, driver_version: modVersion(driver), driver_proprietary: modProp(driver), ids: `${d.vid}:${d.did}` })
  }
  return out
}

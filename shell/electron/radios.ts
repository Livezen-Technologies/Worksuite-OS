// Settings › Network and Bluetooth: why Wi-Fi or Bluetooth doesn't work (#31). Reads the adapters, their kernel
// drivers and radio switches straight from sysfs as the signed-in user, plus whether NetworkManager, wpa_supplicant
// and bluetoothd are there and running. Each problem has a code the UI explains, and some have a fix the user may
// apply: unblock a radio switched off in software (rfkill; logind gives the console user /dev/rfkill), restart a
// stopped service (systemctl, polkit asks for an administrator), or look for a driver (Settings › Drivers).
import { existsSync, readdirSync, readFileSync, readlinkSync } from 'node:fs'
import path from 'node:path'
import { listDevices } from './hardware'
import type { Exec } from './system'

export type RadioKind = 'wifi' | 'bluetooth'
export type RadioProblemCode =
  | 'no_hardware'        // no adapter of this kind anywhere
  | 'no_driver'          // an adapter is plugged in but no kernel driver took it
  | 'no_interface'       // a driver took it but made no wlanN/hciN: almost always missing firmware
  | 'hard_blocked'       // the hardware switch or key (or the firmware setting) turns the radio off
  | 'soft_blocked'       // switched off in software (airplane mode, rfkill)
  | 'service_stopped'    // NetworkManager / bluetoothd not running
  | 'service_missing'    // not installed
  | 'supplicant_missing' // wpa_supplicant not installed: NetworkManager can't use any Wi-Fi card
export type RadioFix = 'unblock' | 'restart_service' | 'find_driver'
export interface RadioProblem { code: RadioProblemCode; device: string | null; fix: RadioFix | null }
export interface RadioAdapter { name: string; device: string | null; driver: string | null; soft_blocked: boolean; hard_blocked: boolean }
export interface RadioDiagnosis {
  kind: RadioKind
  /** ok = at least one adapter usable; off = usable but switched off in software; problem = nothing usable. */
  status: 'ok' | 'off' | 'problem'
  adapters: RadioAdapter[]
  /** Adapters the hardware listing sees (PCI/USB), with their driver, whether or not they work. */
  hardware: { name: string; driver: string | null; ids: string }[]
  service: 'active' | 'inactive' | 'missing' | 'unknown'
  problems: RadioProblem[]
}

const UNIT: Record<RadioKind, string> = { wifi: 'NetworkManager.service', bluetooth: 'bluetooth.service' }
const RFKILL_TYPE: Record<RadioKind, string> = { wifi: 'wlan', bluetooth: 'bluetooth' }

function read(p: string): string | null {
  try { return readFileSync(p, 'utf8').trim() } catch { return null }
}
function list(dir: string): string[] {
  try { return readdirSync(dir) } catch { return [] }
}
function driverOf(dir: string): string | null {
  try { return path.basename(readlinkSync(path.join(dir, 'driver'))) } catch { return null }
}
/** sysfs device directory of an interface → the PCI address or USB port it sits on (matches hardware.ts ids). */
function busId(devDir: string): string | null {
  let real: string
  try { real = readlinkSync(devDir) } catch { return null }
  const parts = real.split('/')
  for (let i = parts.length - 1; i >= 0; i--) {
    if (/^\d+-[\d.]+$/.test(parts[i])) return `usb:${parts[i]}`
    if (/^[0-9a-f]{4}:[0-9a-f]{2}:[0-9a-f]{2}\.[0-7]$/.test(parts[i])) return `pci:${parts[i]}`
  }
  return null
}

interface Rfkill { type: string; soft: boolean; hard: boolean; owner: string | null }
/** /sys/class/rfkill/rfkillN: type, soft, hard; the owning phy/hci is the parent device's name. */
export function readRfkill(root = '/'): Rfkill[] {
  const base = path.join(root, 'sys/class/rfkill')
  return list(base).filter((n) => /^rfkill\d+$/.test(n)).map((n) => {
    const d = path.join(base, n)
    let owner: string | null = null
    try { owner = path.basename(readlinkSync(path.join(d, 'device'))) } catch { /* platform switch (e.g. ideapad) */ }
    return { type: read(path.join(d, 'type')) ?? '', soft: read(path.join(d, 'soft')) === '1', hard: read(path.join(d, 'hard')) === '1', owner }
  })
}

/** The radio adapters the kernel made: Wi-Fi interfaces (with a phy80211) and Bluetooth controllers (hciN). */
export function readAdapters(kind: RadioKind, root = '/'): (RadioAdapter & { bus: string | null })[] {
  const rf = readRfkill(root).filter((r) => r.type === RFKILL_TYPE[kind])
  // Platform switches (no owning device) block every radio of their type.
  const global = rf.filter((r) => !r.owner || !/^(phy|hci)\d+$/.test(r.owner))
  const blocked = (owner: string) => {
    const own = rf.filter((r) => r.owner === owner).concat(global)
    return { soft_blocked: own.some((r) => r.soft), hard_blocked: own.some((r) => r.hard) }
  }
  if (kind === 'wifi') {
    const base = path.join(root, 'sys/class/net')
    return list(base).filter((n) => existsSync(path.join(base, n, 'phy80211')) || existsSync(path.join(base, n, 'wireless'))).map((n) => {
      const phy = (() => { try { return path.basename(readlinkSync(path.join(base, n, 'phy80211'))) } catch { return '' } })()
      const dev = path.join(base, n, 'device')
      return { name: n, device: null, driver: driverOf(dev), bus: busId(dev), ...blocked(phy) }
    })
  }
  const base = path.join(root, 'sys/class/bluetooth')
  return list(base).filter((n) => /^hci\d+$/.test(n)).map((n) => {
    const dev = path.join(base, n, 'device')
    return { name: n, device: null, driver: driverOf(dev), bus: busId(dev), ...blocked(n) }
  })
}

/** `systemctl is-active <unit>` → active / inactive (also failed, activating…) / missing (no such unit or no systemctl). */
async function serviceState(exec: Exec, unit: string): Promise<RadioDiagnosis['service']> {
  const r = await exec('systemctl', ['is-active', unit])
  const s = r.stdout.trim()
  if (r.missing) return 'unknown'
  if (s === 'active') return 'active'
  // `is-active` of a unit that doesn't exist prints "inactive"; tell it from a stopped one with `cat`.
  const known = await exec('systemctl', ['cat', unit])
  return known.code === 0 ? 'inactive' : 'missing'
}

export interface RadiosDeps { exec: Exec; root?: string }

/** Everything the UI needs to say what's wrong with Wi-Fi or Bluetooth, and what can be done. */
export async function diagnose(kind: RadioKind, deps: RadiosDeps): Promise<RadioDiagnosis> {
  const root = deps.root ?? '/'
  const adaptersRaw = readAdapters(kind, root)
  const hwKind = kind === 'wifi' ? 'wireless' : 'bluetooth'
  const hw = listDevices(root).filter((d) => d.kind === hwKind)
  const adapters: RadioAdapter[] = adaptersRaw.map(({ bus, ...a }) => ({ ...a, device: hw.find((h) => h.id === bus)?.name ?? null }))
  const service = await serviceState(deps.exec, UNIT[kind])
  const problems: RadioProblem[] = []

  if (service === 'missing') problems.push({ code: 'service_missing', device: null, fix: null })
  else if (service === 'inactive') problems.push({ code: 'service_stopped', device: null, fix: 'restart_service' })
  if (kind === 'wifi' && !['usr/sbin', 'sbin', 'usr/bin'].some((d) => existsSync(path.join(root, d, 'wpa_supplicant'))))
    problems.push({ code: 'supplicant_missing', device: null, fix: null })

  // Hardware without a working adapter: no driver bound, or bound without making an interface (firmware).
  const used = new Set(adaptersRaw.map((a) => a.bus))
  for (const d of hw) {
    if (used.has(d.id)) continue
    if (!d.driver) problems.push({ code: 'no_driver', device: d.name, fix: 'find_driver' })
    else if (!adapters.length) problems.push({ code: 'no_interface', device: d.name, fix: 'find_driver' })
  }
  if (!adapters.length && !hw.length) problems.push({ code: 'no_hardware', device: null, fix: null })

  for (const a of adapters) {
    if (a.hard_blocked) problems.push({ code: 'hard_blocked', device: a.device ?? a.name, fix: null })
    else if (a.soft_blocked) problems.push({ code: 'soft_blocked', device: a.device ?? a.name, fix: 'unblock' })
  }
  const usable = adapters.filter((a) => !a.hard_blocked)
  const serviceOk = service === 'active' || service === 'unknown'
  const status: RadioDiagnosis['status'] = !usable.length || !serviceOk || problems.some((p) => p.code === 'supplicant_missing') ? 'problem'
    : usable.every((a) => a.soft_blocked) ? 'off' : 'ok'
  return { kind, status, adapters, hardware: hw.map((d) => ({ name: d.name, driver: d.driver, ids: d.ids })), service, problems }
}

/** Applies a fix. `find_driver` is the UI's (it opens Settings › Drivers). */
export async function applyFix(kind: RadioKind, fix: RadioFix, exec: Exec): Promise<{ ok: true } | { ok: false; error: string }> {
  if (fix === 'unblock') {
    const r = await exec('rfkill', ['unblock', RFKILL_TYPE[kind]])
    return r.code === 0 ? { ok: true } : { ok: false, error: r.missing ? 'rfkill_missing' : /denied|permission/i.test(r.stderr) ? 'not_allowed' : 'failed' }
  }
  if (fix === 'restart_service') {
    // polkit (org.freedesktop.systemd1.manage-units) asks for an administrator through the session's agent.
    const r = await exec('systemctl', ['restart', UNIT[kind]])
    return r.code === 0 ? { ok: true } : { ok: false, error: /auth|denied|access/i.test(r.stderr) ? 'not_allowed' : 'failed' }
  }
  return { ok: false, error: 'invalid_argument' }
}

/** Plain-text report of a diagnosis (Settings' "Copy details", problem reports). */
export function diagnosisText(d: RadioDiagnosis): string {
  const lines = [`${d.kind === 'wifi' ? 'Wi-Fi' : 'Bluetooth'}: ${d.status}`, `service ${UNIT[d.kind]}: ${d.service}`]
  for (const a of d.adapters) lines.push(`adapter ${a.name}${a.device ? ` (${a.device})` : ''}: driver ${a.driver ?? 'none'}${a.hard_blocked ? ', hard-blocked' : ''}${a.soft_blocked ? ', soft-blocked' : ''}`)
  for (const h of d.hardware) lines.push(`hardware ${h.name} [${h.ids}]: driver ${h.driver ?? 'none'}`)
  for (const p of d.problems) lines.push(`problem ${p.code}${p.device ? ` (${p.device})` : ''}`)
  return lines.join('\n')
}

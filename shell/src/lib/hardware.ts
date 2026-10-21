// Devices and drivers view logic over the bridge's sysfs device list (electron/hardware.ts).
import type { DriverOffer, DriverReport, DriverStatus, HwDevice, HwKind } from './os'
import { messages, t } from '../i18n'
import { classifyError } from './errors'

export const OK = '#5FD39A', WARN = '#FFB98A', OFF = '#8FA3C8'

export const KIND_LABEL: Record<HwKind, string> = messages({
  printer: 'hw.kind.printer', keyboard: 'hw.kind.keyboard', mouse: 'hw.kind.mouse', camera: 'hw.kind.camera', network: 'hw.kind.network', wireless: 'hw.kind.wireless',
  graphics: 'hw.kind.graphics', audio: 'hw.kind.audio', storage: 'settings.about.storage', bluetooth: 'settings.nav.Bluetooth', input: 'hw.kind.input', other: 'hw.kind.other',
})
// Icon paths from the HwSettings / H1 boards.
export const KIND_ICON: Record<HwKind, string> = {
  printer: 'M6 9V3h12v6M6 18H4v-7h16v7h-2M8 14h8v7H8z',
  keyboard: 'M3 7h18v10H3zM7 11h.01M11 11h.01M15 11h.01M8 14h8',
  mouse: 'M12 3a6 6 0 0 1 6 6v6a6 6 0 0 1-12 0V9a6 6 0 0 1 6-6zM12 7v3',
  camera: 'M4 7h11v10H4zM15 10l5-3v10l-5-3',
  network: 'M4 6h16v10H4zM2 20h20',
  wireless: 'M2 9a15 15 0 0 1 20 0M5.5 12.5a10 10 0 0 1 13 0M9 16a5 5 0 0 1 6 0',
  graphics: 'M3 6h18v12H3zM7 10h4v4H7z',
  audio: 'M4 9v6h4l5 4V5L8 9zM16.5 8.5a5 5 0 0 1 0 7',
  storage: 'M4 5h16v14H4zM4 12h16M8 8.5h.01M8 15.5h.01',
  bluetooth: 'M7 7l10 10-5 5V2l5 5L7 17',
  input: 'M3 7h18v10H3z',
  other: 'M4 6h16v10H4zM2 20h20',
}

export function deviceSub(d: HwDevice): string {
  return [KIND_LABEL[d.kind], d.bus === 'usb' ? 'USB' : t('hw.builtIn'), d.vendor].filter(Boolean).join(' · ')
}
export function deviceStatus(d: HwDevice): { label: string; color: string } {
  return d.driver ? { label: t('hw.working'), color: OK } : { label: t('hw.noDriver'), color: WARN }
}

/** Connected (plugged-in USB) first, then built-in hardware; empty groups are dropped. */
export function groupDevices(devs: HwDevice[]): { name: string; items: HwDevice[] }[] {
  const by = (a: HwDevice, b: HwDevice) => a.name.localeCompare(b.name)
  return [
    { name: t('common.connected'), items: devs.filter((d) => !d.built_in).sort(by) },
    { name: t('hw.builtIn'), items: devs.filter((d) => d.built_in).sort(by) },
  ].filter((g) => g.items.length)
}

/** Devices in `next` that weren't in `prev` (first poll = baseline, nothing is "new"). */
export function newDevices(prev: HwDevice[] | null, next: HwDevice[]): HwDevice[] {
  if (!prev) return []
  const had = new Set(prev.map((d) => d.id))
  return next.filter((d) => !had.has(d.id) && !d.built_in)
}

/** Drivers in use, one row per kernel module. */
export function driversInUse(devs: HwDevice[]): { driver: string; version: string | null; proprietary: boolean | null; devices: string[] }[] {
  const m = new Map<string, { driver: string; version: string | null; proprietary: boolean | null; devices: string[] }>()
  for (const d of devs) {
    if (!d.driver) continue
    const row = m.get(d.driver) ?? { driver: d.driver, version: d.driver_version, proprietary: d.driver_proprietary, devices: [] }
    row.devices.push(d.name)
    m.set(d.driver, row)
  }
  return [...m.values()].sort((a, b) => a.driver.localeCompare(b.driver))
}

const OFFER_TAG_TEXT = messages({ security: 'hw.tag.security', recommended: 'hw.tag.recommended', proprietary: 'hw.tag.proprietary', open: 'hw.tag.open' })
export const OFFER_TAG: Record<string, { tag: string; bg: string; color: string }> = {
  security: { get tag() { return OFFER_TAG_TEXT.security }, bg: 'rgba(255,138,122,0.16)', color: '#FF8A7A' },
  recommended: { get tag() { return OFFER_TAG_TEXT.recommended }, bg: 'rgba(95,211,154,0.16)', color: '#5FD39A' },
  proprietary: { get tag() { return OFFER_TAG_TEXT.proprietary }, bg: 'rgba(255,159,90,0.16)', color: '#FFB98A' },
  open: { get tag() { return OFFER_TAG_TEXT.open }, bg: 'rgba(127,178,255,0.12)', color: '#C9D6EE' },
}
export const offerTag = (o: DriverOffer) => OFFER_TAG[o.category === 'optional' ? o.license : o.category]
export const offerVersion = (o: DriverOffer) => (o.from_version ? `${o.from_version} → ${o.to_version}` : t('hw.newVersion', { version: o.to_version }))
/** Security fixes can't be unticked (HwSettings board: locked checkbox). */
export const offerLocked = (o: DriverOffer) => o.category === 'security'

// ---------- Settings › Drivers over the package service's report ----------

type ReportDevice = DriverReport['devices'][number]
export const STATUS_COLOR: Record<DriverStatus, string> = { working: OK, missing_firmware: WARN, update_available: '#7FB2FF', optional_driver: '#7FB2FF', no_driver: WARN }
const STATUS_TEXT = messages({ working: 'hw.working', missing_firmware: 'drv.status.firmware', update_available: 'drv.status.update', optional_driver: 'drv.status.optional', no_driver: 'hw.noDriver' })
export const statusLabel = (s: DriverStatus) => STATUS_TEXT[s]

/** The device's group in Settings › Drivers: from the report when it knows the device, else from the sysfs kind. */
export type DriverGroup = 'display' | 'wifi' | 'ethernet' | 'other'
const GROUP_TEXT = messages({ display: 'drv.group.display', wifi: 'drv.group.wifi', ethernet: 'drv.group.ethernet', other: 'drv.group.other' })
export function groupOf(d: HwDevice, r?: ReportDevice): DriverGroup {
  const k = r?.kind
  if (k === 'display' || k === 'wifi' || k === 'ethernet') return k
  if (d.kind === 'graphics') return 'display'
  if (d.kind === 'wireless') return 'wifi'
  if (d.kind === 'network') return 'ethernet'
  return 'other'
}

/** Display, Wi-Fi, Ethernet, then the rest; each device with its status (sysfs alone: Working / No driver). */
export function driverGroups(devs: HwDevice[], report: DriverReport | null): { group: DriverGroup; name: string; items: { dev: HwDevice; status: DriverStatus; driverLabel: string | null }[] }[] {
  const order: DriverGroup[] = ['display', 'wifi', 'ethernet', 'other']
  const rows = devs.map((dev) => {
    const r = report?.devices.find((x) => x.id === dev.id)
    const status: DriverStatus = r?.status ?? (dev.driver ? 'working' : 'no_driver')
    const group = groupOf(dev, r)
    return { dev, group, status, driverLabel: driverLabel(dev.driver, dev.driver_version, group === 'display') }
  })
  return order.map((g) => ({ group: g, name: GROUP_TEXT[g], items: rows.filter((x) => x.group === g && (g !== 'other' || x.status !== 'working')).map(({ dev, status, driverLabel }) => ({ dev, status, driverLabel })) }))
    .filter((g) => g.items.length)
}

/** The display driver in words people know: Mesa (amdgpu), Mesa (i915), Mesa (nouveau), NVIDIA 550. Only graphics
 *  devices are "Mesa": a virtio network card's driver is also virtio-pci (#59). */
export function driverLabel(driver: string | null, version: string | null, display = true): string | null {
  if (!driver) return null
  if (!display) return driver
  if (driver === 'nvidia') return version ? `NVIDIA ${version.split('.')[0]}` : 'NVIDIA'
  if (['amdgpu', 'radeon', 'i915', 'xe', 'nouveau', 'virtio-pci', 'virtio_gpu', 'panfrost', 'panthor', 'msm', 'v3d'].includes(driver)) return `Mesa (${driver})`
  return driver
}

const SUMMARY_TEXT = messages({
  firmware_missing: 'drv.sum.firmware', firmware_suggested: 'drv.sum.suggested', nvidia_better: 'drv.sum.nvidia', nvidia_secure_boot: 'drv.sum.nvidiaSb',
  dkms_optional: 'drv.sum.dkms', dkms_secure_boot: 'drv.sum.dkmsSb',
})
/** Offer title and description for people (packages only in technical details). */
export function offerTitle(o: DriverOffer, devName?: string): string {
  if (o.kind === 'gpu') return t('drv.nvidiaTitle')
  if (o.kind === 'firmware') return devName ? t('drv.fwFor', { name: devName }) : t('drv.fwGeneric')
  return o.name
}
export function offerText(o: DriverOffer): string {
  return Object.hasOwn(SUMMARY_TEXT, o.summary) ? SUMMARY_TEXT[o.summary as keyof typeof SUMMARY_TEXT] : o.summary
}

export type DriverStep = 'refreshing' | 'downloading' | 'installing' | 'done' | 'failed'
/** A driver job's phase: "<offer id>|<step>" from the package service (older services sent the offer id alone). */
export function driverJobPhase(phase: string): { offer: string; step: DriverStep } {
  const i = phase.lastIndexOf('|')
  if (i < 0) return { offer: phase, step: 'installing' }
  const step = phase.slice(i + 1)
  return { offer: phase.slice(0, i), step: step === 'refreshing' || step === 'downloading' || step === 'done' || step === 'failed' ? step : 'installing' }
}

/** Why one driver didn't install, in words (the service's error stays for <ErrorDetails>, #59). A sources problem
 *  (an unsigned or unapproved APT source, which blocks every install) is named as such. */
export function driverFailureText(error: string): string {
  if (/missing Signed-By|not an approved source|is not part of trixie|is not allowed \(testing|SourcesInvalid/.test(error)) return t('drv.fail.sources')
  if (/has no installation candidate|Unable to locate package/.test(error) && !/^apt-get update: /.test(error)) return t('drv.fail.notFound')
  const k = classifyError(error)
  return k === 'offline' ? t('drv.fail.offline') : k === 'not_found' ? t('drv.fail.notFound') : k === 'no_space' ? t('err.kind.noSpace') : k === 'busy' ? t('err.kind.busy')
    : k === 'integrity' ? t('err.kind.integrity') : k === 'dependencies' ? t('err.kind.dependencies') : k === 'not_authorized' ? t('err.kind.notAuthorized') : t('drv.fail.generic')
}

/** The notice after a background check: offers a person must choose (not the ones that installed themselves). */
export function driverNotice(r: DriverReport, devs: HwDevice[], seen: Set<string>): { title: string; body: string } | null {
  const fresh = r.offers.filter((o) => !r.auto_installed.includes(o.id) && !seen.has(o.id))
  if (!fresh.length) return null
  const dev = (id: string | null) => devs.find((d) => d.id === id)
  const kinds = new Set(fresh.map((o) => groupOf(dev(o.device_id) ?? ({ kind: 'other' } as HwDevice), r.devices.find((x) => x.id === o.device_id))))
  const title = fresh.some((o) => o.kind === 'gpu') ? t('drv.notice.gpu') : kinds.has('wifi') ? t('drv.notice.wifi') : kinds.has('ethernet') ? t('drv.notice.ethernet') : t('drv.notice.generic')
  return { title, body: t('drv.notice.body') }
}

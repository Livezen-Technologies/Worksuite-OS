// Devices and drivers view logic over the bridge's sysfs device list (electron/hardware.ts).
import type { DriverOffer, HwDevice, HwKind } from './os'
import { messages, t } from '../i18n'

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

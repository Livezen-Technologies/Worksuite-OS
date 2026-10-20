// Wi-Fi and battery indicators for the lock screen and the greeter (#25). NetworkManager and UPower state through the
// bridge, polled; a machine without Wi-Fi state or a battery shows only what it has.
import { useSystem, loaders } from '../lib/useSystem'
import { batterySummary, netSummary, wifiBars, type BatterySummary, type NetSummary } from '../lib/lockStatus'
import { t } from '../i18n'

const POLL_MS = 15_000

function netLabel(n: NetSummary): string {
  switch (n.kind) {
    case 'wifi': return n.ssid ? t('lock.wifiOn', { ssid: n.ssid }) : t('lock.wifiConnected')
    case 'wired': return t('lock.wired')
    case 'off': return t('lock.wifiOff')
    case 'disconnected': return t('lock.offline')
    default: return t('lock.netUnknown')
  }
}

function batteryLabel(b: BatterySummary): string {
  const pct = b.percent == null ? '' : `${b.percent}%`
  if (b.full) return t('lock.batteryFull')
  return b.charging ? t('lock.batteryCharging', { pct }) : t('lock.battery', { pct })
}

function NetGlyph({ n }: { n: NetSummary }) {
  if (n.kind === 'wired') {
    return <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <rect x="9" y="2" width="6" height="6" rx="1" /><rect x="3" y="16" width="6" height="6" rx="1" /><rect x="15" y="16" width="6" height="6" rx="1" /><path d="M12 8v4M6 16v-4h12v4" /></svg>
  }
  const bars = n.kind === 'wifi' ? wifiBars(n.signal) : 0
  const arcs = ['M9 16a5 5 0 0 1 6 0', 'M5.5 12.5a10 10 0 0 1 13 0', 'M2 9a15 15 0 0 1 20 0']
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden="true">
      {arcs.map((d, i) => <path key={d} d={d} opacity={i < bars ? 1 : 0.3} />)}
      <circle cx="12" cy="19.5" r="1" fill="currentColor" stroke="none" />
      {n.kind !== 'wifi' && <path d="M3 3l18 18" />}
    </svg>
  )
}

function BatteryGlyph({ b }: { b: BatterySummary }) {
  const fill = b.full ? 1 : (b.percent ?? 100) / 100
  const color = b.low ? '#FF8A7A' : 'currentColor'
  return (
    <svg width="26" height="18" viewBox="0 0 28 16" fill="none" stroke="currentColor" strokeWidth="1.6" aria-hidden="true">
      <rect x="1" y="2" width="22" height="12" rx="3" />
      <rect x="3" y="4" width={Math.max(1, 18 * fill)} height="8" rx="1.5" fill={color} stroke="none" />
      <path d="M25 6v4" />
      {b.charging && <path d="M13.5 3.5L9.5 8.5h4l-1.5 4.5 4.5-5.5h-4z" fill="#FFD84D" stroke="#0A1A3A" strokeWidth="0.8" strokeLinejoin="round" />}
    </svg>
  )
}

/** The status row; each indicator has a text label for screen readers and a tooltip. */
export default function StatusIndicators({ className = '' }: { className?: string }) {
  const net = netSummary(useSystem(loaders.network, POLL_MS).state)
  const bat = batterySummary(useSystem(loaders.battery, POLL_MS).state)
  const nl = netLabel(net)
  return (
    <ul aria-label={t('lock.status')} className={`m-0 flex list-none items-center gap-4 p-0 ${className}`}>
      {net.kind !== 'unknown' && (
        <li className="flex items-center gap-1.5" title={nl} data-net={net.kind}>
          <NetGlyph n={net} /><span className="sr-only">{nl}</span>
        </li>
      )}
      {bat && (
        <li className="flex items-center gap-1.5" title={batteryLabel(bat)} data-battery={bat.charging ? 'charging' : 'discharging'}>
          <BatteryGlyph b={bat} />
          {bat.percent != null && <span aria-hidden="true" className="tabular-nums">{bat.percent}%</span>}
          <span className="sr-only">{batteryLabel(bat)}</span>
        </li>
      )}
    </ul>
  )
}

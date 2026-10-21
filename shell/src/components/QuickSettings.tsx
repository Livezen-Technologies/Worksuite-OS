// Quick settings (G01): the taskbar's status group (Wi-Fi, Bluetooth, volume, battery) and the panel it opens.
// Everything reads and changes the real services through the Settings bridge (NetworkManager, BlueZ, PipeWire,
// UPower), monitorApi (backlight) and peripheralsApi (power-profiles-daemon). A service that isn't there shows as unavailable.
import { useCallback, useEffect, useRef, useState } from 'react'
import { formatDuration, os, type BatteryState, type BluetoothState, type NetworkState, type SoundState } from '../lib/os'
import { monitorApi, type Backlight } from '../lib/monitorApi'
import { peripheralsApi, type PowerProfiles } from '../lib/peripheralsApi'
import { formatNumber, t, type MessageKey } from '../i18n'
import { useTouch } from '../lib/touch'

const D = {
  wifi: 'M2 9a15 15 0 0 1 20 0M5.5 12.5a10 10 0 0 1 13 0M9 16a5 5 0 0 1 6 0',
  wifiOff: 'M2 9a15 15 0 0 1 20 0M5.5 12.5a10 10 0 0 1 13 0M9 16a5 5 0 0 1 6 0M3 3l18 18',
  ethernet: 'M4 14h16v6H4zM8 14v-4h8v4M12 10V4',
  bt: 'M7 7l10 10-5 5V2l5 5L7 17',
  btOff: 'M7 7l10 10-5 5V2l5 5L7 17M3 3l18 18',
  plug: 'M9 2v6M15 2v6M6 8h12v4a6 6 0 0 1-12 0zM12 18v4',
  chevron: 'M9 6l6 6-6 6',
  moon: 'M20 14A8 8 0 1 1 10 4a6 6 0 0 0 10 10z',
  bolt: 'M13 2L4 14h7l-1 8 9-12h-7z',
  vol: 'M4 9v6h4l5 4V5L8 9zM16.5 8.5a5 5 0 0 1 0 7',
  volMute: 'M4 9v6h4l5 4V5L8 9zM17 9l5 6M22 9l-5 6',
  speaker: 'M4 9v6h4l5 4V5L8 9z',
  sun: 'M12 8a4 4 0 1 0 0 8 4 4 0 0 0 0-8zM12 2v2M12 20v2M2 12h2M20 12h2',
  battery: 'M3 7h15v10H3zM20 10v4',
  settings: 'M12 9a3 3 0 1 0 0 6 3 3 0 0 0 0-6zM12 2v3M12 19v3M2 12h3M19 12h3M5 5l2 2M17 17l2 2M5 19l2-2M17 7l2-2',
  lock: 'M7 11V7a5 5 0 0 1 10 0v4M5 11h14v10H5z',
  power: 'M12 3v9M6.3 7.3a8 8 0 1 0 11.4 0',
}
const Ico = ({ d, size = 16, stroke = '#FFFFFF' }: { d: string; size?: number; stroke?: string }) => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke={stroke} strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d={d} /></svg>
)

export interface QuickState {
  net: NetworkState | null; bt: BluetoothState | null; sound: SoundState | null; battery: BatteryState | null
  light: Backlight | null; mode: PowerProfiles | null
}

/** Polls the services while mounted (taskbar icons) and right away on `refresh` (after a change in the panel). */
export function useQuickState(): [QuickState, () => void] {
  const [s, setS] = useState<QuickState>({ net: null, bt: null, sound: null, battery: null, light: null, mode: null })
  const load = useCallback(() => {
    const v = <T,>(p: Promise<{ available: true; value: T } | { available: false; reason: string }>) => p.then((r) => (r.available ? r.value : null)).catch(() => null)
    void Promise.all([v(os.sysNetwork()), v(os.sysBluetooth()), v(os.sysSound()), v(os.sysBattery()), v(monitorApi.sysBrightness()), v(peripheralsApi()?.powerProfiles() ?? Promise.resolve({ available: false as const, reason: 'no_bridge' }))])
      .then(([net, bt, sound, battery, light, mode]) => setS({ net, bt, sound, battery, light, mode }))
  }, [])
  useEffect(() => {
    load()
    // Live (#28): NetworkManager, BlueZ and UPower signal changes (electron/sysWatch.ts); the poll is the fallback.
    const off = os.onSysChanged?.(() => load())
    const id = setInterval(load, 15_000)
    window.addEventListener('online', load); window.addEventListener('offline', load)
    return () => { clearInterval(id); off?.(); window.removeEventListener('online', load); window.removeEventListener('offline', load) }
  }, [load])
  return [s, load]
}

const wifiDevice = (n: NetworkState | null) => n?.devices.find((d) => d.type === 'wifi') ?? null
const wiredUp = (n: NetworkState | null) => n?.devices.some((d) => d.type === 'ethernet' && d.state === 'connected') ?? false

function batteryText(b: BatteryState | null): string | null {
  if (!b?.present || b.percentage == null) return null
  const p = Math.round(b.percentage)
  if (b.state === 'fully-charged') return t('qs.batteryFull', { pct: p })
  const left = formatDuration(b.on_battery ? b.time_to_empty_s : b.time_to_full_s)
  if (!left) return t('qs.battery', { pct: p })
  return b.on_battery ? t('qs.batteryLeft', { pct: p, time: left }) : t('qs.batteryCharging', { pct: p, time: left })
}

/** One taskbar status icon: what it shows, what it says and which Settings page it opens. */
export interface TrayIndicator { id: 'net' | 'bt' | 'sound' | 'battery'; d: string; label: string; section: string; level?: number; text?: string; dim?: boolean; badge?: boolean }

/** Wi-Fi signal (0–100 %) as 0–3 bars, like the taskbar's arcs. */
export const signalBars = (pct: number | null | undefined) => (pct == null ? 3 : pct >= 67 ? 3 : pct >= 34 ? 2 : pct > 0 ? 1 : 0)

/** The taskbar's status icons from the real state (#28): Wi-Fi with its signal, wired, Bluetooth with connected
 *  devices, volume, and battery with percentage and charging. A service that isn't there shows as unavailable. */
export function trayIndicators(s: QuickState): TrayIndicator[] {
  const { net, bt, sound, battery } = s
  const out: TrayIndicator[] = []
  const wifi = wifiDevice(net)
  const inUse = net?.networks.find((n) => n.in_use)
  if (!net) out.push({ id: 'net', d: D.wifiOff, label: t('tray.netUnavailable'), section: 'Network', dim: true })
  else if (wiredUp(net) && !(net.wifi_enabled && wifi?.state === 'connected')) out.push({ id: 'net', d: D.ethernet, label: t('tray.ethernet'), section: 'Network' })
  else if (!wifi) out.push({ id: 'net', d: D.wifiOff, label: t('tray.noWifi'), section: 'Network', dim: true })
  else if (!net.wifi_enabled) out.push({ id: 'net', d: D.wifiOff, label: t('tray.wifiOff'), section: 'Network', dim: true })
  else if (wifi.state === 'connected') {
    const pct = inUse?.signal ?? null
    out.push({ id: 'net', d: D.wifi, level: signalBars(pct), section: 'Network',
      label: t('tray.wifi', { name: wifi.connection ?? inUse?.ssid ?? '', pct: pct == null ? '—' : formatNumber(pct) }) })
  } else out.push({ id: 'net', d: D.wifi, level: 0, label: t('tray.wifiNone'), section: 'Network', dim: true })
  if (bt) {
    const n = bt.paired.filter((d) => d.connected).length
    out.push(bt.powered
      ? { id: 'bt', d: D.bt, section: 'Bluetooth', badge: n > 0, label: n ? t('tray.btConnected', { count: formatNumber(n) }) : t('tray.btOn') }
      : { id: 'bt', d: D.btOff, section: 'Bluetooth', dim: true, label: t('tray.btOff') })
  }
  if (sound) out.push({ id: 'sound', d: sound.muted || sound.volume === 0 ? D.volMute : D.vol, section: 'Sound', label: `${t('qs.volume')} ${formatNumber(sound.volume)}%` })
  if (battery?.present && battery.percentage != null) {
    const pct = Math.round(battery.percentage)
    const charging = !battery.on_battery && battery.state === 'charging'
    out.push({ id: 'battery', d: battery.on_battery ? D.battery : charging ? D.bolt : D.plug, section: 'Power', level: pct, text: `${formatNumber(pct)}%`,
      label: battery.on_battery ? t('tray.onBattery', { pct: formatNumber(pct) }) : charging ? t('tray.charging', { pct: formatNumber(pct) }) : t('tray.pluggedIn', { pct: formatNumber(pct) }) })
  }
  return out
}

/** Wi-Fi arcs with the bars that are not lit drawn faint. */
function WifiIcon({ level }: { level: number }) {
  const arcs = ['M9 16a5 5 0 0 1 6 0', 'M5.5 12.5a10 10 0 0 1 13 0', 'M2 9a15 15 0 0 1 20 0']
  return (
    <svg width={16} height={16} viewBox="0 0 24 24" fill="none" stroke="#FFFFFF" strokeWidth="2" strokeLinecap="round" aria-hidden="true">
      {arcs.map((d, i) => <path key={d} d={d} opacity={i < level ? 1 : 0.3} />)}<circle cx="12" cy="19.5" r="1" fill="#FFFFFF" stroke="none" />
    </svg>
  )
}

/** Battery outline filled to its charge (red under 15 %), with the charging bolt or the plug next to it. */
function BatteryIcon({ pct }: { pct: number }) {
  const w = Math.max(1, Math.round((Math.min(100, Math.max(0, pct)) / 100) * 11))
  return (
    <svg width={18} height={16} viewBox="0 0 24 24" fill="none" stroke="#FFFFFF" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d={D.battery} /><rect x="5" y="9" width={w} height="6" rx="0.5" fill={pct < 15 ? '#FF6B5B' : '#FFFFFF'} stroke="none" />
    </svg>
  )
}

/** Taskbar status group: the icons reflect the real state and update live; the button opens the panel, and a
 *  right-click on an icon opens its Settings page. */
export function QuickTray({ state, open, onToggle, onOpenSettings }: { state: QuickState; open: boolean; onToggle: () => void; onOpenSettings?: (section: string) => void }) {
  const items = trayIndicators(state)
  const summary = items.map((i) => i.label).join(', ')
  return (
    <button type="button" aria-label={t('qs.title')} aria-describedby={summary ? 'ws-tray-status' : undefined} aria-haspopup="dialog" aria-expanded={open} aria-controls="ws-quick" onClick={onToggle} title={batteryText(state.battery) ?? undefined}
      aria-description={onOpenSettings ? t('tray.settingsHint') : undefined}
      onContextMenu={(e) => {
        if (!onOpenSettings) return
        const id = (e.target as Element).closest?.('[data-indicator]')?.getAttribute('data-indicator')
        const it = items.find((i) => i.id === id) ?? items[0]
        if (!it) return
        e.preventDefault(); onOpenSettings(it.section)
      }}
      className={`flex h-[38px] cursor-pointer items-center gap-0.5 rounded-[10px] p-1 ${open ? 'bg-[rgba(31,107,255,0.4)]' : 'bg-[rgba(31,107,255,0.18)] hover:bg-[rgba(31,107,255,0.3)]'}`}>
      {summary && <span id="ws-tray-status" className="sr-only">{t('tray.status', { list: summary })}</span>}
      {items.length ? items.map((i) => (
        <span key={i.id} data-indicator={i.id} title={i.label} className={`relative flex h-[30px] min-w-[30px] items-center justify-center gap-1 ${i.dim ? 'opacity-60' : ''} ${i.text ? 'px-1' : ''}`}>
          {i.id === 'net' && i.d === D.wifi ? <WifiIcon level={i.level ?? 3} /> : i.id === 'battery' && i.d === D.battery ? <BatteryIcon pct={i.level ?? 0} />
            : i.id === 'battery' ? <span className="flex items-center"><BatteryIcon pct={i.level ?? 0} /><Ico d={i.d} size={11} /></span> : <Ico d={i.d} />}
          {i.text && <span aria-hidden="true" className="text-[11px] tabular-nums">{i.text}</span>}
          {i.badge && <span aria-hidden="true" className="absolute top-[5px] right-[4px] size-[5px] rounded-full bg-[#18D4F0]" />}
        </span>
      )) : <span className="flex size-[30px] items-center justify-center"><Ico d={D.settings} /></span>}
    </button>
  )
}

const PROFILE_KEY: Record<string, MessageKey> = { 'power-saver': 'qs.mode.saver', balanced: 'qs.mode.balanced', performance: 'qs.mode.performance' }

export function QuickPanel({ state, refresh, dnd, setDnd, onSettings, onLock, onPower, onClose, onOpenSettings }: {
  state: QuickState; refresh: () => void; dnd: boolean; setDnd: (v: boolean) => void
  onSettings: () => void; onLock: () => void; onPower: () => void; onClose: () => void
  /** Settings › that page (the arrow next to Wi-Fi, Bluetooth and the battery line). */
  onOpenSettings?: (section: string) => void
}) {
  const { net, bt, sound, battery, light, mode } = state
  const touch = useTouch()
  const ref = useRef<HTMLDivElement>(null)
  const [vol, setVol] = useState<number | null>(null)
  const [bri, setBri] = useState<number | null>(null)
  useEffect(() => { ref.current?.querySelector<HTMLElement>('button')?.focus() }, [])
  useEffect(() => {
    const onDown = (e: MouseEvent) => { if (ref.current && !ref.current.contains(e.target as Node) && !(e.target as HTMLElement).closest?.('[aria-controls="ws-quick"]')) onClose() }
    window.addEventListener('mousedown', onDown)
    return () => window.removeEventListener('mousedown', onDown)
  }, [onClose])

  const wifi = wifiDevice(net)
  const connected = wifi?.state === 'connected' ? wifi.connection : null
  const btOn = bt?.powered ?? false
  const btCount = bt?.paired.filter((d) => d.connected).length ?? 0
  const act = (p: Promise<unknown>) => void p.finally(refresh)
  const nextMode = (m: PowerProfiles) => m.profiles[(m.profiles.indexOf(m.active) + 1) % m.profiles.length]

  const tiles: { id: string; title: string; sub: string; d: string; on: boolean; disabled: boolean; click: () => void; section?: string }[] = [
    // NetworkManager reports WirelessEnabled even with no Wi-Fi adapter: without one the tile is unavailable, not on.
    { id: 'wifi', title: t('qs.wifi'), d: wifi ? D.wifi : D.wifiOff, on: !!net?.wifi_enabled && !!wifi, disabled: !net || !wifi,
      sub: !net ? t('common.unavailable') : !wifi ? t('qs.noWifi') : !net.wifi_enabled ? t('common.off') : connected ?? t('common.notConnected'),
      click: () => act(os.sysSetWifi(!net!.wifi_enabled)), section: 'Network' },
    { id: 'bt', title: t('settings.nav.Bluetooth'), d: D.bt, on: btOn, disabled: !bt,
      sub: !bt ? t('common.unavailable') : !btOn ? t('common.off') : btCount ? t(btCount === 1 ? 'qs.btOne' : 'qs.btDevices', { count: formatNumber(btCount) }) : t('common.on'),
      click: () => act(os.sysSetBluetooth(!btOn)), section: 'Bluetooth' },
    { id: 'dnd', title: t('quick.dnd'), d: D.moon, on: dnd, disabled: false, sub: dnd ? t('common.on') : t('common.off'), click: () => setDnd(!dnd) },
    { id: 'mode', title: t('qs.powerMode'), d: D.bolt, on: false, disabled: !mode || mode.profiles.length < 2,
      sub: mode ? (PROFILE_KEY[mode.active] ? t(PROFILE_KEY[mode.active]) : mode.active) : t('common.unavailable'),
      click: () => act(peripheralsApi()?.setPowerProfile(nextMode(mode!)) ?? Promise.resolve()) },
    // Touch (tablet) mode, Settings › Touchscreen & pen: a manual switch that overrides the convertible's hinge.
    ...(touch.state ? [{ id: 'tablet', title: t('qs.touchMode'), d: 'M6 2h12v20H6zM11 18h2', on: touch.state.touchMode, disabled: false,
      sub: touch.state.touchMode ? t('common.on') : t('common.off'), click: () => void touch.set({ tabletMode: touch.state!.touchMode ? 'off' : 'on' }) }] : []),
  ]
  const batt = batteryText(battery)
  const foot = 'flex size-8 cursor-pointer items-center justify-center rounded-lg bg-white/[0.08] hover:bg-white/[0.16]'

  return (
    <div id="ws-quick" ref={ref} role="dialog" aria-label={t('qs.title')} onKeyDown={(e) => { if (e.key === 'Escape') { e.stopPropagation(); onClose() } }}
      className="absolute right-3 bottom-16 z-40 box-border flex w-[360px] max-w-[calc(100%-24px)] flex-col gap-3.5 rounded-2xl border border-[rgba(127,178,255,0.2)] bg-[rgba(10,24,56,0.97)] p-4 text-[#E8EEFA] shadow-[0_24px_60px_rgba(0,0,0,0.5)]">
      <div className="grid grid-cols-2 gap-2">
        {tiles.map((x) => (
          <span key={x.id} className="flex min-w-0 overflow-hidden rounded-xl" style={{ background: x.on ? '#1F6BFF' : 'rgba(255,255,255,0.07)' }}>
            <button type="button" aria-pressed={x.id === 'mode' ? undefined : x.on} disabled={x.disabled} onClick={x.click}
              className="flex min-w-0 flex-1 cursor-pointer items-center gap-2.5 px-3 py-2.5 text-left disabled:cursor-default disabled:opacity-60">
              <Ico d={x.d} size={18} />
              <span className="flex min-w-0 flex-col"><span className="text-[13px] font-semibold">{x.title}</span><span className="truncate text-[11px]" style={{ color: x.on ? '#DCE7FF' : '#8FA3C8' }}>{x.sub}</span></span>
            </button>
            {x.section && onOpenSettings && (
              <button type="button" aria-label={t('qs.openSettings', { name: x.title })} title={t('qs.openSettings', { name: x.title })} onClick={() => onOpenSettings(x.section!)}
                className="flex w-7 shrink-0 cursor-pointer items-center justify-center border-l border-white/10 hover:bg-white/10"><Ico d={D.chevron} size={14} /></button>
            )}
          </span>
        ))}
      </div>
      <label className="flex items-center gap-2.5" title={sound ? undefined : t('common.unavailable')}>
        <button type="button" aria-label={sound?.muted ? t('qs.unmute') : t('qs.mute')} aria-pressed={sound?.muted ?? false} disabled={!sound} onClick={() => act(os.sysSetMute(!sound!.muted))} className="cursor-pointer disabled:cursor-default"><Ico d={sound?.muted ? D.volMute : D.speaker} stroke="#C9D6EE" /></button>
        <input type="range" min={0} max={100} aria-label={t('qs.volume')} disabled={!sound} value={vol ?? sound?.volume ?? 0}
          onChange={(e) => setVol(Number(e.target.value))} onPointerUp={() => { if (vol != null) act(os.sysSetVolume(vol).then(() => setVol(null))) }} onKeyUp={() => { if (vol != null) act(os.sysSetVolume(vol).then(() => setVol(null))) }}
          className="flex-1 accent-[#1F6BFF] disabled:opacity-50" />
      </label>
      <label className="flex items-center gap-2.5" title={light ? undefined : t('qs.noBacklight')}>
        <Ico d={D.sun} stroke="#C9D6EE" />
        <input type="range" min={1} max={100} aria-label={light ? t('qs.brightness') : `${t('qs.brightness')}: ${t('qs.noBacklight')}`} disabled={!light} value={bri ?? light?.percent ?? 100}
          onChange={(e) => setBri(Number(e.target.value))} onPointerUp={() => { if (bri != null) act(monitorApi.sysSetBrightness(bri).then(() => setBri(null))) }} onKeyUp={() => { if (bri != null) act(monitorApi.sysSetBrightness(bri).then(() => setBri(null))) }}
          className="flex-1 accent-[#1F6BFF] disabled:opacity-40" />
      </label>
      <div className="flex items-center justify-between gap-2 border-t border-[rgba(127,178,255,0.12)] pt-3 text-xs text-[#C9D6EE]">
        {batt && onOpenSettings
          ? <button type="button" onClick={() => onOpenSettings('Power')} title={t('qs.openSettings', { name: t('launcher.page.power') })} className="min-w-0 cursor-pointer truncate text-left hover:underline">{batt}</button>
          : <span className="min-w-0 truncate">{batt ?? (light ? '' : t('qs.noBacklight'))}</span>}
        <span className="flex shrink-0 gap-2">
          <button type="button" aria-label={t('quick.settings')} onClick={onSettings} className={foot}><Ico d={D.settings} /></button>
          <button type="button" aria-label={t('quick.lock')} onClick={onLock} className={foot}><Ico d={D.lock} /></button>
          <button type="button" aria-label={t('panel.power')} aria-haspopup="menu" data-power-toggle onClick={onPower} className={foot}><Ico d={D.power} /></button>
        </span>
      </div>
    </div>
  )
}

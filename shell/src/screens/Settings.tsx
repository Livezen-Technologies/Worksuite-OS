// Settings app (boards SetNav, SetNetwork, SetBluetooth, SetDisplay, SetAppearance, SetSound, SetPrivacy, SetUsers,
// UpdSettings, HwSettings). Every value comes from the OS bridge or the shell's own saved settings; where the bridge
// can't tell, the section says so instead of showing sample values.
import { useEffect, useMemo, useState, type ReactNode } from 'react'
import { cloudErrorText, formatDuration, lockChoiceLabel, os, policyLines, serverUrlFor, type Avail, type BatteryState, type CloudAccount, type DeviceInfo, type HwDevice, type LocalUser, type LockSettings, type SignOutChoice } from '../lib/os'
import { unavailableText, useSystem } from '../lib/useSystem'
import type { WindowProps } from './types'
import { ACCENTS, DEFAULT_PRIVACY, KEYS, THEMES, accentColor, applyAppearance, loadAppearance, readJson, writeJson, type Appearance, type Privacy } from '../lib/setup'
import { needsAttention, fmtWhen } from '../lib/updates'
import { useOsUpdate } from '../lib/useOsUpdate'
import { onSettingsSection, takeSettingsSection } from '../lib/settingsNav'
import { C, Dialog, Svg, Switch, btnGhost, btnPrimary, card, chip, dialogFooter, field, heroCard, linkBtn, rowLine, sectionLabel } from '../components/Dk'
import { AVATAR_GRADIENTS, Avatar, Mark } from '../components/Ws'
import { UpdatesPanel } from './Updates'
import { DeviceProblemDialog, DevicesPanel, DriversPanel, Empty } from './Hardware'

const NAV = [
  { id: 'Network', tint: '#1F6BFF', icon: 'M2 9a15 15 0 0 1 20 0M5.5 12.5a10 10 0 0 1 13 0M9 16a5 5 0 0 1 6 0' },
  { id: 'Bluetooth', tint: '#1F6BFF', icon: 'M7 7l10 10-5 5V2l5 5L7 17' },
  { id: 'Display', tint: '#0E8FA8', icon: 'M3 4h18v12H3zM8 20h8M12 16v4', sep: true },
  { id: 'Appearance', tint: '#7A4FE0', icon: 'M12 3a9 9 0 1 0 9 9c0-1.5-1.3-2-2.5-2H16a2 2 0 0 1 0-4h.5A9 9 0 0 0 12 3z' },
  { id: 'Sound', tint: '#D9572B', icon: 'M4 9v6h4l5 4V5L8 9zM16.5 8.5a5 5 0 0 1 0 7' },
  { id: 'Notifications', tint: '#D9452B', icon: 'M6 8a6 6 0 0 1 12 0c0 7 3 8 3 8H3s3-1 3-8M10 20a2 2 0 0 0 4 0' },
  { id: 'Privacy & security', tint: '#2E9E6A', icon: 'M12 3l8 3v6c0 5-3.5 8-8 9-4.5-1-8-4-8-9V6z', sep: true },
  { id: 'Users', tint: '#5E739C', icon: 'M9 8a3.5 3.5 0 1 0 0 .01M2.5 20c1-3.5 3.5-5 6.5-5s5.5 1.5 6.5 5M16 4.5a3.5 3.5 0 0 1 0 7' },
  { id: 'Devices', tint: '#5E739C', icon: 'M4 6h16v10H4zM2 20h20', sep: true },
  { id: 'Drivers', tint: '#5E739C', icon: 'M14.7 6.3a4 4 0 0 0-5.4 5.4L3 18l3 3 6.3-6.3a4 4 0 0 0 5.4-5.4l-2.5 2.5-2.4-.6-.6-2.4z' },
  { id: 'Updates', tint: '#1F6BFF', icon: 'M4 12a8 8 0 1 0 2.3-5.7M4 4v4h4' },
  { id: 'About', tint: '#5E739C', icon: 'M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18zM12 11v6M12 7.5h.01' },
] as const
export type Section = (typeof NAV)[number]['id']
const isSection = (s: string | null): s is Section => NAV.some((n) => n.id === s)
// Older names (launcher search, earlier builds) still land somewhere sensible.
const ALIAS: Record<string, Section> = { 'About this device': 'About', Accounts: 'Users', Privacy: 'Privacy & security', Displays: 'Display', Printers: 'Devices' }

type Res<T> = { state: 'loading' } | { state: 'ok'; value: T } | { state: 'unavailable'; reason: string }
/** Bridge answer (Avail) → loading / ok / unavailable, with optional polling (same hook as lib/useSystem). */
function useAvail<T>(load: () => Promise<Avail<T>>, pollMs?: number): { r: Res<T>; reload: () => Promise<void> } {
  const { state, reload } = useSystem(load, pollMs)
  const r: Res<T> = !state ? { state: 'loading' } : state.available ? { state: 'ok', value: state.value } : { state: 'unavailable', reason: state.reason }
  return { r, reload: async () => { await reload() } }
}

const H1 = ({ children, action }: { children: ReactNode; action?: ReactNode }) => (
  <div className="flex items-center justify-between gap-4"><h1 className="m-0 text-[28px] font-bold">{children}</h1>{action}</div>
)
function Rows({ rows }: { rows: { k: ReactNode; d?: ReactNode; v: ReactNode }[] }) {
  return (
    <div className={`${card} overflow-hidden`}>
      {rows.map((r, i) => (
        <div key={i} className={`flex items-center gap-4 px-[18px] py-3.5 ${rowLine}`}>
          <span className="flex flex-1 flex-col gap-0.5"><span className="text-sm font-medium">{r.k}</span>{r.d && <span className="text-xs text-[#8FA3C8]">{r.d}</span>}</span>
          <span className="text-[13px] text-[#C9D6EE]">{r.v}</span>
        </div>
      ))}
    </div>
  )
}
/** The boards' select look, read-only: shows the real value or "Unavailable". */
const Value = ({ children, min = 180 }: { children: ReactNode; min?: number }) => (
  <span className="box-border flex justify-between gap-3 rounded-[9px] border border-[rgba(127,178,255,0.25)] bg-[rgba(4,10,26,0.5)] px-3 py-[9px] text-[13px]" style={{ minWidth: min }}>
    {children ?? <span className="text-[#8FA3C8]">Unavailable</span>}
  </span>
)
const Unavail = ({ what, reason }: { what: string; reason?: string }) => <Empty title={`${what} isn't available`}>{reason ? `${unavailableText(reason)}.` : 'The shell couldn’t read this from the system.'}</Empty>
const Note = ({ children }: { children: ReactNode }) => <p className="m-0 text-xs leading-[1.5] text-[#8FA3C8]">{children}</p>

const WIFI_BARS = (s: number) => (s >= 67 ? 'M2 9a15 15 0 0 1 20 0M5.5 12.5a10 10 0 0 1 13 0M9 16a5 5 0 0 1 6 0' : s >= 34 ? 'M5.5 12.5a10 10 0 0 1 13 0M9 16a5 5 0 0 1 6 0' : 'M9 16a5 5 0 0 1 6 0')
const LOCK = 'M7 11V7a5 5 0 0 1 10 0v4M5 11h14v10H5z'

function NetworkPanel() {
  const { r, reload } = useAvail(os.sysNetwork, 15_000)
  const [join, setJoin] = useState<{ ssid: string; secure: boolean; password: string; error: string | null; busy: boolean } | null>(null)
  if (r.state !== 'ok') return <><H1>Network</H1>{r.state === 'loading' ? <Empty title="Reading network status…" /> : <Unavail what="Network information" reason={r.reason} />}</>
  const n = r.value
  const wifi = n.devices.find((d) => d.type === 'wifi')
  const eth = n.devices.filter((d) => d.type === 'ethernet')
  const active = n.networks.find((w) => w.in_use)
  const connect = async () => {
    if (!join) return
    setJoin({ ...join, busy: true, error: null })
    const res = await os.sysWifiConnect(join.ssid, join.password)
    if (res.ok) { setJoin(null); void reload() } else setJoin({ ...join, busy: false, password: '', error: res.error === 'bad_password' ? 'Wrong password. Try again.' : 'Couldn’t connect to that network.' })
  }
  return <>
    <H1>Network</H1>
    <div className={`${heroCard} flex items-center gap-4 px-5 py-[18px]`}>
      <span className="flex h-12 w-12 items-center justify-center rounded-xl bg-[#1F6BFF]"><Svg d={WIFI_BARS(100)} size={24} stroke="#FFFFFF" /></span>
      <span className="flex flex-1 flex-col gap-0.5">
        <span className="text-base font-semibold">Wi-Fi</span>
        <span className="text-[13px]" style={{ color: n.wifi_enabled && (active || wifi?.connection) ? C.green : C.muted }}>
          {!wifi ? 'No Wi-Fi adapter' : !n.wifi_enabled ? 'Off' : active || wifi.connection ? `Connected to ${active?.ssid ?? wifi.connection}` : 'Not connected'}
        </span>
      </span>
      {wifi && <Switch label="Wi-Fi" checked={n.wifi_enabled} onChange={(v) => void os.sysSetWifi(v).then(reload)} />}
    </div>
    {n.wifi_enabled && (
      <section aria-label="Available networks" className="flex flex-col gap-2">
        <h2 className={`m-0 font-normal ${sectionLabel}`}>Available networks</h2>
        {n.networks.length === 0 ? <Empty title="No networks found" /> : (
          <ul className={`${card} m-0 list-none overflow-hidden p-0`}>
            {n.networks.map((w) => (
              <li key={w.ssid} className={rowLine} style={{ background: w.in_use ? 'rgba(31,107,255,0.12)' : 'transparent' }}>
                <div className="flex items-center gap-3.5 px-[18px] py-[11px]">
                  <Svg d={WIFI_BARS(w.signal)} size={20} stroke={w.in_use ? C.cyan : C.soft} />
                  <span className="flex-1 text-sm" style={{ fontWeight: w.in_use ? 600 : 400 }}>{w.ssid}</span>
                  <span className="text-xs text-[#8FA3C8]">{w.in_use ? 'Connected' : w.security ? '' : 'Open'}</span>
                  {w.security && <Svg d={LOCK} size={14} stroke={C.muted} />}
                  <span className="sr-only">{w.security || 'Open'}, signal {w.signal}%</span>
                  {!w.in_use && join?.ssid !== w.ssid && <button type="button" onClick={() => setJoin({ ssid: w.ssid, secure: !!w.security, password: '', error: null, busy: false })} className={`${btnGhost} px-3 py-1.5 text-[13px]`}>Connect…</button>}
                </div>
                {join?.ssid === w.ssid && (
                  <form className="flex flex-wrap items-center gap-2 px-[18px] pb-3 pl-[52px]" onSubmit={(e) => { e.preventDefault(); void connect() }}>
                    {join.secure && <input type="password" aria-label={`Password for ${w.ssid}`} autoFocus value={join.password} onChange={(e) => setJoin({ ...join, password: e.target.value })} placeholder="Password" className={`${field} w-56`} />}
                    <button type="submit" disabled={join.busy} className={`${btnPrimary} px-4 py-2 text-[13px]`}>{join.busy ? 'Connecting…' : 'Connect'}</button>
                    <button type="button" disabled={join.busy} onClick={() => setJoin(null)} className={`${btnGhost} px-3 py-2 text-[13px]`}>Cancel</button>
                    {join.error && <span role="alert" className="text-[13px] text-[#FF8A7A]">{join.error}</span>}
                  </form>
                )}
              </li>
            ))}
          </ul>
        )}
      </section>
    )}
    <div className="grid grid-cols-3 gap-3">
      {[
        { t: 'Ethernet', d: eth.length ? (eth.some((e) => e.state === 'connected') ? `Connected${eth[0].connection ? ` · ${eth[0].connection}` : ''}` : 'Cable unplugged') : 'No Ethernet adapter' },
        { t: 'Adapters', d: n.devices.map((d) => d.device).join(', ') || 'None found' },
        { t: 'VPN and proxy', d: 'Not configurable here yet' },
      ].map((o) => <div key={o.t} className={`${card} flex flex-col gap-1.5 px-[18px] py-4`}><span className="text-sm font-semibold">{o.t}</span><span className="truncate text-[13px] text-[#8FA3C8]">{o.d}</span></div>)}
    </div>
  </>
}

function BluetoothPanel() {
  const { r, reload } = useAvail(os.sysBluetooth, 15_000)
  if (r.state !== 'ok') return <><H1>Bluetooth</H1>{r.state === 'loading' ? <Empty title="Reading Bluetooth status…" /> : <Unavail what="Bluetooth" reason={r.reason} />}</>
  const b = r.value
  return <>
    <H1>Bluetooth</H1>
    <div className={`${heroCard} flex items-center gap-4 px-5 py-[18px]`}>
      <span className="flex flex-1 flex-col gap-0.5">
        <span className="text-base font-semibold">Bluetooth</span>
        <span className="text-[13px] text-[#8FA3C8]">{!b.powered ? 'Off' : b.discoverable && b.name ? `Visible to nearby devices as "${b.name}"` : b.name ? `On · this computer is "${b.name}"` : 'On'}</span>
      </span>
      <Switch label="Bluetooth" checked={b.powered} onChange={(v) => void os.sysSetBluetooth(v).then(reload)} />
    </div>
    <section aria-label="My devices" className="flex flex-col gap-2">
      <h2 className={`m-0 font-normal ${sectionLabel}`}>My devices</h2>
      {b.paired.length === 0 ? <Empty title="No paired devices" /> : (
        <ul className={`${card} m-0 list-none overflow-hidden p-0`}>
          {b.paired.map((d) => (
            <li key={d.address} className={`flex items-center gap-3.5 px-[18px] py-[13px] ${rowLine}`}>
              <span className="flex h-9 w-9 items-center justify-center rounded-[10px] bg-[rgba(31,107,255,0.16)]"><Svg d="M7 7l10 10-5 5V2l5 5L7 17" size={18} stroke="#7FB2FF" /></span>
              <span className="flex flex-1 flex-col gap-0.5"><span className="text-sm font-medium">{d.name}</span><span className="text-xs" style={{ color: d.connected ? C.green : C.muted }}>{d.connected ? 'Connected' : 'Not connected'}</span></span>
              <button type="button" disabled={!b.powered} onClick={() => void os.sysBtConnect(d.address, !d.connected).then(reload)} className={`${btnGhost} px-3.5 py-2 text-[13px]`}>{d.connected ? 'Disconnect' : 'Connect'}</button>
            </li>
          ))}
        </ul>
      )}
    </section>
    <Note>Pairing new devices and scanning for nearby devices aren't available from Settings yet.</Note>
  </>
}

function DisplayPanel() {
  const { r } = useAvail(os.sysDisplays)
  if (r.state !== 'ok') return <><H1>Display</H1>{r.state === 'loading' ? <Empty title="Reading displays…" /> : <Unavail what="Display information" reason={r.reason} />}</>
  const outs = r.value.filter((d) => d.enabled)
  const primary = outs[0]
  return <>
    <H1>Display</H1>
    <div className="flex h-[200px] items-center justify-center gap-5 rounded-[14px] border border-[rgba(127,178,255,0.12)] bg-[rgba(4,10,26,0.5)]" aria-label="Connected displays" role="img">
      {outs.length === 0 && <span className="text-[13px] text-[#8FA3C8]">No connected displays reported</span>}
      {outs.map((o, i) => (
        <div key={o.name} className={`box-border flex items-end rounded-[10px] p-2.5 text-[13px] ${i === 0 ? 'h-[136px] w-[220px] border-2 border-[#1F6BFF] bg-[linear-gradient(160deg,#1F4FB0,#0A1A3D)] font-semibold' : 'h-[100px] w-[170px] border border-[rgba(127,178,255,0.3)] bg-[rgba(14,32,72,0.8)] text-[#C9D6EE]'}`}>
          {i + 1} · {o.description || o.name}
        </div>
      ))}
    </div>
    <div className={`${card} overflow-hidden`}>
      {[
        { k: 'Resolution', d: 'Current mode', v: primary?.width ? `${primary.width} × ${primary.height}` : null },
        { k: 'Scale', d: 'Make text and apps larger', v: primary?.scale ? `${Math.round(primary.scale * 100)}%` : null },
        { k: 'Refresh rate', d: 'Smoother motion', v: primary?.refresh ? `${Math.round(primary.refresh)} Hz` : null },
        { k: 'Brightness', d: 'Adjust the screen backlight', v: null },
        { k: 'Night light', d: 'Warmer colors at night', v: null },
      ].map((row) => (
        <div key={row.k} className={`flex items-center gap-4 px-[18px] py-3.5 ${rowLine}`}>
          <span className="flex flex-1 flex-col gap-0.5"><span className="text-sm font-medium">{row.k}</span><span className="text-xs text-[#8FA3C8]">{row.d}</span></span>
          <Value>{row.v}</Value>
        </div>
      ))}
    </div>
    <Note>Displays are shown as the compositor reports them; changing resolution, scale, brightness or night light from here isn't available yet.</Note>
  </>
}

const THEME_ART: Record<string, { bg: string; win: string; bar: string }> = {
  Light: { bg: 'linear-gradient(135deg,#EAF1FF,#C9DAFF)', win: '#FFFFFF', bar: 'rgba(255,255,255,0.8)' },
  Dark: { bg: 'linear-gradient(135deg,#0E2357,#060E22)', win: '#13264F', bar: 'rgba(255,255,255,0.08)' },
  Auto: { bg: 'linear-gradient(135deg,#EAF1FF 0%,#EAF1FF 50%,#0E2357 50%,#060E22 100%)', win: '#5E739C', bar: 'rgba(127,178,255,0.25)' },
}
function AppearancePanel() {
  const [a, setA] = useState<Appearance>(() => loadAppearance())
  const save = (n: Appearance) => { setA(n); writeJson(KEYS.appearance, n); applyAppearance(n) }
  const accent = accentColor(a.accent)
  const reduce = typeof matchMedia !== 'undefined' && matchMedia('(prefers-reduced-motion: reduce)').matches
  return <>
    <H1>Appearance</H1>
    <fieldset className="m-0 flex flex-col gap-2.5 border-0 p-0">
      <legend className="mb-2.5 p-0 text-sm font-semibold">Theme</legend>
      <div className="grid grid-cols-3 gap-3.5">
        {THEMES.map((t) => (
          <button key={t} type="button" aria-pressed={a.theme === t} onClick={() => save({ ...a, theme: t })}
            className="flex cursor-pointer flex-col gap-2.5 rounded-[14px] border-2 bg-[rgba(14,32,72,0.5)] p-2.5 text-left" style={{ borderColor: a.theme === t ? accent : 'transparent' }}>
            <span className="relative block h-[110px] overflow-hidden rounded-[9px]" style={{ background: THEME_ART[t].bg }} aria-hidden="true">
              <span className="absolute top-3.5 left-3.5 h-16 w-[100px] rounded-[7px]" style={{ background: THEME_ART[t].win }} />
              <span className="absolute top-6 left-[22px] h-[7px] w-[50px] rounded" style={{ background: accent }} />
              <span className="absolute inset-x-2 bottom-2 h-4 rounded-[5px]" style={{ background: THEME_ART[t].bar }} />
            </span>
            <span className="px-1 text-sm font-semibold">{t}</span>
          </button>
        ))}
      </div>
    </fieldset>
    <fieldset className="m-0 flex flex-col gap-2.5 border-0 p-0">
      <legend className="mb-2.5 p-0 text-sm font-semibold">Accent color</legend>
      <div className="flex gap-3.5">
        {ACCENTS.map((x) => (
          <button key={x.name} type="button" aria-label={x.name} aria-pressed={a.accent === x.name} onClick={() => save({ ...a, accent: x.name })}
            className="h-8 w-8 cursor-pointer rounded-full" style={{ background: x.color, boxShadow: a.accent === x.name ? '0 0 0 3px #0A1A3D, 0 0 0 5px #FFFFFF' : 'none' }} />
        ))}
      </div>
    </fieldset>
    <Rows rows={[
      { k: 'Wallpaper', v: 'WorkSuite (default)' },
      { k: 'Font', v: 'IBM Plex Sans' },
      { k: 'Reduce motion', v: reduce ? 'On (system setting)' : 'Off (system setting)' },
    ]} />
  </>
}

function SoundPanel() {
  const { r, reload } = useAvail(os.sysSound)
  const [vol, setVol] = useState<number | null>(null)
  if (r.state !== 'ok') return <><H1>Sound</H1>{r.state === 'loading' ? <Empty title="Reading sound devices…" /> : <Unavail what="Sound" reason={r.reason} />}</>
  const s = r.value
  const out = s.outputs.find((o) => o.is_default)
  const input = s.inputs.find((o) => o.is_default)
  const select = 'box-border min-w-[260px] rounded-[9px] border border-[rgba(127,178,255,0.25)] bg-[rgba(4,10,26,0.5)] px-3 py-[9px] text-[13px] text-[#E8EEFA]'
  const v = vol ?? s.volume
  return <>
    <H1>Sound</H1>
    <section aria-label="Output" className={`${card} flex flex-col gap-2.5 px-5 py-[18px]`}>
      <div className="flex items-center justify-between gap-3"><h2 className="m-0 text-[15px] font-semibold">Output</h2>
        {s.outputs.length > 1
          ? <select aria-label="Output device" value={out?.id ?? ''} onChange={(e) => void os.sysSetDefaultAudio(+e.target.value).then(reload)} className={select}>{s.outputs.map((o) => <option key={o.id} value={o.id} className="bg-[#0F2350]">{o.name}</option>)}</select>
          : <Value min={260}>{out?.name ?? null}</Value>}
      </div>
      <div className="flex items-center gap-3.5">
        <button type="button" aria-pressed={s.muted} aria-label="Mute" onClick={() => void os.sysSetMute(!s.muted).then(reload)} className="flex h-8 w-8 cursor-pointer items-center justify-center rounded-lg hover:bg-white/10">
          <Svg d={s.muted ? 'M4 9v6h4l5 4V5L8 9zM17 9l4 6M21 9l-4 6' : 'M4 9v6h4l5 4V5L8 9zM16.5 8.5a5 5 0 0 1 0 7'} size={20} stroke={C.soft} />
        </button>
        <input type="range" aria-label="Output volume" min={0} max={100} value={v} onChange={(e) => { setVol(+e.target.value); void os.sysSetVolume(+e.target.value) }} onPointerUp={() => void reload().then(() => setVol(null))} onKeyUp={() => void reload().then(() => setVol(null))} className="flex-1 accent-[#1F6BFF]" />
        <span className="w-[56px] text-right font-mono text-[13px]">{s.muted ? 'Muted' : `${v}%`}</span>
      </div>
    </section>
    <section aria-label="Input" className={`${card} flex items-center justify-between gap-3 px-5 py-[18px]`}>
      <h2 className="m-0 text-[15px] font-semibold">Input</h2><Value min={260}>{input?.name ?? null}</Value>
    </section>
    <Note>Input level, level meters and per-app volume aren't available yet.</Note>
  </>
}

function NotificationsPanel() {
  return <>
    <H1>Notifications</H1>
    <Rows rows={[
      { k: 'Do not disturb', d: 'Holds back pop-ups; notices still collect in the notification center', v: 'In quick settings' },
      { k: 'Sync', d: 'Offline, back online and sync problems', v: 'On' },
      { k: 'Updates', d: 'Update available, restart needed and update problems', v: 'On' },
      { k: 'New devices', d: 'A device was connected or needs a driver', v: 'On' },
    ]} />
    <Note>Per-app notification settings aren't available yet.</Note>
  </>
}

function PrivacyPanel() {
  const [p, setP] = useState<Privacy>(() => readJson<Privacy>(KEYS.privacy, DEFAULT_PRIVACY))
  const [info, setInfo] = useState<DeviceInfo | null>(null)
  const { status } = useOsUpdate()
  useEffect(() => { void os.deviceInfo().then(setInfo).catch(() => {}) }, [])
  const set = (k: keyof Privacy) => (v: boolean) => { const n = { ...p, [k]: v }; setP(n); writeJson(KEYS.privacy, n) }
  const enc = info?.device?.encrypted
  const good = { bg: 'rgba(95,211,154,0.08)', bd: 'rgba(95,211,154,0.3)', c: C.green }
  const warn = { bg: 'rgba(255,159,90,0.08)', bd: 'rgba(255,159,90,0.3)', c: C.amber }
  const unk = { bg: 'rgba(14,32,72,0.6)', bd: 'rgba(127,178,255,0.12)', c: C.muted }
  const cards = [
    { t: enc ? 'Disk encrypted' : enc === false ? 'Disk not encrypted' : 'Disk encryption', d: enc ? 'LUKS2 · on' : enc === false ? 'Data on this disk is readable if removed' : 'Status unavailable', tone: enc ? good : enc === false ? warn : unk, icon: 'M5 11h14v10H5zM8 11V7a4 4 0 0 1 8 0v4' },
    { t: 'Firewall', d: 'Status unavailable', tone: unk, icon: 'M12 3l8 3v6c0 5-3.5 8-8 9-4.5-1-8-4-8-9V6z' },
    status?.state === 'up_to_date'
      ? { t: 'Up to date', d: `Checked ${status.last_check ? fmtWhen(status.last_check) : '—'}`, tone: good, icon: 'M5 12.5l4.5 4.5L19 7.5' }
      : { t: needsAttention(status) ? 'Update waiting' : 'Updates', d: needsAttention(status) ? 'Open Updates to install' : status ? 'See Updates' : 'Status unavailable', tone: needsAttention(status) ? warn : unk, icon: 'M4 12a8 8 0 1 0 2.3-5.7M4 4v4h4' },
  ]
  const perms: { k: keyof Privacy; t: string; d: string; icon: string }[] = [
    { k: 'location', t: 'Location', d: 'Let apps ask for this computer’s location', icon: 'M12 21s-7-6.5-7-12a7 7 0 0 1 14 0c0 5.5-7 12-7 12z' },
    { k: 'updates', t: 'Automatic security updates', d: 'Install security fixes when the computer is idle', icon: 'M12 3l8 3v6c0 5-3.5 8-8 9-4.5-1-8-4-8-9V6z' },
    { k: 'crash', t: 'Send crash reports', d: 'Helps fix problems; no files or personal content', icon: 'M12 8v5M12 16.5v.5M10.3 3.9L1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0z' },
    { k: 'usage', t: 'Share usage statistics', d: 'Which features are used, never what you do in them', icon: 'M4 20V10M10 20V4M16 20v-7M22 20H2' },
  ]
  return <>
    <H1>Privacy &amp; security</H1>
    <div className="grid grid-cols-3 gap-3">
      {cards.map((c) => (
        <div key={c.t} className="flex items-center gap-3 rounded-[14px] border p-4" style={{ background: c.tone.bg, borderColor: c.tone.bd }}>
          <Svg d={c.icon} size={22} stroke={c.tone.c} />
          <span className="flex flex-col gap-0.5"><span className="text-sm font-semibold">{c.t}</span><span className="text-xs text-[#8FA3C8]">{c.d}</span></span>
        </div>
      ))}
    </div>
    <h2 className={`m-0 mt-1 font-normal ${sectionLabel}`}>Your choices</h2>
    <div className={`${card} overflow-hidden`}>
      {perms.map((x) => (
        <div key={x.k} className={`flex items-center gap-3.5 px-[18px] py-[13px] ${rowLine}`}>
          <Svg d={x.icon} size={20} stroke="#7FB2FF" />
          <span className="flex flex-1 flex-col gap-0.5"><span className="text-sm font-medium">{x.t}</span><span className="text-xs text-[#8FA3C8]">{x.d}</span></span>
          <Switch small label={x.t} checked={p[x.k]} onChange={set(x.k)} />
        </div>
      ))}
    </div>
    <Note>Per-app camera, microphone and screen-recording permissions aren't managed by WorkSuite OS yet. Your organization never gets keylogging, camera access or a remote shell.</Note>
  </>
}

/** WSOS-LOCK-003: idle lock timeout chosen by the user, within the organization's maximum (worksuite-idle applies it). */
function LockAfterRow() {
  const [s, setS] = useState<LockSettings | null>(null)
  const [err, setErr] = useState<string | null>(null)
  useEffect(() => { void os.lockSettings().then(setS).catch(() => setErr('Screen lock settings are unavailable.')) }, [])
  const change = async (v: number) => {
    const r = await os.setLockTimeout(v)
    if (r.ok) { setS(r.value); setErr(null) } else setErr(r.error === 'above_policy_maximum' ? 'Your organization does not allow a longer time.' : 'Could not save this setting.')
  }
  const help = err ?? (!s ? 'Loading…' : s.max_s !== null ? `Your organization allows up to ${lockChoiceLabel(s.max_s)}` : 'Also locks before sleep')
  return (
    <div className={`flex items-center gap-4 px-[18px] py-3.5 ${rowLine}`}>
      <span className="flex flex-1 flex-col gap-0.5"><span className="text-sm">Lock screen after</span><span className="text-xs text-[#8FA3C8]" role={err ? 'alert' : undefined}>{help}</span></span>
      {s?.max_s != null && <span className={chip}>Set by policy</span>}
      {s && <select aria-label="Lock screen after" value={s.timeout_s} onChange={(e) => void change(Number(e.target.value))}
        className="h-9 rounded-lg border border-[rgba(127,178,255,0.25)] bg-[rgba(4,10,26,0.5)] px-2 text-[13px] text-white">
        {s.choices.map((c) => <option key={c} value={c}>{lockChoiceLabel(c)}</option>)}
      </select>}
    </div>
  )
}

function UsersPanel() {
  const { r } = useAvail(os.sysUsers)
  const me = r.state === 'ok' ? r.value.users.find((u) => u.login === r.value.current) ?? null : null
  const others = r.state === 'ok' ? r.value.users.filter((u) => u.login !== r.value.current) : []
  return <>
    <H1>Users</H1>
    {r.state === 'unavailable' && <Unavail what="The user list" />}
    {r.state === 'ok' && (
      <div className={`${heroCard} flex items-center gap-5 rounded-2xl p-[22px]`}>
        <Avatar name={me?.name ?? r.value.current} size={80} font={28} />
        <span className="flex flex-1 flex-col gap-1">
          <span className="text-xl font-bold">{me?.name ?? r.value.current}</span>
          <span className="text-[13px] text-[#8FA3C8]">{r.value.current}{me ? ` · ${me.admin ? 'Administrator' : 'Standard user'}` : ''} · you</span>
        </span>
      </div>
    )}
    <div className={`${card} overflow-hidden`}>
      <div className={`flex items-center gap-4 px-[18px] py-3.5 ${rowLine}`}><span className="flex-1 text-sm">Sign-in method</span><span className="text-[13px] text-[#C9D6EE]">Password</span></div>
      <div className={`flex items-center gap-4 px-[18px] py-3.5 ${rowLine}`}>
        <span className="flex flex-1 flex-col gap-0.5"><span className="text-sm">Sign in automatically</span><span className="text-xs text-[#8FA3C8]">WorkSuite OS always asks for a password</span></span>
        <span className={chip}>Not allowed</span>
        <Switch small label="Sign in automatically" checked={false} disabled />
      </div>
      <LockAfterRow />
    </div>
    <section aria-labelledby="ws-acct" className="flex flex-col gap-2">
      <h2 id="ws-acct" className={`m-0 font-normal ${sectionLabel}`}>WorkSuite account</h2>
      <div className={`${card} overflow-hidden`}><CloudAccounts /></div>
    </section>
    {others.length > 0 && (
      <section aria-labelledby="other-users" className="flex flex-col gap-2">
        <h2 id="other-users" className={`m-0 font-normal ${sectionLabel}`}>Other users</h2>
        <ul className={`${card} m-0 list-none overflow-hidden p-0`}>
          {others.map((u: LocalUser, i) => (
            <li key={u.login} className={`flex items-center gap-3.5 px-[18px] py-[13px] ${rowLine}`}>
              <Avatar name={u.name} size={38} font={14} bg={AVATAR_GRADIENTS[(i + 1) % AVATAR_GRADIENTS.length]} />
              <span className="flex flex-1 flex-col gap-0.5"><span className="text-sm font-medium">{u.name}</span><span className="text-xs text-[#8FA3C8]">{u.login} · {u.admin ? 'Administrator' : 'Standard user'}</span></span>
            </li>
          ))}
        </ul>
      </section>
    )}
    <Note>Adding users and changing passwords aren't available from Settings yet.</Note>
  </>
}

function batteryText(b: BatteryState): string {
  const eta = b.state === 'charging' ? formatDuration(b.time_to_full_s) : b.on_battery ? formatDuration(b.time_to_empty_s) : null
  const what = b.state === 'charging' ? 'charging' : b.on_battery ? 'on battery' : b.state === 'fully-charged' ? 'fully charged' : 'plugged in'
  return `${b.percentage == null ? '—' : `${b.percentage}%`} · ${what}${eta ? ` · ${eta} ${b.state === 'charging' ? 'to full' : 'left'}` : ''}`
}

function AboutPanel() {
  const { r: disks } = useAvail(os.sysDisks)
  const { r: battery } = useAvail(os.sysBattery, 60_000)
  const [showWipe, setShowWipe] = useState(false)
  const [info, setInfo] = useState<DeviceInfo | null>(null)
  useEffect(() => { void os.deviceInfo().then(setInfo).catch(() => {}) }, [])
  if (!info) return <><H1>About</H1><Empty title="Loading device information…" /></>
  const d = info.device
  const lines = policyLines(info.policies)
  const checked = info.last_check_in ? new Date(info.last_check_in).toLocaleString([], { dateStyle: 'medium', timeStyle: 'short' }) : 'not yet'
  return <>
    <H1>About</H1>
    <div className={`${heroCard} flex items-center gap-5 rounded-2xl p-[22px]`}>
      <span className="flex h-20 w-20 items-center justify-center rounded-2xl bg-[rgba(31,107,255,0.18)]"><Mark size={48} hole="#0F2350" /></span>
      <span className="flex flex-col gap-1"><span className="text-xl font-bold">WorkSuite OS</span><span className="text-[13px] text-[#8FA3C8]">{d?.os_version ?? 'Version unknown'}</span></span>
    </div>
    <Rows rows={[
      { k: 'Device name', v: d?.hostname ?? 'Unknown' },
      { k: 'Architecture', v: d?.arch === 'arm64' ? 'ARM64 (arm64)' : d?.arch === 'amd64' ? 'x86-64 (amd64)' : 'Unknown' },
      { k: 'Kernel', v: d?.kernel_version ?? 'Unknown' },
      { k: 'Disk encryption', v: d?.encrypted == null ? 'Unknown' : d.encrypted ? 'Encrypted (LUKS2)' : 'Not encrypted' },
      { k: 'Storage', v: disks.state === 'ok' ? disks.value.map((x) => x.model || x.device).join(', ') || 'None found' : disks.state === 'loading' ? '…' : 'Unknown' },
      { k: 'Battery', v: battery.state === 'ok' ? batteryText(battery.value) : battery.state === 'loading' ? '…' : 'No battery' },
    ]} />
    {/* WSOS-MDM-007: management disclosure, from the device agent */}
    {info.managed ? (
      <section aria-label="Device management" className="flex flex-col gap-2.5 rounded-[14px] border border-[rgba(31,107,255,0.35)] bg-[rgba(31,107,255,0.1)] px-5 py-[18px]">
        <span className="flex items-center gap-2 text-sm font-semibold"><Svg d="M12 3l8 3v6c0 5-3.5 8-8 9-4.5-1-8-4-8-9V6z" size={18} stroke="#7FB2FF" />Managed by {info.org_name ?? info.server ?? 'your organization'}</span>
        <ul className="m-0 list-disc pl-[18px] text-[13px] leading-relaxed text-[#C9D6EE]">
          {lines.map((l) => <li key={l}>{l}</li>)}
          <li>Your organization can remotely lock this device and wipe WorkSuite data{d?.encrypted ? ' or the whole device' : ''}</li>
        </ul>
        <span className="text-xs text-[#8FA3C8]">{info.server ? `${info.server} · ` : ''}Last policy check {checked} · no keylogging, camera access or remote shell</span>
        {/* WSOS-WIPE-007: explain wipe scope */}
        <button type="button" aria-expanded={showWipe} onClick={() => setShowWipe((v) => !v)} className={`${linkBtn} self-start`}>{showWipe ? 'Hide' : 'What a remote wipe does'}</button>
        {showWipe && (
          <div className="rounded-[10px] border border-[rgba(127,178,255,0.16)] bg-[rgba(4,10,26,0.4)] p-3 text-[12.5px] leading-relaxed text-[#C9D6EE]">
            <p className="m-0"><strong>WorkSuite data wipe</strong> signs everyone out and removes WorkSuite accounts, synced WorkSuite files and the WorkSuite Drive folder for every user. Other files in home folders stay.</p>
            <p className="mb-0 mt-2"><strong>Full device wipe</strong>{d?.encrypted ? ' destroys the disk encryption keys, making all data unrecoverable, then restarts the computer.' : ' is only possible on encrypted devices; this one is not encrypted.'}</p>
            <p className="mb-0 mt-2">Every wipe needs an administrator plus a second approver and is recorded by your organization.</p>
          </div>
        )}
      </section>
    ) : info.agent ? <EnrollCard onEnrolled={() => void os.deviceInfo().then(setInfo)} />
      : <Empty title="Management status is unavailable">The WorkSuite device agent isn’t running.</Empty>}
  </>
}

/** Enroll an unmanaged device with an organization (§9.3); same path as first-run: device agent via pkexec. */
function EnrollCard({ onEnrolled }: { onEnrolled: () => void }) {
  const [open, setOpen] = useState(false)
  const [server, setServer] = useState('')
  const [code, setCode] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const submit = async (e: React.FormEvent) => {
    e.preventDefault()
    if (!server.trim() || !code.trim()) return setError('Enter the server address and the enrollment code from your IT admin.')
    setBusy(true); setError(null)
    const r = await os.enrollDevice(serverUrlFor('enterprise', server), code)
    setBusy(false)
    if (!r.ok) return setError(cloudErrorText(r.error))
    onEnrolled()
  }
  return (
    <div className={`${card} flex flex-col gap-3 px-5 py-[18px] text-[13px]`}>
      <span className="text-[#8FA3C8]">This device isn’t managed by an organization.</span>
      {!open ? <button type="button" onClick={() => setOpen(true)} className={`${btnGhost} self-start`}>Enroll with an organization…</button> : (
        <form onSubmit={submit} className="flex flex-col gap-3" aria-label="Enroll this device">
          <p className="m-0 text-[#8FA3C8]">Your organization will be able to apply its policies and updates, and lock or wipe this device remotely. An administrator password is needed.</p>
          <label className="flex flex-col gap-1 font-semibold">Server address
            <input value={server} onChange={(e) => { setServer(e.target.value); setError(null) }} placeholder="work.example.com" spellCheck={false} className={`${field} font-normal`} />
          </label>
          <label className="flex flex-col gap-1 font-semibold">Enrollment code
            <input value={code} onChange={(e) => { setCode(e.target.value.toUpperCase()); setError(null) }} autoComplete="off" spellCheck={false} className={`${field} w-[260px] max-w-full font-mono font-normal tracking-[1px]`} />
          </label>
          {error && <p role="alert" className="m-0 text-[#FF8A7A]">{error}</p>}
          <div className="flex gap-2">
            <button type="submit" disabled={busy} className={btnPrimary}>{busy ? 'Enrolling…' : 'Enroll this device'}</button>
            <button type="button" disabled={busy} onClick={() => { setOpen(false); setError(null) }} className={btnGhost}>Cancel</button>
          </div>
        </form>
      )}
    </div>
  )
}

/** WorkSuite cloud sign-ins held by the credentials broker. Sign-out drops the keyring entry and revokes it. */
function CloudAccounts() {
  const [accounts, setAccounts] = useState<CloudAccount[] | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)
  const [prompt, setPrompt] = useState<{ account: CloudAccount; unsent: number } | null>(null)
  const load = () => os.cloudAccounts().then((r) => (r.ok ? setAccounts(r.value) : setError(cloudErrorText(r.error))))
  useEffect(() => { void load() }, [])
  const finish = async (a: CloudAccount, choice: SignOutChoice) => {
    const r = await os.cloudSignOut(a.id, choice)
    setPrompt(null)
    if (!r.ok) { setError(cloudErrorText(r.error)); return }
    setNotice(r.value.exported ? `Signed out. Unsent changes were saved to ${r.value.exported}` : 'Signed out.')
    void load()
  }
  // WSOS-SYN-008: never sign out silently over unsent changes.
  const signOut = async (a: CloudAccount) => {
    setError(null); setNotice(null)
    const r = await os.syncUnsent(a.id)
    if (!r.ok) { setError(cloudErrorText(r.error)); return }
    if (r.value === 0) return finish(a, 'none')
    setPrompt({ account: a, unsent: r.value })
  }
  const row = (k: ReactNode, d: ReactNode, v: ReactNode, key?: string) => (
    <div key={key} className={`flex items-center gap-4 px-[18px] py-3.5 ${rowLine}`}><span className="flex flex-1 flex-col gap-0.5"><span className="text-sm">{k}</span>{d && <span className="text-xs text-[#8FA3C8]">{d}</span>}</span>{v}</div>
  )
  if (error && !accounts) return row('WorkSuite account', error, <span className="text-[13px] text-[#8FA3C8]">Unavailable</span>)
  if (!accounts) return row('WorkSuite account', null, <span className="text-[13px] text-[#8FA3C8]">Loading…</span>)
  return <>
    {(error || notice) && <p role="status" className={`m-0 px-[18px] py-3 text-[13px] ${rowLine}`} style={{ color: error ? C.red : C.green }}>{error ?? notice}</p>}
    {accounts.length === 0
      ? row('Not signed in', 'Sign in from first-run setup to sync.', <span className="text-[13px] text-[#8FA3C8]">Signed out</span>)
      : accounts.map((a) => row(a.name ?? 'WorkSuite account', `${a.server_url}${a.state === 'refresh_failed' ? ' · sign in again to resume sync' : ''}`,
        <button type="button" onClick={() => void signOut(a)} className={`${btnGhost} px-3.5 py-2 text-[13px]`}>Sign out</button>, a.id))}
    {prompt && <UnsentDialog {...prompt} onCancel={() => setPrompt(null)} onChoose={(c) => finish(prompt.account, c)} />}
  </>
}

/** Wait to sync, export, or discard (confirmed) — the three choices SRS WSOS-SYN-008 requires. */
function UnsentDialog({ account, unsent, onCancel, onChoose }: { account: CloudAccount; unsent: number; onCancel: () => void; onChoose: (c: SignOutChoice) => Promise<void> }) {
  const [left, setLeft] = useState(unsent)
  const [waiting, setWaiting] = useState(false)
  const [confirmDiscard, setConfirmDiscard] = useState(false)
  const [busy, setBusy] = useState(false)
  const n = (k: number) => `${k} unsent change${k === 1 ? '' : 's'}`
  // "Wait to sync": ask for a sync and check every 2 s; sign out once nothing is left.
  useEffect(() => {
    if (!waiting) return
    let stop = false
    const tick = async () => {
      if (stop) return
      await os.syncNow()
      const r = await os.syncUnsent(account.id)
      if (stop) return
      if (r.ok && r.value === 0) { stop = true; await onChoose('none'); return }
      if (r.ok) setLeft(r.value)
      timer = setTimeout(tick, 2000)
    }
    let timer = setTimeout(tick, 0)
    return () => { stop = true; clearTimeout(timer) }
  }, [waiting, account.id, onChoose])
  const run = async (c: SignOutChoice) => { setBusy(true); await onChoose(c); setBusy(false) }
  return (
    <Dialog width={460} alert onClose={busy ? undefined : onCancel}>
      {(tid) => <>
        <div className="flex flex-col gap-3 px-6 pt-6 pb-4">
          <h2 id={tid} className="m-0 text-[19px] font-bold">{n(left)}</h2>
          <p className="m-0 text-sm text-[#C9D6EE]">Changes you made offline haven’t reached {account.server_url} yet. Signing out removes WorkSuite data from this computer, so choose what happens to them.</p>
          {waiting ? (
            <div className="flex items-center justify-between gap-3 rounded-xl bg-[rgba(31,107,255,0.12)] px-4 py-3 text-sm" aria-live="polite">
              <span>Syncing… you’ll be signed out when everything has reached the server.</span>
              <button type="button" onClick={() => setWaiting(false)} className={linkBtn}>Stop waiting</button>
            </div>
          ) : confirmDiscard ? (
            <div className="flex flex-col gap-3 rounded-xl border border-[rgba(255,138,122,0.3)] bg-[rgba(255,138,122,0.08)] px-4 py-3 text-sm">
              <span>Discard {n(left)}? They can’t be recovered.</span>
              <div className="flex justify-end gap-2">
                <button type="button" disabled={busy} onClick={() => setConfirmDiscard(false)} className={btnGhost}>Keep them</button>
                <button type="button" disabled={busy} onClick={() => void run('discard')} className={`${btnPrimary} bg-[#D9452B] hover:bg-[#E5573D]`}>Discard and sign out</button>
              </div>
            </div>
          ) : (
            <div className="flex flex-col gap-2">
              <button type="button" disabled={busy} onClick={() => setWaiting(true)} className={btnPrimary}>Wait to sync, then sign out</button>
              <button type="button" disabled={busy} onClick={() => void run('export')} className={btnGhost}>Save changes to a file and sign out</button>
              <button type="button" disabled={busy} onClick={() => setConfirmDiscard(true)} className={`${btnGhost} text-[#FF8A7A]`}>Discard changes…</button>
            </div>
          )}
        </div>
        <div className={dialogFooter}><button type="button" disabled={busy} onClick={onCancel} className={btnGhost}>Cancel — stay signed in</button></div>
      </>}
    </Dialog>
  )
}

function SetNav({ section, onPick, badges, user }: { section: Section; onPick: (s: Section) => void; badges: Partial<Record<Section, string>>; user: { name: string; role: string } | null }) {
  const [q, setQ] = useState('')
  const items = NAV.filter((n) => n.id.toLowerCase().includes(q.trim().toLowerCase()))
  return (
    <nav aria-label="Settings" className="box-border flex w-[260px] shrink-0 flex-col gap-3.5 overflow-auto border-r border-[rgba(127,178,255,0.12)] bg-[#071330] px-3.5 py-5">
      <div className="flex items-center gap-3 px-2 pt-2 pb-1">
        <Avatar name={user?.name ?? '?'} size={40} font={14} />
        <span className="flex min-w-0 flex-col gap-px"><span className="truncate text-sm font-semibold">{user?.name ?? 'This computer'}</span><span className="text-xs text-[#8FA3C8]">{user?.role ?? 'Settings'}</span></span>
      </div>
      <label className="flex h-[38px] items-center gap-2 rounded-[9px] border border-[rgba(127,178,255,0.14)] bg-[rgba(4,10,26,0.5)] px-3 text-[13px] text-[#8FA3C8] focus-within:border-[#1F6BFF]">
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="#8FA3C8" strokeWidth="2.2" strokeLinecap="round" aria-hidden="true"><circle cx="11" cy="11" r="7" /><path d="M20 20l-4-4" /></svg>
        <span className="sr-only">Search settings</span>
        <input type="search" value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search settings" className="min-w-0 flex-1 border-0 bg-transparent text-[13px] text-[#E8EEFA] outline-none placeholder:text-[#8FA3C8]" />
      </label>
      <ul className="m-0 flex list-none flex-col gap-px p-0">
        {items.map((n) => {
          const on = n.id === section
          const badge = badges[n.id]
          return (
            <li key={n.id}>
              {'sep' in n && n.sep && !q && <div className="mx-2 my-1.5 h-px bg-[rgba(127,178,255,0.1)]" aria-hidden="true" />}
              <button type="button" aria-current={on ? 'page' : undefined} onClick={() => onPick(n.id)}
                className={`flex w-full cursor-pointer items-center gap-3 rounded-lg px-2.5 py-2 text-left text-sm ${on ? 'bg-[rgba(31,107,255,0.2)] font-semibold text-white' : 'text-[#C9D6EE] hover:bg-white/[0.05]'}`}>
                <span className="flex h-[26px] w-[26px] shrink-0 items-center justify-center rounded-[7px]" style={{ background: n.tint }}><Svg d={n.icon} size={15} stroke="#FFFFFF" width={2.2} /></span>
                {n.id}
                {badge && <span className="ml-auto flex h-[18px] min-w-[18px] items-center justify-center rounded-[9px] bg-[#1F6BFF] px-[5px] text-[11px] font-bold text-white" aria-label={`${badge} pending`}>{badge}</span>}
              </button>
            </li>
          )
        })}
        {!items.length && <li className="px-2.5 py-2 text-[13px] text-[#8FA3C8]">No settings match.</li>}
      </ul>
    </nav>
  )
}

export default function Settings({ onClose }: WindowProps) {
  const [section, setSection] = useState<Section>(() => {
    const s = takeSettingsSection()
    return isSection(s) ? s : (s && ALIAS[s]) || 'Network'
  })
  const [problem, setProblem] = useState<HwDevice | null>(null)
  const [driverCount, setDriverCount] = useState(0)
  const [user, setUser] = useState<{ name: string; role: string } | null>(null)
  const { status } = useOsUpdate()
  useEffect(() => onSettingsSection((s) => setSection(isSection(s) ? s : ALIAS[s] ?? 'Network')), [])
  useEffect(() => {
    void os.hwDriverUpdates().then((r) => setDriverCount(r.ok ? r.value.length : 0)).catch(() => {})
    void os.sysUsers().then((r) => {
      if (!r.available) return
      const me = r.value.users.find((u) => u.login === r.value.current)
      setUser({ name: me?.name ?? r.value.current, role: me ? (me.admin ? 'Administrator' : 'Standard user') : 'Signed in' })
    }).catch(() => {})
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape' && !document.querySelector('[aria-modal="true"]')) onClose() }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])
  const badges = useMemo(() => ({ ...(driverCount ? { Drivers: String(driverCount) } : {}), ...(needsAttention(status) ? { Updates: '1' } : {}) }), [driverCount, status])

  return (
    <div role="dialog" aria-modal="false" aria-label="Settings" className="fixed inset-0 z-50 flex bg-[#0A1A3D] font-sans text-[#E8EEFA]">
      <SetNav section={section} onPick={setSection} badges={badges} user={user} />
      <main className="relative flex min-w-0 flex-1 flex-col gap-5 overflow-auto px-11 py-8" style={{ background: 'radial-gradient(ellipse 80% 50% at 80% 0%, #12306B 0%, #0A1A3D 60%)' }}>
        <button type="button" aria-label="Close Settings" onClick={onClose} className="absolute top-4 right-4 flex h-9 w-9 cursor-pointer items-center justify-center rounded-lg text-[#8FA3C8] hover:bg-white/10 hover:text-white">
          <Svg d="M6 6l12 12M18 6L6 18" size={16} />
        </button>
        {section === 'Network' && <NetworkPanel />}
        {section === 'Bluetooth' && <BluetoothPanel />}
        {section === 'Display' && <DisplayPanel />}
        {section === 'Appearance' && <AppearancePanel />}
        {section === 'Sound' && <SoundPanel />}
        {section === 'Notifications' && <NotificationsPanel />}
        {section === 'Privacy & security' && <PrivacyPanel />}
        {section === 'Users' && <UsersPanel />}
        {section === 'Devices' && <DevicesPanel onProblem={setProblem} />}
        {section === 'Drivers' && <DriversPanel onOpenUpdates={() => setSection('Updates')} />}
        {section === 'Updates' && <><H1>Updates</H1><UpdatesPanel /></>}
        {section === 'About' && <AboutPanel />}
      </main>
      {problem && <DeviceProblemDialog device={problem} onClose={() => setProblem(null)} onOpenUpdates={() => setSection('Updates')} onOpenDrivers={() => setSection('Drivers')} />}
    </div>
  )
}


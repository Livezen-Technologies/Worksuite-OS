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
import { vpnErrorText } from '../lib/vpn'
import { C, Dialog, Svg, Switch, btnGhost, btnPrimary, card, chip, dialogFooter, field, heroCard, linkBtn, rowLine, sectionLabel } from '../components/Dk'
import { AVATAR_GRADIENTS, Avatar, Mark } from '../components/Ws'
import { UpdatesPanel } from './Updates'
import { DeviceProblemDialog, DevicesPanel, DriversPanel, Empty } from './Hardware'
import { formatDate, formatNumber, t, type MessageKey } from '../i18n'

const NAV = [
  { id: 'Network', tint: '#1F6BFF', icon: 'M2 9a15 15 0 0 1 20 0M5.5 12.5a10 10 0 0 1 13 0M9 16a5 5 0 0 1 6 0' },
  { id: 'Bluetooth', tint: '#1F6BFF', icon: 'M7 7l10 10-5 5V2l5 5L7 17' },
  { id: 'Display', tint: '#0E8FA8', icon: 'M3 4h18v12H3zM8 20h8M12 16v4', sep: true },
  { id: 'Appearance', tint: '#7A4FE0', icon: 'M12 3a9 9 0 1 0 9 9c0-1.5-1.3-2-2.5-2H16a2 2 0 0 1 0-4h.5A9 9 0 0 0 12 3z' },
  { id: 'Sound', tint: '#D9572B', icon: 'M4 9v6h4l5 4V5L8 9zM16.5 8.5a5 5 0 0 1 0 7' },
  { id: 'Notifications', tint: '#D9452B', icon: 'M6 8a6 6 0 0 1 12 0c0 7 3 8 3 8H3s3-1 3-8M10 20a2 2 0 0 0 4 0' },
  { id: 'Default apps', tint: '#0E8FA8', icon: 'M4 4h7v7H4zM13 4h7v7h-7zM4 13h7v7H4zM13 16.5h7M16.5 13v7' },
  { id: 'Privacy & security', tint: '#2E9E6A', icon: 'M12 3l8 3v6c0 5-3.5 8-8 9-4.5-1-8-4-8-9V6z', sep: true },
  { id: 'Users', tint: '#8FA3C8', icon: 'M9 8a3.5 3.5 0 1 0 0 .01M2.5 20c1-3.5 3.5-5 6.5-5s5.5 1.5 6.5 5M16 4.5a3.5 3.5 0 0 1 0 7' },
  { id: 'Devices', tint: '#8FA3C8', icon: 'M4 6h16v10H4zM2 20h20', sep: true },
  { id: 'Drivers', tint: '#8FA3C8', icon: 'M14.7 6.3a4 4 0 0 0-5.4 5.4L3 18l3 3 6.3-6.3a4 4 0 0 0 5.4-5.4l-2.5 2.5-2.4-.6-.6-2.4z' },
  { id: 'Updates', tint: '#1F6BFF', icon: 'M4 12a8 8 0 1 0 2.3-5.7M4 4v4h4' },
  { id: 'About', tint: '#8FA3C8', icon: 'M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18zM12 11v6M12 7.5h.01' },
] as const
export type Section = (typeof NAV)[number]['id']
const isSection = (s: string | null): s is Section => NAV.some((n) => n.id === s)
const navLabel = (id: Section) => t(`settings.nav.${id}` as MessageKey)
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
    {children ?? <span className="text-[#8FA3C8]">{t('common.unavailable')}</span>}
  </span>
)
const Unavail = ({ what, reason }: { what: string; reason?: string }) => <Empty title={t('settings.notAvailable', { what })}>{reason ? `${unavailableText(reason)}.` : t('settings.couldNotRead')}</Empty>
const Note = ({ children }: { children: ReactNode }) => <p className="m-0 text-xs leading-[1.5] text-[#8FA3C8]">{children}</p>

const WIFI_BARS = (s: number) => (s >= 67 ? 'M2 9a15 15 0 0 1 20 0M5.5 12.5a10 10 0 0 1 13 0M9 16a5 5 0 0 1 6 0' : s >= 34 ? 'M5.5 12.5a10 10 0 0 1 13 0M9 16a5 5 0 0 1 6 0' : 'M9 16a5 5 0 0 1 6 0')
const LOCK = 'M7 11V7a5 5 0 0 1 10 0v4M5 11h14v10H5z'

function NetworkPanel() {
  const { r, reload } = useAvail(os.sysNetwork, 15_000)
  const [join, setJoin] = useState<{ ssid: string; secure: boolean; password: string; error: string | null; busy: boolean } | null>(null)
  if (r.state !== 'ok') return <><H1>{t('settings.nav.Network')}</H1>{r.state === 'loading' ? <Empty title={t('settings.net.reading')} /> : <Unavail what={t('settings.net.info')} reason={r.reason} />}</>
  const n = r.value
  const wifi = n.devices.find((d) => d.type === 'wifi')
  const eth = n.devices.filter((d) => d.type === 'ethernet')
  const active = n.networks.find((w) => w.in_use)
  const connect = async () => {
    if (!join) return
    setJoin({ ...join, busy: true, error: null })
    const res = await os.sysWifiConnect(join.ssid, join.password)
    if (res.ok) { setJoin(null); void reload() } else setJoin({ ...join, busy: false, password: '', error: res.error === 'bad_password' ? t('settings.net.badPassword') : t('settings.net.connectFailed') })
  }
  return <>
    <H1>{t('settings.nav.Network')}</H1>
    <div className={`${heroCard} flex items-center gap-4 px-5 py-[18px]`}>
      <span className="flex h-12 w-12 items-center justify-center rounded-xl bg-[#1F6BFF]"><Svg d={WIFI_BARS(100)} size={24} stroke="#FFFFFF" /></span>
      <span className="flex flex-1 flex-col gap-0.5">
        <span className="text-base font-semibold">{t('settings.net.wifi')}</span>
        <span className="text-[13px]" style={{ color: n.wifi_enabled && (active || wifi?.connection) ? C.green : C.muted }}>
          {!wifi ? t('settings.net.noWifi') : !n.wifi_enabled ? t('common.off') : active || wifi.connection ? t('settings.net.connectedTo', { name: active?.ssid ?? wifi.connection ?? '' }) : t('common.notConnected')}
        </span>
      </span>
      {wifi && <Switch label={t('settings.net.wifi')} checked={n.wifi_enabled} onChange={(v) => void os.sysSetWifi(v).then(reload)} />}
    </div>
    {n.wifi_enabled && (
      <section aria-label={t('settings.net.available')} className="flex flex-col gap-2">
        <h2 className={`m-0 font-normal ${sectionLabel}`}>{t('settings.net.available')}</h2>
        {n.networks.length === 0 ? <Empty title={t('settings.net.none')} /> : (
          <ul className={`${card} m-0 list-none overflow-hidden p-0`}>
            {n.networks.map((w) => (
              <li key={w.ssid} className={rowLine} style={{ background: w.in_use ? 'rgba(31,107,255,0.12)' : 'transparent' }}>
                <div className="flex items-center gap-3.5 px-[18px] py-[11px]">
                  <Svg d={WIFI_BARS(w.signal)} size={20} stroke={w.in_use ? C.cyan : C.soft} />
                  <span className="flex-1 text-sm" style={{ fontWeight: w.in_use ? 600 : 400 }}>{w.ssid}</span>
                  <span className="text-xs text-[#8FA3C8]">{w.in_use ? t('common.connected') : w.security ? '' : t('settings.net.open')}</span>
                  {w.security && <Svg d={LOCK} size={14} stroke={C.muted} />}
                  <span className="sr-only">{t('settings.net.signal', { security: w.security || t('settings.net.open'), signal: w.signal })}</span>
                  {!w.in_use && join?.ssid !== w.ssid && <button type="button" onClick={() => setJoin({ ssid: w.ssid, secure: !!w.security, password: '', error: null, busy: false })} className={`${btnGhost} px-3 py-1.5 text-[13px]`}>{t('settings.net.connectEllipsis')}</button>}
                </div>
                {join?.ssid === w.ssid && (
                  <form className="flex flex-wrap items-center gap-2 px-[18px] pb-3 pl-[52px]" onSubmit={(e) => { e.preventDefault(); void connect() }}>
                    {join.secure && <input type="password" aria-label={t('settings.net.passwordFor', { name: w.ssid })} autoFocus value={join.password} onChange={(e) => setJoin({ ...join, password: e.target.value })} placeholder={t('greeter.password')} className={`${field} w-56`} />}
                    <button type="submit" disabled={join.busy} className={`${btnPrimary} px-4 py-2 text-[13px]`}>{join.busy ? t('common.connecting') : t('common.connect')}</button>
                    <button type="button" disabled={join.busy} onClick={() => setJoin(null)} className={`${btnGhost} px-3 py-2 text-[13px]`}>{t('common.cancel')}</button>
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
        { t: t('settings.net.ethernet'), d: eth.length ? (eth.some((e) => e.state === 'connected') ? `${t('common.connected')}${eth[0].connection ? ` · ${eth[0].connection}` : ''}` : t('settings.net.unplugged')) : t('settings.net.noEthernet') },
        { t: t('settings.net.adapters'), d: n.devices.map((d) => d.device).join(', ') || t('common.noneFound') },
      ].map((o) => <div key={o.t} className={`${card} flex flex-col gap-1.5 px-[18px] py-4`}><span className="text-sm font-semibold">{o.t}</span><span className="truncate text-[13px] text-[#8FA3C8]">{o.d}</span></div>)}
    </div>
    <VpnSection />
  </>
}

/** VPN (WSOS-INT-001): the organization's managed WireGuard VPN and the user's own imported WireGuard files. */
function VpnSection() {
  const { r, reload } = useAvail(os.sysVpn, 10_000)
  const [busy, setBusy] = useState<string | null>(null)
  const [msg, setMsg] = useState<{ text: string; error: boolean } | null>(null)
  const [confirmRemove, setConfirmRemove] = useState<string | null>(null)
  const [ask, setAsk] = useState<{ uuid: string; name: string } | null>(null)
  const act = async (key: string, fn: () => Promise<{ available: boolean; reason?: string } | { ok: boolean; error?: string }>, done: string) => {
    setBusy(key); setMsg(null)
    const res = await fn()
    setBusy(null)
    const failed = 'available' in res ? !res.available : !res.ok
    const why = 'available' in res ? res.reason : res.error
    if (failed) { const t = vpnErrorText(why ?? ''); if (t) setMsg({ text: t, error: true }) } else setMsg({ text: done, error: false })
    void reload()
  }
  const importFile = () => act('import', async () => {
    const f = await os.pickFile('wgconf')
    if (!f.ok) return f
    return os.sysVpnImport(f.value.handle)
  }, t('vpn.added'))
  const importOvpn = () => act('import', async () => {
    const f = await os.pickFile('ovpn')
    if (!f.ok) return f
    return os.sysVpnImportOpenvpn(f.value.handle)
  }, t('vpn.addedOpenvpn'))
  // OpenVPN with a password: asked here each time, sent once to nmcli's stdin, never stored by the shell.
  const toggle = (c: { uuid: string; name: string; active: boolean; needs_credentials: boolean }) => {
    if (!c.active && c.needs_credentials) { setAsk({ uuid: c.uuid, name: c.name }); return }
    void act(c.uuid, () => os.sysVpnConnect(c.uuid, !c.active), c.active ? t('vpn.disconnectedFrom', { name: c.name }) : t('vpn.connectedTo', { name: c.name }))
  }
  return (
    <section aria-label={t('vpn.title')} className="flex flex-col gap-2">
      <div className="flex items-center justify-between">
        <h2 className={`m-0 font-normal ${sectionLabel}`}>{t('vpn.title')}</h2>
        {r.state === 'ok' && r.value.user_vpn_allowed && (
          <span className="flex gap-2">
            <button type="button" disabled={busy !== null} onClick={() => void importFile()} className={`${btnGhost} px-3 py-1.5 text-[13px]`}>{busy === 'import' ? t('vpn.adding') : t('vpn.import')}</button>
            <button type="button" disabled={busy !== null} onClick={() => void importOvpn()} className={`${btnGhost} px-3 py-1.5 text-[13px]`}>{t('vpn.importOpenvpn')}</button>
          </span>
        )}
      </div>
      {r.state === 'loading' ? <Empty title={t('vpn.reading')} /> : r.state !== 'ok' ? <Unavail what={t('vpn.title')} reason={r.reason} /> : (
        <>
          {r.value.connections.length === 0 ? <Empty title={t('vpn.none')}>{r.value.user_vpn_allowed ? t('vpn.importHint2') : t('vpn.blocked')}</Empty> : (
            <ul className={`${card} m-0 list-none overflow-hidden p-0`}>
              {r.value.connections.map((c) => {
                const locked = c.managed && c.active && r.value.vpn_required
                return (
                  <li key={c.uuid} className={`flex items-center gap-3.5 px-[18px] py-[11px] ${rowLine}`} style={{ background: c.active ? 'rgba(31,107,255,0.12)' : 'transparent' }}>
                    <Svg d={LOCK} size={18} stroke={c.active ? C.green : C.soft} />
                    <span className="flex flex-1 flex-col gap-0.5">
                      <span className="text-sm" style={{ fontWeight: c.active ? 600 : 400 }}>{c.name}</span>
                      <span className="text-xs text-[#8FA3C8]">{[c.active ? t('common.connected') : t('common.notConnected'), c.kind === 'wireguard' ? 'WireGuard' : c.kind === 'openvpn' ? 'OpenVPN' : t('vpn.title'), c.managed ? t('vpn.managed') : null].filter(Boolean).join(' · ')}</span>
                    </span>
                    {!locked && (
                      <button type="button" disabled={busy !== null} onClick={() => toggle(c)}
                        className={`${c.active ? btnGhost : btnPrimary} px-3 py-1.5 text-[13px]`}>{busy === c.uuid ? (c.active ? t('common.disconnecting') : t('common.connecting')) : c.active ? t('common.disconnect') : t('common.connect')}</button>
                    )}
                    {!c.managed && (
                      <button type="button" disabled={busy !== null} aria-label={t('common.removeName', { name: c.name })} onClick={() => setConfirmRemove(c.uuid)} className={`${btnGhost} px-3 py-1.5 text-[13px]`}>{t('common.remove')}</button>
                    )}
                  </li>
                )
              })}
            </ul>
          )}
          {msg && <p role={msg.error ? 'alert' : 'status'} className="m-0 text-[13px]" style={{ color: msg.error ? '#FF8A7A' : C.green }}>{msg.text}</p>}
          <Note>{r.value.vpn_required ? t('vpn.requiredNote') : t('vpn.importedNote')}</Note>
        </>
      )}
      {ask && <VpnCredentials name={ask.name} onCancel={() => setAsk(null)} onSubmit={(creds) => { const a = ask; setAsk(null); void act(a.uuid, () => os.sysVpnConnect(a.uuid, true, creds), t('vpn.connectedTo', { name: a.name })) }} />}
      {confirmRemove && r.state === 'ok' && (
        <Dialog alert onClose={() => setConfirmRemove(null)}>
          {(tid) => <>
            <div className="flex flex-col gap-3 px-6 pt-6 pb-4">
              <h2 id={tid} className="m-0 text-[19px] font-bold">{t('vpn.removeTitle')}</h2>
              <p className="m-0 text-sm text-[#C9D6EE]">{t('vpn.removeBody', { name: r.value.connections.find((c) => c.uuid === confirmRemove)?.name ?? '' })}</p>
            </div>
            <div className={dialogFooter}>
              <button type="button" onClick={() => setConfirmRemove(null)} className={`${btnGhost} px-4 py-2 text-[13px]`}>{t('common.cancel')}</button>
              <button type="button" onClick={() => { const id = confirmRemove; setConfirmRemove(null); void act(id, () => os.sysVpnRemove(id), t('vpn.removed')) }} className={`${btnPrimary} px-4 py-2 text-[13px]`}>{t('common.remove')}</button>
            </div>
          </>}
        </Dialog>
      )}
    </section>
  )
}

function VpnCredentials({ name, onCancel, onSubmit }: { name: string; onCancel: () => void; onSubmit: (c: { username: string; password: string }) => void }) {
  const [username, setUsername] = useState('')
  const [password, setPassword] = useState('')
  return (
    <Dialog onClose={onCancel}>
      {(tid) => <form onSubmit={(e) => { e.preventDefault(); if (username) onSubmit({ username, password }) }}>
        <div className="flex flex-col gap-3 px-6 pt-6 pb-4">
          <h2 id={tid} className="m-0 text-[19px] font-bold">{t('vpn.connectTo', { name })}</h2>
          <label className="flex flex-col gap-1 text-sm">{t('vpn.username')}<input autoFocus autoComplete="username" value={username} onChange={(e) => setUsername(e.target.value)} className="rounded-md bg-white/10 px-3 py-2" /></label>
          <label className="flex flex-col gap-1 text-sm">{t('greeter.password')}<input type="password" autoComplete="current-password" value={password} onChange={(e) => setPassword(e.target.value)} className="rounded-md bg-white/10 px-3 py-2" /></label>
          <p className="m-0 text-xs text-[#8FA3C8]">{t('vpn.notSaved')}</p>
        </div>
        <div className={dialogFooter}>
          <button type="button" onClick={onCancel} className={`${btnGhost} px-4 py-2 text-[13px]`}>{t('common.cancel')}</button>
          <button type="submit" disabled={!username} className={`${btnPrimary} px-4 py-2 text-[13px]`}>{t('common.connect')}</button>
        </div>
      </form>}
    </Dialog>
  )
}

function BluetoothPanel() {
  const { r, reload } = useAvail(os.sysBluetooth, 15_000)
  if (r.state !== 'ok') return <><H1>{t('settings.nav.Bluetooth')}</H1>{r.state === 'loading' ? <Empty title={t('settings.bt.reading')} /> : <Unavail what={t('settings.nav.Bluetooth')} reason={r.reason} />}</>
  const b = r.value
  return <>
    <H1>{t('settings.nav.Bluetooth')}</H1>
    <div className={`${heroCard} flex items-center gap-4 px-5 py-[18px]`}>
      <span className="flex flex-1 flex-col gap-0.5">
        <span className="text-base font-semibold">{t('settings.nav.Bluetooth')}</span>
        <span className="text-[13px] text-[#8FA3C8]">{!b.powered ? t('common.off') : b.discoverable && b.name ? t('settings.bt.visibleAs', { name: b.name }) : b.name ? t('settings.bt.onAs', { name: b.name }) : t('common.on')}</span>
      </span>
      <Switch label={t('settings.nav.Bluetooth')} checked={b.powered} onChange={(v) => void os.sysSetBluetooth(v).then(reload)} />
    </div>
    <section aria-label={t('settings.bt.myDevices')} className="flex flex-col gap-2">
      <h2 className={`m-0 font-normal ${sectionLabel}`}>{t('settings.bt.myDevices')}</h2>
      {b.paired.length === 0 ? <Empty title={t('settings.bt.noPaired')} /> : (
        <ul className={`${card} m-0 list-none overflow-hidden p-0`}>
          {b.paired.map((d) => (
            <li key={d.address} className={`flex items-center gap-3.5 px-[18px] py-[13px] ${rowLine}`}>
              <span className="flex h-9 w-9 items-center justify-center rounded-[10px] bg-[rgba(31,107,255,0.16)]"><Svg d="M7 7l10 10-5 5V2l5 5L7 17" size={18} stroke="#7FB2FF" /></span>
              <span className="flex flex-1 flex-col gap-0.5"><span className="text-sm font-medium">{d.name}</span><span className="text-xs" style={{ color: d.connected ? C.green : C.muted }}>{d.connected ? t('common.connected') : t('common.notConnected')}</span></span>
              <button type="button" disabled={!b.powered} onClick={() => void os.sysBtConnect(d.address, !d.connected).then(reload)} className={`${btnGhost} px-3.5 py-2 text-[13px]`}>{d.connected ? t('common.disconnect') : t('common.connect')}</button>
            </li>
          ))}
        </ul>
      )}
    </section>
    <BluetoothPairSection powered={b.powered} paired={b.paired} onChange={() => void reload()} />
    <Note>{t('settings.bt.note')}</Note>
  </>
}

// Settings › Display lives in DisplaySettings.tsx (WSOS-DSK-005/006).
import { DisplayPanel } from './DisplaySettings'
// Settings › Default apps and clipboard history live in DesktopSettings.tsx (WSOS-DSK-008/009).
import { ClipboardSection, DefaultAppsPanel } from './DesktopSettings'
// Pairing, drives, power, printers, input methods, rejected sync changes (WSOS-INT-003…006, 011, SYN-004).
import { BluetoothPairSection, DeviceExtras, SyncProblemsSection } from './PeripheralSettings'

const THEME_ART: Record<string, { bg: string; win: string; bar: string }> = {
  Light: { bg: 'linear-gradient(135deg,#EAF1FF,#C9DAFF)', win: '#FFFFFF', bar: 'rgba(255,255,255,0.8)' },
  Dark: { bg: 'linear-gradient(135deg,#0E2357,#060E22)', win: '#13264F', bar: 'rgba(255,255,255,0.08)' },
  Auto: { bg: 'linear-gradient(135deg,#EAF1FF 0%,#EAF1FF 50%,#0E2357 50%,#060E22 100%)', win: '#8FA3C8', bar: 'rgba(127,178,255,0.25)' },
}
function AppearancePanel() {
  const [a, setA] = useState<Appearance>(() => loadAppearance())
  const save = (n: Appearance) => { setA(n); writeJson(KEYS.appearance, n); applyAppearance(n) }
  const accent = accentColor(a.accent)
  const reduce = typeof matchMedia !== 'undefined' && matchMedia('(prefers-reduced-motion: reduce)').matches
  return <>
    <H1>{t('settings.nav.Appearance')}</H1>
    <fieldset className="m-0 flex flex-col gap-2.5 border-0 p-0">
      <legend className="mb-2.5 p-0 text-sm font-semibold">{t('settings.app.theme')}</legend>
      <div className="grid grid-cols-3 gap-3.5">
        {THEMES.map((th) => (
          <button key={th} type="button" aria-pressed={a.theme === th} onClick={() => save({ ...a, theme: th })}
            className="flex cursor-pointer flex-col gap-2.5 rounded-[14px] border-2 bg-[rgba(14,32,72,0.5)] p-2.5 text-left" style={{ borderColor: a.theme === th ? accent : 'transparent' }}>
            <span className="relative block h-[110px] overflow-hidden rounded-[9px]" style={{ background: THEME_ART[th].bg }} aria-hidden="true">
              <span className="absolute top-3.5 left-3.5 h-16 w-[100px] rounded-[7px]" style={{ background: THEME_ART[th].win }} />
              <span className="absolute top-6 left-[22px] h-[7px] w-[50px] rounded" style={{ background: accent }} />
              <span className="absolute inset-x-2 bottom-2 h-4 rounded-[5px]" style={{ background: THEME_ART[th].bar }} />
            </span>
            <span className="px-1 text-sm font-semibold">{t(`settings.theme.${th}` as MessageKey)}</span>
          </button>
        ))}
      </div>
    </fieldset>
    <fieldset className="m-0 flex flex-col gap-2.5 border-0 p-0">
      <legend className="mb-2.5 p-0 text-sm font-semibold">{t('settings.app.accent')}</legend>
      <div className="flex gap-3.5">
        {ACCENTS.map((x) => (
          <button key={x.name} type="button" aria-label={t(`settings.accent.${x.name}` as MessageKey)} aria-pressed={a.accent === x.name} onClick={() => save({ ...a, accent: x.name })}
            className="h-8 w-8 cursor-pointer rounded-full" style={{ background: x.color, boxShadow: a.accent === x.name ? '0 0 0 3px #0A1A3D, 0 0 0 5px #FFFFFF' : 'none' }} />
        ))}
      </div>
    </fieldset>
    <Rows rows={[
      { k: t('settings.app.wallpaper'), v: t('settings.app.wallpaperDefault') },
      { k: t('settings.app.font'), v: 'IBM Plex Sans' },
      { k: t('a11y.reducedMotion'), v: reduce ? t('settings.app.onSystem') : t('settings.app.offSystem') },
    ]} />
  </>
}

function SoundPanel() {
  const { r, reload } = useAvail(os.sysSound)
  const [vol, setVol] = useState<number | null>(null)
  if (r.state !== 'ok') return <><H1>{t('settings.nav.Sound')}</H1>{r.state === 'loading' ? <Empty title={t('settings.snd.reading')} /> : <Unavail what={t('settings.nav.Sound')} reason={r.reason} />}</>
  const s = r.value
  const out = s.outputs.find((o) => o.is_default)
  const input = s.inputs.find((o) => o.is_default)
  const select = 'box-border min-w-[260px] rounded-[9px] border border-[rgba(127,178,255,0.25)] bg-[rgba(4,10,26,0.5)] px-3 py-[9px] text-[13px] text-[#E8EEFA]'
  const v = vol ?? s.volume
  return <>
    <H1>{t('settings.nav.Sound')}</H1>
    <section aria-label={t('settings.snd.output')} className={`${card} flex flex-col gap-2.5 px-5 py-[18px]`}>
      <div className="flex items-center justify-between gap-3"><h2 className="m-0 text-[15px] font-semibold">{t('settings.snd.output')}</h2>
        {s.outputs.length > 1
          ? <select aria-label={t('settings.snd.outputDevice')} value={out?.id ?? ''} onChange={(e) => void os.sysSetDefaultAudio(+e.target.value).then(reload)} className={select}>{s.outputs.map((o) => <option key={o.id} value={o.id} className="bg-[#0F2350]">{o.name}</option>)}</select>
          : <Value min={260}>{out?.name ?? null}</Value>}
      </div>
      <div className="flex items-center gap-3.5">
        <button type="button" aria-pressed={s.muted} aria-label={t('settings.snd.mute')} onClick={() => void os.sysSetMute(!s.muted).then(reload)} className="flex h-8 w-8 cursor-pointer items-center justify-center rounded-lg hover:bg-white/10">
          <Svg d={s.muted ? 'M4 9v6h4l5 4V5L8 9zM17 9l4 6M21 9l-4 6' : 'M4 9v6h4l5 4V5L8 9zM16.5 8.5a5 5 0 0 1 0 7'} size={20} stroke={C.soft} />
        </button>
        <input type="range" aria-label={t('settings.snd.volume')} min={0} max={100} value={v} onChange={(e) => { setVol(+e.target.value); void os.sysSetVolume(+e.target.value) }} onPointerUp={() => void reload().then(() => setVol(null))} onKeyUp={() => void reload().then(() => setVol(null))} className="flex-1 accent-[#1F6BFF]" />
        <span className="w-[56px] text-right font-mono text-[13px]">{s.muted ? t('settings.snd.muted') : `${formatNumber(v)}%`}</span>
      </div>
    </section>
    <section aria-label={t('settings.snd.input')} className={`${card} flex items-center justify-between gap-3 px-5 py-[18px]`}>
      <h2 className="m-0 text-[15px] font-semibold">{t('settings.snd.input')}</h2><Value min={260}>{input?.name ?? null}</Value>
    </section>
    <Note>{t('settings.snd.note')}</Note>
  </>
}

function NotificationsPanel() {
  return <>
    <H1>{t('settings.nav.Notifications')}</H1>
    <Rows rows={[
      { k: t('quick.dnd'), d: t('settings.notif.dndHint'), v: t('settings.notif.inQuick') },
      { k: t('settings.notif.sync'), d: t('settings.notif.syncHint'), v: t('common.on') },
      { k: t('settings.nav.Updates'), d: t('settings.notif.updatesHint'), v: t('common.on') },
      { k: t('settings.notif.devices'), d: t('settings.notif.devicesHint'), v: t('common.on') },
    ]} />
    <Note>{t('settings.notif.note')}</Note>
  </>
}

function PrivacyPanel() {
  const [p, setP] = useState<Privacy>(() => readJson<Privacy>(KEYS.privacy, DEFAULT_PRIVACY))
  const [info, setInfo] = useState<DeviceInfo | null>(null)
  const { status } = useOsUpdate()
  useEffect(() => { void os.deviceInfo().then(setInfo).catch(() => {}) }, [])
  const set = (k: keyof Privacy) => (v: boolean) => { const n = { ...p, [k]: v }; setP(n); writeJson(KEYS.privacy, n) }
  const [lock, setLock] = useState<LockSettings | null>(null)
  useEffect(() => { void os.lockSettings().then(setLock).catch(() => {}) }, [])
  const enc = info?.device?.encrypted
  type Tile = { t: string; d: string; ok: boolean | null; icon: string }
  const tiles: Tile[] = [
    { t: enc === false ? t('settings.priv.notEncrypted') : t('settings.priv.encryption'), d: enc ? t('settings.priv.luksOn') : enc === false ? t('settings.priv.readable') : t('settings.priv.statusUnavailable'), ok: enc ?? null, icon: 'M5 11h14v10H5zM8 11V7a4 4 0 0 1 8 0v4' },
    { t: t('settings.priv.firewall'), d: t('settings.priv.statusUnavailable'), ok: null, icon: 'M12 3l8 3v6c0 5-3.5 8-8 9-4.5-1-8-4-8-9V6z' },
    status?.state === 'up_to_date'
      ? { t: t('settings.priv.upToDate'), d: t('settings.priv.checked', { when: status.last_check ? fmtWhen(status.last_check) : '—' }), ok: true, icon: 'M5 12.5l4.5 4.5L19 7.5' }
      : { t: needsAttention(status) ? t('settings.priv.updateWaiting') : t('settings.nav.Updates'), d: needsAttention(status) ? t('settings.priv.openUpdates') : status ? t('settings.priv.seeUpdates') : t('settings.priv.statusUnavailable'), ok: needsAttention(status) ? false : null, icon: 'M4 12a8 8 0 1 0 2.3-5.7M4 4v4h4' },
    { t: t('settings.priv.screenLock'), d: !lock ? t('settings.priv.statusUnavailable') : lock.timeout_s ? t('settings.priv.lockAfter', { time: lockChoiceLabel(lock.timeout_s) }) : t('settings.priv.lockOff'), ok: lock ? lock.timeout_s > 0 : null, icon: 'M7 11V7a5 5 0 0 1 10 0v4M5 11h14v10H5z' },
  ]
  const known = tiles.filter((x) => x.ok !== null)
  const passed = known.filter((x) => x.ok).length
  const failing = tiles.find((x) => x.ok === false)
  const allGood = known.length > 0 && passed === known.length
  const ring = 2 * Math.PI * 30
  const tone = (ok: boolean | null) => ok === true ? C.green : ok === false ? C.amber : C.muted
  const perms: { k: keyof Privacy; t: string; d: string; icon: string }[] = [
    { k: 'location', t: t('settings.priv.location'), d: t('settings.priv.locationHint'), icon: 'M12 21s-7-6.5-7-12a7 7 0 0 1 14 0c0 5.5-7 12-7 12z' },
    { k: 'updates', t: t('settings.priv.autoUpdates'), d: t('settings.priv.autoUpdatesHint'), icon: 'M12 3l8 3v6c0 5-3.5 8-8 9-4.5-1-8-4-8-9V6z' },
    { k: 'crash', t: t('settings.priv.crash'), d: t('settings.priv.crashHint'), icon: 'M12 8v5M12 16.5v.5M10.3 3.9L1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0z' },
    { k: 'usage', t: t('settings.priv.usage'), d: t('settings.priv.usageHint'), icon: 'M4 20V10M10 20V4M16 20v-7M22 20H2' },
  ]
  return <>
    <H1>{navLabel('Privacy & security')}</H1>
    <section aria-label={t('settings.priv.summary')} className="flex items-center gap-[22px] rounded-2xl border px-[22px] py-[18px]"
      style={allGood ? { background: 'linear-gradient(120deg, rgba(46,158,106,0.22), rgba(14,32,72,0.7))', borderColor: 'rgba(95,211,154,0.35)' } : { background: 'linear-gradient(120deg, rgba(255,159,90,0.14), rgba(14,32,72,0.7))', borderColor: 'rgba(255,159,90,0.3)' }}>
      <div className="relative h-[72px] w-[72px] shrink-0">
        <svg width="72" height="72" viewBox="0 0 72 72" aria-hidden="true">
          <circle cx="36" cy="36" r="30" fill="none" stroke="rgba(127,178,255,0.18)" strokeWidth="7" />
          {known.length > 0 && <circle cx="36" cy="36" r="30" fill="none" stroke={allGood ? C.green : C.amber} strokeWidth="7" strokeLinecap="round" strokeDasharray={`${(passed / tiles.length) * ring} ${ring}`} transform="rotate(-90 36 36)" />}
        </svg>
        <span className="absolute inset-0 flex items-center justify-center text-lg font-bold">{passed}/{tiles.length}</span>
      </div>
      <span className="flex flex-1 flex-col gap-1">
        <span className="text-[17px] font-bold">{allGood ? t('settings.priv.wellProtected') : t('settings.priv.checksPassed', { n: String(passed), total: String(tiles.length) })}</span>
        <span className="text-[13px] text-[#C9D6EE]">{failing ? t('settings.priv.suggestion', { what: `${failing.t} · ${failing.d}` }) : known.length < tiles.length ? t('settings.priv.someUnknown') : t('settings.priv.noSuggestions')}</span>
      </span>
    </section>
    <div className="grid grid-cols-4 gap-2.5">
      {tiles.map((c) => (
        <div key={c.t} className={`${card} flex flex-col gap-1.5 px-3.5 py-[13px]`}>
          <Svg d={c.icon} size={20} stroke={tone(c.ok)} />
          <span className="text-[13px] font-semibold">{c.t}</span>
          <span className="text-[11px]" style={{ color: tone(c.ok) }}>{c.d}</span>
        </div>
      ))}
    </div>
    <div className="grid min-h-0 gap-3" style={{ gridTemplateColumns: 'minmax(0,1.25fr) minmax(0,1fr)' }}>
      <section aria-labelledby="priv-choices" className="flex flex-col gap-2">
        <h2 id="priv-choices" className="m-0 text-sm font-semibold">{t('settings.priv.choices')}</h2>
        <div className={`${card} overflow-hidden`}>
          {perms.map((x) => (
            <div key={x.k} className={`flex items-center gap-3 px-4 py-[11px] ${rowLine}`}>
              <Svg d={x.icon} size={18} stroke="#7FB2FF" />
              <span className="flex flex-1 flex-col gap-0.5"><span className="text-[13px] font-medium">{x.t}</span><span className="text-[11px] text-[#8FA3C8]">{x.d}</span></span>
              <Switch small label={x.t} checked={p[x.k]} onChange={set(x.k)} />
            </div>
          ))}
        </div>
      </section>
      <section aria-labelledby="priv-it" className="flex flex-col gap-2">
        <h2 id="priv-it" className="m-0 text-sm font-semibold">{t('settings.priv.itSees')}</h2>
        <div className={`${card} px-4 py-3 text-xs leading-relaxed text-[#C9D6EE]`}>{t('settings.priv.note')}</div>
      </section>
    </div>
    <ClipboardSection />
  </>
}

/** WSOS-LOCK-003: idle lock timeout chosen by the user, within the organization's maximum (worksuite-idle applies it). */
function LockAfterRow() {
  const [s, setS] = useState<LockSettings | null>(null)
  const [err, setErr] = useState<string | null>(null)
  useEffect(() => { void os.lockSettings().then(setS).catch(() => setErr(t('settings.lock.unavailable'))) }, [])
  const change = async (v: number) => {
    const r = await os.setLockTimeout(v)
    if (r.ok) { setS(r.value); setErr(null) } else setErr(r.error === 'above_policy_maximum' ? t('settings.lock.tooLong') : t('settings.lock.saveFailed'))
  }
  const help = err ?? (!s ? t('common.loading') : s.max_s !== null ? t('settings.lock.allowsUpTo', { time: lockChoiceLabel(s.max_s) }) : t('settings.lock.beforeSleep'))
  return (
    <div className={`flex items-center gap-4 px-[18px] py-3.5 ${rowLine}`}>
      <span className="flex flex-1 flex-col gap-0.5"><span className="text-sm">{t('settings.lock.after')}</span><span className="text-xs text-[#8FA3C8]" role={err ? 'alert' : undefined}>{help}</span></span>
      {s?.max_s != null && <span className={chip}>{t('settings.lock.policy')}</span>}
      {s && <select aria-label={t('settings.lock.after')} value={s.timeout_s} onChange={(e) => void change(Number(e.target.value))}
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
    <H1>{t('settings.nav.Users')}</H1>
    {r.state === 'unavailable' && <Unavail what={t('settings.users.list')} />}
    {r.state === 'ok' && (
      <div className="flex items-center gap-[22px] rounded-[18px] border border-[rgba(127,178,255,0.18)] px-6 py-[22px]" style={{ background: 'radial-gradient(circle at 90% 10%, rgba(24,212,240,0.25), transparent 45%), rgba(14,32,72,0.75)' }}>
        <Avatar name={me?.name ?? r.value.current} size={96} font={34} />
        <span className="flex flex-1 flex-col gap-1.5">
          <span className="text-[22px] font-bold">{me?.name ?? r.value.current}</span>
          <span className="font-mono text-xs text-[#8FA3C8]">{r.value.current}</span>
          <span className="mt-0.5 flex gap-1.5">
            {me && <span className="rounded-full px-2 py-[3px] text-[11px] font-semibold bg-[rgba(31,107,255,0.22)] text-[#B8D4FF]">{me.admin ? t('settings.users.admin') : t('settings.users.standard')}</span>}
            <span className="rounded-full px-2 py-[3px] text-[11px] font-semibold bg-[rgba(95,211,154,0.18)] text-[#5FD39A]">{t('settings.signedIn')}</span>
          </span>
        </span>
      </div>
    )}
    <div className="grid grid-cols-2 items-start gap-3">
      <section aria-labelledby="signin" className="flex flex-col gap-2">
        <h2 id="signin" className="m-0 text-sm font-semibold">{t('settings.users.signin')}</h2>
        <div className={`${card} overflow-hidden`}>
          <div className={`flex items-center gap-3 px-4 py-3 ${rowLine}`}>
            <Svg d="M7 11V7a5 5 0 0 1 10 0v4M5 11h14v10H5z" size={18} stroke="#7FB2FF" />
            <span className="flex flex-1 flex-col gap-0.5"><span className="text-[13px] font-medium">{t('greeter.password')}</span><span className="text-[11px] text-[#8FA3C8]">{t('settings.users.method')}</span></span>
          </div>
          <div className={`flex items-center gap-3 px-4 py-3 ${rowLine}`}>
            <Svg d="M13 3h6v18h-6M10 8l4 4-4 4M14 12H3" size={18} stroke="#7FB2FF" />
            <span className="flex flex-1 flex-col gap-0.5"><span className="text-[13px] font-medium">{t('settings.users.auto')}</span><span className="text-[11px] text-[#8FA3C8]">{t('settings.users.autoHint')}</span></span>
            <span className={chip}>{t('settings.users.notAllowed')}</span>
          </div>
          <LockAfterRow />
        </div>
      </section>
      <SyncProblemsSection />
      <section aria-labelledby="other-users" className="flex flex-col gap-2">
        <h2 id="other-users" className="m-0 text-sm font-semibold">{t('settings.users.othersHere')}</h2>
        {r.state === 'ok' && !others.length && <div className={`${card} px-4 py-3 text-[13px] text-[#8FA3C8]`}>{t('settings.users.noOthers')}</div>}
        {others.length > 0 && <ul className={`${card} m-0 list-none overflow-hidden p-0`}>
          {others.map((u: LocalUser, i) => (
            <li key={u.login} className={`flex items-center gap-3 px-4 py-3 ${rowLine}`}>
              <Avatar name={u.name} size={38} font={13} bg={AVATAR_GRADIENTS[(i + 1) % AVATAR_GRADIENTS.length]} />
              <span className="flex flex-1 flex-col gap-0.5"><span className="text-[13px] font-medium">{u.name}</span><span className="text-[11px] text-[#8FA3C8]">{u.login}</span></span>
              <span className="rounded-[5px] bg-[rgba(127,178,255,0.12)] px-[7px] py-0.5 text-[11px] text-[#C9D6EE]">{u.admin ? t('settings.users.adminShort') : t('settings.users.standardShort')}</span>
            </li>
          ))}
        </ul>}
      </section>
    </div>
    <section aria-labelledby="ws-acct" className="flex flex-col gap-2">
      <h2 id="ws-acct" className="m-0 text-sm font-semibold">{t('settings.acct.title')}</h2>
      <div className={`${card} overflow-hidden`}><CloudAccounts /></div>
    </section>
    <Note>{t('settings.users.note')}</Note>
  </>
}

function batteryText(b: BatteryState): string {
  const eta = b.state === 'charging' ? formatDuration(b.time_to_full_s) : b.on_battery ? formatDuration(b.time_to_empty_s) : null
  const what = b.state === 'charging' ? t('settings.bat.charging') : b.on_battery ? t('settings.bat.onBattery') : b.state === 'fully-charged' ? t('settings.bat.full') : t('settings.bat.plugged')
  return `${b.percentage == null ? '—' : `${formatNumber(b.percentage)}%`} · ${what}${eta ? ` · ${b.state === 'charging' ? t('settings.bat.toFull', { eta }) : t('settings.bat.left', { eta })}` : ''}`
}

function AboutPanel() {
  const { r: disks } = useAvail(os.sysDisks)
  const { r: battery } = useAvail(os.sysBattery, 60_000)
  const [showWipe, setShowWipe] = useState(false)
  const [info, setInfo] = useState<DeviceInfo | null>(null)
  useEffect(() => { void os.deviceInfo().then(setInfo).catch(() => {}) }, [])
  if (!info) return <><H1>{t('settings.nav.About')}</H1><Empty title={t('settings.about.loading')} /></>
  const d = info.device
  const lines = policyLines(info.policies)
  const checked = info.last_check_in ? formatDate(info.last_check_in) : t('settings.about.notYet')
  return <>
    <H1>{t('settings.nav.About')}</H1>
    <div className={`${heroCard} flex items-center gap-5 rounded-2xl p-[22px]`}>
      <span className="flex h-20 w-20 items-center justify-center rounded-2xl bg-[rgba(31,107,255,0.18)]"><Mark size={48} hole="#0F2350" /></span>
      <span className="flex flex-col gap-1"><span className="text-xl font-bold">WorkSuite OS</span><span className="text-[13px] text-[#8FA3C8]">{d?.os_version ?? t('settings.about.versionUnknown')}</span></span>
    </div>
    <Rows rows={[
      { k: t('settings.about.name'), v: d?.hostname ?? t('common.unknown') },
      { k: t('settings.about.arch'), v: d?.arch === 'arm64' ? 'ARM64 (arm64)' : d?.arch === 'amd64' ? 'x86-64 (amd64)' : t('common.unknown') },
      { k: t('settings.about.kernel'), v: d?.kernel_version ?? t('common.unknown') },
      { k: t('settings.priv.encryption'), v: d?.encrypted == null ? t('common.unknown') : d.encrypted ? t('settings.about.encrypted') : t('settings.about.notEncrypted') },
      { k: t('settings.about.storage'), v: disks.state === 'ok' ? disks.value.map((x) => x.model || x.device).join(', ') || t('common.noneFound') : disks.state === 'loading' ? '…' : t('common.unknown') },
      { k: t('settings.about.battery'), v: battery.state === 'ok' ? batteryText(battery.value) : battery.state === 'loading' ? '…' : t('settings.about.noBattery') },
    ]} />
    {/* WSOS-MDM-007: management disclosure, from the device agent */}
    {info.managed ? (
      <section aria-label={t('settings.about.mgmt')} className="flex flex-col gap-2.5 rounded-[14px] border border-[rgba(31,107,255,0.35)] bg-[rgba(31,107,255,0.1)] px-5 py-[18px]">
        <span className="flex items-center gap-2 text-sm font-semibold"><Svg d="M12 3l8 3v6c0 5-3.5 8-8 9-4.5-1-8-4-8-9V6z" size={18} stroke="#7FB2FF" />{t('panel.managedBy', { org: info.org_name ?? info.server ?? t('settings.about.yourOrg') })}</span>
        <ul className="m-0 list-disc pl-[18px] text-[13px] leading-relaxed text-[#C9D6EE]">
          {lines.map((l) => <li key={l}>{l}</li>)}
          <li>{d?.encrypted ? t('settings.about.canWipeAll') : t('settings.about.canWipe')}</li>
        </ul>
        <span className="text-xs text-[#8FA3C8]">{info.server ? `${info.server} · ` : ''}{t('settings.about.lastCheck', { when: checked })}</span>
        {/* WSOS-WIPE-007: explain wipe scope */}
        <button type="button" aria-expanded={showWipe} onClick={() => setShowWipe((v) => !v)} className={`${linkBtn} self-start`}>{showWipe ? t('common.hide') : t('settings.about.wipeWhat')}</button>
        {showWipe && (
          <div className="rounded-[10px] border border-[rgba(127,178,255,0.16)] bg-[rgba(4,10,26,0.4)] p-3 text-[12.5px] leading-relaxed text-[#C9D6EE]">
            <p className="m-0"><strong>{t('settings.about.dataWipe')}</strong> {t('settings.about.dataWipeBody')}</p>
            <p className="mb-0 mt-2"><strong>{t('settings.about.fullWipe')}</strong> {d?.encrypted ? t('settings.about.fullWipeBody') : t('settings.about.fullWipeNo')}</p>
            <p className="mb-0 mt-2">{t('settings.about.wipeApproval')}</p>
          </div>
        )}
      </section>
    ) : info.agent ? <EnrollCard onEnrolled={() => void os.deviceInfo().then(setInfo)} />
      : <Empty title={t('settings.about.mgmtUnavailable')}>{t('settings.about.agentDown')}</Empty>}
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
    if (!server.trim() || !code.trim()) return setError(t('settings.enroll.missing'))
    setBusy(true); setError(null)
    const r = await os.enrollDevice(serverUrlFor('enterprise', server), code)
    setBusy(false)
    if (!r.ok) return setError(cloudErrorText(r.error))
    onEnrolled()
  }
  return (
    <div className={`${card} flex flex-col gap-3 px-5 py-[18px] text-[13px]`}>
      <span className="text-[#8FA3C8]">{t('settings.enroll.unmanaged')}</span>
      {!open ? <button type="button" onClick={() => setOpen(true)} className={`${btnGhost} self-start`}>{t('settings.enroll.open')}</button> : (
        <form onSubmit={submit} className="flex flex-col gap-3" aria-label={t('settings.enroll.submit')}>
          <p className="m-0 text-[#8FA3C8]">{t('settings.enroll.explain')}</p>
          <label className="flex flex-col gap-1 font-semibold">{t('settings.enroll.server')}
            <input value={server} onChange={(e) => { setServer(e.target.value); setError(null) }} placeholder="work.example.com" spellCheck={false} className={`${field} font-normal`} />
          </label>
          <label className="flex flex-col gap-1 font-semibold">{t('settings.enroll.code')}
            <input value={code} onChange={(e) => { setCode(e.target.value.toUpperCase()); setError(null) }} autoComplete="off" spellCheck={false} className={`${field} w-[260px] max-w-full font-mono font-normal tracking-[1px]`} />
          </label>
          {error && <p role="alert" className="m-0 text-[#FF8A7A]">{error}</p>}
          <div className="flex gap-2">
            <button type="submit" disabled={busy} className={btnPrimary}>{busy ? t('settings.enroll.busy') : t('settings.enroll.submit')}</button>
            <button type="button" disabled={busy} onClick={() => { setOpen(false); setError(null) }} className={btnGhost}>{t('common.cancel')}</button>
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
    setNotice(r.value.exported ? t('settings.acct.signedOutSaved', { path: r.value.exported }) : t('settings.acct.signedOutDone'))
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
  if (error && !accounts) return row(t('settings.acct.title'), error, <span className="text-[13px] text-[#8FA3C8]">{t('common.unavailable')}</span>)
  if (!accounts) return row(t('settings.acct.title'), null, <span className="text-[13px] text-[#8FA3C8]">{t('common.loading')}</span>)
  return <>
    {(error || notice) && <p role="status" className={`m-0 px-[18px] py-3 text-[13px] ${rowLine}`} style={{ color: error ? C.red : C.green }}>{error ?? notice}</p>}
    {accounts.length === 0
      ? row(t('settings.acct.notSignedIn'), t('settings.acct.signInHint'), <span className="text-[13px] text-[#8FA3C8]">{t('settings.acct.signedOut')}</span>)
      : accounts.map((a) => row(a.name ?? t('settings.acct.title'), `${a.server_url}${a.state === 'refresh_failed' ? ` · ${t('settings.acct.signInAgain')}` : ''}`,
        <button type="button" onClick={() => void signOut(a)} className={`${btnGhost} px-3.5 py-2 text-[13px]`}>{t('power.signOut')}</button>, a.id))}
    {prompt && <UnsentDialog {...prompt} onCancel={() => setPrompt(null)} onChoose={(c) => finish(prompt.account, c)} />}
  </>
}

/** Wait to sync, export, or discard (confirmed) — the three choices SRS WSOS-SYN-008 requires. */
function UnsentDialog({ account, unsent, onCancel, onChoose }: { account: CloudAccount; unsent: number; onCancel: () => void; onChoose: (c: SignOutChoice) => Promise<void> }) {
  const [left, setLeft] = useState(unsent)
  const [waiting, setWaiting] = useState(false)
  const [confirmDiscard, setConfirmDiscard] = useState(false)
  const [busy, setBusy] = useState(false)
  const n = (k: number) => k === 1 ? t('settings.unsent.one') : t('settings.unsent.many', { count: formatNumber(k) })
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
          <p className="m-0 text-sm text-[#C9D6EE]">{t('settings.unsent.body', { server: account.server_url })}</p>
          {waiting ? (
            <div className="flex items-center justify-between gap-3 rounded-xl bg-[rgba(31,107,255,0.12)] px-4 py-3 text-sm" aria-live="polite">
              <span>{t('settings.unsent.syncing')}</span>
              <button type="button" onClick={() => setWaiting(false)} className={linkBtn}>{t('settings.unsent.stop')}</button>
            </div>
          ) : confirmDiscard ? (
            <div className="flex flex-col gap-3 rounded-xl border border-[rgba(255,138,122,0.3)] bg-[rgba(255,138,122,0.08)] px-4 py-3 text-sm">
              <span>{t('settings.unsent.discardQ', { what: n(left) })}</span>
              <div className="flex justify-end gap-2">
                <button type="button" disabled={busy} onClick={() => setConfirmDiscard(false)} className={btnGhost}>{t('settings.unsent.keep')}</button>
                <button type="button" disabled={busy} onClick={() => void run('discard')} className={`${btnPrimary} bg-[#D9452B] hover:bg-[#E5573D]`}>{t('settings.unsent.discardOut')}</button>
              </div>
            </div>
          ) : (
            <div className="flex flex-col gap-2">
              <button type="button" disabled={busy} onClick={() => setWaiting(true)} className={btnPrimary}>{t('settings.unsent.wait')}</button>
              <button type="button" disabled={busy} onClick={() => void run('export')} className={btnGhost}>{t('settings.unsent.export')}</button>
              <button type="button" disabled={busy} onClick={() => setConfirmDiscard(true)} className={`${btnGhost} text-[#FF8A7A]`}>{t('settings.unsent.discard')}</button>
            </div>
          )}
        </div>
        <div className={dialogFooter}><button type="button" disabled={busy} onClick={onCancel} className={btnGhost}>{t('settings.unsent.cancel')}</button></div>
      </>}
    </Dialog>
  )
}

function SetNav({ section, onPick, badges, user }: { section: Section; onPick: (s: Section) => void; badges: Partial<Record<Section, string>>; user: { name: string; role: string } | null }) {
  const [q, setQ] = useState('')
  const items = NAV.filter((n) => navLabel(n.id).toLowerCase().includes(q.trim().toLowerCase()) || n.id.toLowerCase().includes(q.trim().toLowerCase()))
  return (
    <nav aria-label={t('launcher.settings')} className="box-border flex w-[260px] shrink-0 flex-col gap-3.5 overflow-auto border-r border-[rgba(127,178,255,0.12)] bg-[#071330] px-3.5 py-5">
      <div className="flex items-center gap-3 px-2 pt-2 pb-1">
        <Avatar name={user?.name ?? '?'} size={40} font={14} />
        <span className="flex min-w-0 flex-col gap-px"><span className="truncate text-sm font-semibold">{user?.name ?? t('settings.thisComputer')}</span><span className="text-xs text-[#8FA3C8]">{user?.role ?? t('launcher.settings')}</span></span>
      </div>
      <label className="flex h-[38px] items-center gap-2 rounded-[9px] border border-[rgba(127,178,255,0.14)] bg-[rgba(4,10,26,0.5)] px-3 text-[13px] text-[#8FA3C8] focus-within:border-[#1F6BFF]">
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="#8FA3C8" strokeWidth="2.2" strokeLinecap="round" aria-hidden="true"><circle cx="11" cy="11" r="7" /><path d="M20 20l-4-4" /></svg>
        <span className="sr-only">{t('settings.search')}</span>
        <input type="search" value={q} onChange={(e) => setQ(e.target.value)} placeholder={t('settings.search')} className="min-w-0 flex-1 border-0 bg-transparent text-[13px] text-[#E8EEFA] outline-none placeholder:text-[#8FA3C8]" />
      </label>
      <ul className="m-0 flex list-none flex-col gap-px p-0">
        {items.map((n) => {
          const on = n.id === section
          const badge = badges[n.id]
          return (
            <li key={n.id}>
              {'sep' in n && n.sep && !q && <div className="mx-2 my-1.5 h-px bg-[rgba(127,178,255,0.1)]" aria-hidden="true" />}
              <button type="button" aria-current={on ? 'page' : undefined} onClick={() => onPick(n.id)}
                className={`flex w-full cursor-pointer items-center gap-3 rounded-lg px-2.5 py-[5px] text-left text-sm ${on ? 'bg-[rgba(31,107,255,0.2)] font-semibold text-white' : 'text-[#C9D6EE] hover:bg-white/[0.05]'}`}>
                <span className="flex h-[26px] w-[26px] shrink-0 items-center justify-center rounded-[7px]" style={{ background: n.tint }}><Svg d={n.icon} size={15} stroke="#FFFFFF" width={2.2} /></span>
                {navLabel(n.id)}
                {badge && <span className="ml-auto flex h-[18px] min-w-[18px] items-center justify-center rounded-[9px] bg-[#1F6BFF] px-[5px] text-[11px] font-bold text-white" aria-label={t('settings.pending', { count: badge })}>{badge}</span>}
              </button>
            </li>
          )
        })}
        {!items.length && <li className="px-2.5 py-2 text-[13px] text-[#8FA3C8]">{t('settings.noMatch')}</li>}
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
      setUser({ name: me?.name ?? r.value.current, role: me ? (me.admin ? t('settings.users.admin') : t('settings.users.standard')) : t('settings.signedIn') })
    }).catch(() => {})
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape' && !document.querySelector('[aria-modal="true"]')) onClose() }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])
  const badges = useMemo(() => ({ ...(driverCount ? { Drivers: String(driverCount) } : {}), ...(needsAttention(status) ? { Updates: '1' } : {}) }), [driverCount, status])

  return (
    <div role="dialog" aria-modal="false" aria-label={t('launcher.settings')} className="fixed inset-0 z-50 flex bg-[#0A1A3D] font-sans text-[#E8EEFA]">
      <SetNav section={section} onPick={setSection} badges={badges} user={user} />
      <main className="relative flex min-w-0 flex-1 flex-col gap-5 overflow-auto px-11 py-8" style={{ background: 'radial-gradient(ellipse 80% 50% at 80% 0%, #12306B 0%, #0A1A3D 60%)' }}>
        <button type="button" aria-label={t('settings.close')} onClick={onClose} className="absolute top-4 right-4 flex h-9 w-9 cursor-pointer items-center justify-center rounded-lg text-[#8FA3C8] hover:bg-white/10 hover:text-white">
          <Svg d="M6 6l12 12M18 6L6 18" size={16} />
        </button>
        {section === 'Network' && <NetworkPanel />}
        {section === 'Bluetooth' && <BluetoothPanel />}
        {section === 'Display' && <DisplayPanel />}
        {section === 'Appearance' && <AppearancePanel />}
        {section === 'Sound' && <SoundPanel />}
        {section === 'Notifications' && <NotificationsPanel />}
        {section === 'Default apps' && <DefaultAppsPanel />}
        {section === 'Privacy & security' && <PrivacyPanel />}
        {section === 'Users' && <UsersPanel />}
        {section === 'Devices' && <><DevicesPanel onProblem={setProblem} /><DeviceExtras /></>}
        {section === 'Drivers' && <DriversPanel onOpenUpdates={() => setSection('Updates')} />}
        {section === 'Updates' && <><H1>{t('settings.nav.Updates')}</H1><UpdatesPanel /></>}
        {section === 'About' && <AboutPanel />}
      </main>
      {problem && <DeviceProblemDialog device={problem} onClose={() => setProblem(null)} onOpenUpdates={() => setSection('Updates')} onOpenDrivers={() => setSection('Drivers')} />}
    </div>
  )
}


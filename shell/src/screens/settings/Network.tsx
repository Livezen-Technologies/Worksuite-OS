// Settings › Network and Bluetooth (from Settings.tsx).
import { useEffect, useState } from 'react'
import { reconcileJoin, wifiPhase, type Join } from '../../lib/wifiState'
import { os } from '../../lib/os'
import { RadioProblems, useRadio } from './Radio'
import { C, Svg, Switch, btnGhost, btnPrimary, card, field, heroCard, linkBtn, rowLine, sectionLabel } from '../../components/Dk'
import { Empty } from '../Hardware'
import { t, type MessageKey } from '../../i18n'
import { BluetoothPairSection } from '../PeripheralSettings'
import { useAvail, H1, Unavail, Note } from './common'

const WIFI_BARS = (s: number) => (s >= 67 ? 'M2 9a15 15 0 0 1 20 0M5.5 12.5a10 10 0 0 1 13 0M9 16a5 5 0 0 1 6 0' : s >= 34 ? 'M5.5 12.5a10 10 0 0 1 13 0M9 16a5 5 0 0 1 6 0' : 'M9 16a5 5 0 0 1 6 0')
const LOCK = 'M7 11V7a5 5 0 0 1 10 0v4M5 11h14v10H5z'

const WIFI_ERROR: Record<string, MessageKey> = { bad_password: 'settings.net.badPassword', not_found: 'radio.err.notFound', no_adapter: 'radio.err.noAdapter', timeout: 'radio.err.timeout' }

export function NetworkPanel() {
  const { r, reload: reloadNet } = useAvail(os.sysNetwork, 15_000, 'network')
  const radio = useRadio('wifi')
  const reload = async () => { await Promise.all([reloadNet(), radio.reload()]) }
  const [join, setJoin] = useState<Join | null>(null)
  const [scanning, setScanning] = useState(false)
  // #42: the form closes, and its error goes, once NetworkManager reports that network in use — also when nmcli had
  // given up first (a timeout while NetworkManager was still activating).
  const net = r.state === 'ok' ? r.value : null
  useEffect(() => { setJoin((j) => reconcileJoin(j, net)) }, [net])
  const problems = <RadioProblems kind="wifi" d={radio.d} onFixed={() => void reload()} always />
  if (r.state !== 'ok') return <><H1>{t('settings.nav.Network')}</H1>{r.state === 'loading' ? <Empty title={t('settings.net.reading')} /> : <><Unavail what={t('settings.net.info')} reason={r.reason} />{problems}</>}</>
  const n = r.value
  const rescan = async () => { setScanning(true); await os.sysWifiRescan(); setTimeout(() => { setScanning(false); void reload() }, 4000) }
  const wifi = n.devices.find((d) => d.type === 'wifi')
  const eth = n.devices.filter((d) => d.type === 'ethernet')
  const active = n.networks.find((w) => w.in_use)
  const phase = wifiPhase(n)
  const connect = async (j: Join | null = join) => {
    if (!j) return
    setJoin({ ...j, busy: true, error: null })
    const res = await os.sysWifiConnect(j.ssid, j.password)
    // A saved network that needs a new password opens the form; any other answer closes it (pending: NetworkManager is
    // still joining, and the card says Connecting… until it reports the result).
    if (res.ok) setJoin(null)
    else setJoin({ ...j, secure: j.secure || res.error === 'bad_password', busy: false, password: '', error: t(WIFI_ERROR[res.error] ?? 'settings.net.connectFailed') })
    void reload()
  }
  return <>
    <H1>{t('settings.nav.Network')}</H1>
    <div className={`${heroCard} flex items-center gap-4 px-5 py-[18px]`}>
      <span className="flex h-12 w-12 items-center justify-center rounded-xl bg-[#1F6BFF]"><Svg d={WIFI_BARS(100)} size={24} stroke="#FFFFFF" /></span>
      <span className="flex flex-1 flex-col gap-0.5">
        <span className="text-base font-semibold">{t('settings.net.wifi')}</span>
        <span role="status" className="text-[13px]" style={{ color: phase === 'connected' ? C.green : C.muted }}>
          {phase === 'none' ? t('settings.net.noWifi') : phase === 'off' ? t('common.off') : phase === 'connecting' ? t('common.connecting')
            : phase === 'connected' ? t('settings.net.connectedTo', { name: active?.ssid ?? wifi?.connection ?? '' }) : t('common.notConnected')}
        </span>
      </span>
      {wifi && <Switch label={t('settings.net.wifi')} checked={n.wifi_enabled} onChange={(v) => os.sysSetWifi(v).then((r) => { reload(); return r })} />}
    </div>
    {problems}
    {n.wifi_enabled && wifi && (
      <section aria-label={t('settings.net.available')} className="flex flex-col gap-2">
        <div className="flex items-center justify-between">
          <h2 className={`m-0 font-normal ${sectionLabel}`}>{t('settings.net.available')}</h2>
          <button type="button" disabled={scanning} onClick={() => void rescan()} className={linkBtn}>{scanning ? t('radio.scanning') : t('radio.scan')}</button>
        </div>
        {n.networks.length === 0 ? <Empty title={t('settings.net.none')} /> : (
          <ul className={`${card} m-0 list-none overflow-hidden p-0`}>
            {n.networks.map((w) => (
              <li key={w.ssid} className={rowLine} style={{ background: w.in_use ? 'rgba(31,107,255,0.12)' : 'transparent' }}>
                <div className="flex items-center gap-3.5 px-[18px] py-[11px]">
                  <Svg d={WIFI_BARS(w.signal)} size={20} stroke={w.in_use ? C.cyan : C.soft} />
                  <span className="flex-1 text-sm" style={{ fontWeight: w.in_use ? 600 : 400 }}>{w.ssid}</span>
                  <span className="text-xs text-[#8FA3C8]">{w.in_use ? t('common.connected') : w.saved ? t('settings.net.saved') : w.security ? '' : t('settings.net.open')}</span>
                  {w.security && <Svg d={LOCK} size={14} stroke={C.muted} />}
                  <span className="sr-only">{t('settings.net.signal', { security: w.security || t('settings.net.open'), signal: w.signal })}</span>
                  {w.in_use && <button type="button" onClick={() => void os.sysWifiDisconnect().then(reload)} className={`${btnGhost} px-3 py-1.5 text-[13px]`}>{t('common.disconnect')}</button>}
                  {!w.in_use && join?.ssid !== w.ssid && <button type="button" onClick={() => {
                    // Saved networks join with their stored password, without asking again (#42).
                    const j = { ssid: w.ssid, secure: !!w.security && !w.saved, password: '', error: null, busy: false }
                    if (w.saved || !w.security) void connect(j); else setJoin(j)
                  }} className={`${btnGhost} px-3 py-1.5 text-[13px]`}>{w.saved || !w.security ? t('common.connect') : t('settings.net.connectEllipsis')}</button>}
                  {!w.in_use && join?.ssid === w.ssid && join.busy && !join.secure && <span className="text-[13px] text-[#8FA3C8]">{t('common.connecting')}</span>}
                </div>
                {join?.ssid === w.ssid && !w.in_use && (join.secure || join.error) && (
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
  </>
}

export function BluetoothPanel() {
  const { r, reload: reloadBt } = useAvail(os.sysBluetooth, 15_000)
  const radio = useRadio('bluetooth')
  const reload = async () => { await Promise.all([reloadBt(), radio.reload()]) }
  const [err, setErr] = useState<string | null>(null)
  const problems = <RadioProblems kind="bluetooth" d={radio.d} onFixed={() => void reload()} always />
  if (r.state !== 'ok') return <><H1>{t('settings.nav.Bluetooth')}</H1>{r.state === 'loading' ? <Empty title={t('settings.bt.reading')} /> : <><Unavail what={t('settings.nav.Bluetooth')} reason={r.reason} />{problems}</>}</>
  const b = r.value
  const power = async (v: boolean) => {
    setErr(null)
    const res = await os.sysSetBluetooth(v)
    if (!res.available) setErr(res.reason === 'blocked' ? t('radio.err.btBlocked') : t('radio.err.btPower'))
    void reload()
  }
  return <>
    <H1>{t('settings.nav.Bluetooth')}</H1>
    <div className={`${heroCard} flex items-center gap-4 px-5 py-[18px]`}>
      <span className="flex flex-1 flex-col gap-0.5">
        <span className="text-base font-semibold">{t('settings.nav.Bluetooth')}</span>
        <span className="text-[13px] text-[#8FA3C8]">{!b.powered ? t('common.off') : b.discoverable && b.name ? t('settings.bt.visibleAs', { name: b.name }) : b.name ? t('settings.bt.onAs', { name: b.name }) : t('common.on')}</span>
      </span>
      <Switch label={t('settings.nav.Bluetooth')} checked={b.powered} onChange={(v) => power(v)} />
    </div>
    {err && <span role="alert" className="text-[13px] text-[#FF8A7A]">{err}</span>}
    {problems}
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

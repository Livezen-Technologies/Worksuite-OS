// First-boot network step (WSOS-INS-009): live NetworkManager state through the shell's nmcli bridge
// (os.sysNetwork / os.sysWifiConnect; the Wi-Fi password goes to nmcli on stdin, never argv). Skippable: Next works
// without a connection. When NetworkManager can't be read the card says so instead of showing sample networks.
import { useCallback, useEffect, useState } from 'react'
import { os, type Avail, type NetworkState } from '../lib/os'
import { t } from '../i18n'
import { reconcileJoin, wifiPhase, type Join } from '../lib/wifiState'

export default function FirstRunNetwork() {
  const [r, setR] = useState<Avail<NetworkState> | null>(null)
  const [join, setJoin] = useState<Join | null>(null)
  const reload = useCallback(async () => { try { setR(await os.sysNetwork()) } catch { setR({ available: false, reason: 'service_unavailable' }) } }, [])
  useEffect(() => {
    void reload()
    // NetworkManager's changes (electron/sysWatch.ts) keep the status and the form honest while a join completes (#42).
    return os.onSysChanged?.((k) => { if (k === 'network') void reload() })
  }, [reload])
  useEffect(() => { setJoin((j) => reconcileJoin(j, r?.available ? r.value : null)) }, [r])

  const connect = async (j: Join | null = join) => {
    if (!j) return
    setJoin({ ...j, busy: true, error: null })
    const res = await os.sysWifiConnect(j.ssid, j.password)
    if (res.ok) setJoin(null)
    else setJoin({ ...j, secure: j.secure || res.error === 'bad_password', busy: false, password: '', error: res.error === 'bad_password' ? t('settings.net.badPassword') : t('settings.net.connectFailed') })
    void reload()
  }

  let status: string
  let list: NetworkState['networks'] = []
  if (!r) status = t('settings.net.reading')
  else if (!r.available) status = t('settings.notAvailable', { what: t('settings.net.info') })
  else {
    const n = r.value
    const wired = n.devices.find((d) => d.type === 'ethernet' && d.state === 'connected')
    const active = n.networks.find((w) => w.in_use)
    status = active ? t('settings.net.connectedTo', { name: active.ssid }) : wifiPhase(n) === 'connecting' ? t('common.connecting') : wired ? t('setup.networkWired') : t('common.notConnected')
    list = n.wifi_enabled ? n.networks.slice(0, 6) : []
  }

  return (
    <section aria-labelledby="ws-setup-net" className="flex w-[900px] max-w-full flex-col gap-3 rounded-[14px] border border-[rgba(127,178,255,0.16)] bg-[rgba(14,32,72,0.6)] px-5 py-[18px]">
      <div className="flex items-center gap-4">
        <span className="flex flex-1 flex-col gap-0.5">
          <span id="ws-setup-net" className="text-[15px] font-semibold">{t('setup.network')}</span>
          <span className="text-[13px] text-[#8FA3C8]">{t('setup.networkHint')}</span>
        </span>
        <span role="status" className="text-[13px] text-[#C9D6EE]">{status}</span>
      </div>
      {list.length > 0 && (
        <ul aria-label={t('settings.net.available')} className="m-0 flex list-none flex-col gap-1 p-0">
          {list.map((w) => (
            <li key={w.ssid} className="flex items-center gap-3 rounded-lg px-2 py-1.5 hover:bg-white/5">
              <span className="flex-1 text-sm">{w.ssid}</span>
              <span className="text-xs text-[#8FA3C8]">{t('settings.net.signal', { security: w.security || t('settings.net.open'), signal: w.signal })}</span>
              {!w.in_use && <button type="button" onClick={() => { const j = { ssid: w.ssid, secure: !!w.security && !w.saved, password: '', error: null, busy: false }; if (j.secure) setJoin(j); else void connect(j) }}
                className="cursor-pointer rounded-md border border-[rgba(127,178,255,0.3)] px-3 py-1 text-xs font-semibold text-[#E8EEFA] hover:bg-white/5">{t('common.connect')}</button>}
            </li>
          ))}
        </ul>
      )}
      {join && (
        <form className="flex items-end gap-3" onSubmit={(e) => { e.preventDefault(); void connect() }}>
          {join.secure && <label className="flex flex-1 flex-col gap-1.5 text-[13px] font-semibold text-[#C9D6EE]">
            {t('settings.net.passwordFor', { name: join.ssid })}
            <input type="password" autoComplete="off" value={join.password} disabled={join.busy} onChange={(e) => setJoin({ ...join, password: e.target.value })}
              className="h-10 rounded-[10px] border border-[rgba(127,178,255,0.25)] bg-[rgba(4,10,26,0.5)] px-3 text-[15px] text-[#E8EEFA] outline-none focus:border-[#1F6BFF]" />
          </label>}
          <button type="submit" disabled={join.busy || (join.secure && !join.password)} className="cursor-pointer rounded-[10px] bg-[#1F6BFF] px-4 py-2.5 text-sm font-semibold text-white disabled:opacity-60">{t('common.connect')}</button>
          <button type="button" onClick={() => setJoin(null)} className="cursor-pointer rounded-[10px] px-4 py-2.5 text-sm text-[#C9D6EE] hover:bg-white/5">{t('common.cancel')}</button>
          {join.error && <p role="alert" className="m-0 text-[13px] text-[#FFD08A]">{join.error}</p>}
        </form>
      )}
    </section>
  )
}

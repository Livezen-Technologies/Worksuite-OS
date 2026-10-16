// G14 "Updates – offline, resume, emergency": Settings › Updates while an emergency security release is offered,
// a dropped download is being resumed, or a signed .wsupdate bundle sits on a USB drive. Everything comes from the
// update coordinator status (critical, resumed, deadline, paused/pulled reason), the update job's progress, the
// device policy and the bundles the main process found on mounted drives. Byte counts and speed are not reported
// by apt's progress, so the download line says how far it got in percent.
import { AnimatedProgress, CountUp } from '../components/AnimatedProgress'
import { useEffect, useState } from 'react'
import { formatBytes, os, packageErrorText, type BundleInfo, type DeviceInfo, type FoundBundle, type OsUpdateStatus } from '../lib/os'
import { updates } from '../lib/useOsUpdate'
import { fmtWhen, type JobProgress } from '../lib/updates'
import { Progress, Svg } from '../components/Dk'
import { formatDate, formatNumber, messages, t } from '../i18n'

const RING: Record<string, string> = messages({ development: 'upd.ring.development', pilot: 'upd.ring.pilot', stable: 'upd.ring.stable' })
const panel = 'rounded-[14px] border border-[rgba(127,178,255,0.12)] bg-[rgba(14,32,72,0.6)]'

/** Numeric dotted-version compare: >0 when a is newer. */
export function cmpVersion(a: string, b: string): number {
  const pa = a.split(/[.+~-]/).map((x) => parseInt(x, 10) || 0), pb = b.split(/[.+~-]/).map((x) => parseInt(x, 10) || 0)
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) { const d = (pa[i] ?? 0) - (pb[i] ?? 0); if (d) return d }
  return 0
}

const offered = (st: OsUpdateStatus) => (st.version && st.version !== st.installed ? st.version : null)
const emergency = (st: OsUpdateStatus) => !!st.critical && !!offered(st) && ['available', 'waiting', 'installing', 'checking'].includes(st.state)
const interrupted = (st: OsUpdateStatus) => st.state === 'waiting' && st.reason === 'download_interrupted'

/** Whether Settings › Updates shows the G14 layout instead of the regular one. */
export function showsOffline(st: OsUpdateStatus, bundles: FoundBundle[]) {
  if (st.state === 'ready_to_restart' || st.state === 'restart_pending' || st.state === 'failed') return false
  return emergency(st) || (st.state === 'installing' && !!st.resumed) || interrupted(st) || bundles.length > 0
}

/** USB bundles, re-scanned every 10 s while the page is open (drives come and go). */
export function useUsbBundles() {
  const [list, setList] = useState<FoundBundle[]>([])
  useEffect(() => {
    let live = true
    const scan = () => void os.findBundles().then((r) => { if (live && r.ok) setList((old) => (JSON.stringify(old) === JSON.stringify(r.value) ? old : r.value)) }).catch(() => {})
    scan()
    const id = setInterval(scan, 10_000)
    return () => { live = false; clearInterval(id) }
  }, [])
  return list
}

function when(iso: string) {
  const d = new Date(iso)
  return d.getTime() - Date.now() < 20 * 3_600_000 ? formatDate(d, { timeStyle: 'short' }) : formatDate(d, { dateStyle: 'medium', timeStyle: 'short' })
}

export function OfflineUpdates({ st, job, policy, orgName, bundles }: {
  st: OsUpdateStatus; job: JobProgress | null; policy: DeviceInfo['policies']; orgName: string | null; bundles: FoundBundle[]
}) {
  const [busy, setBusy] = useState(false)
  const installNow = async () => { setBusy(true); await updates.installNow(); setBusy(false) }
  const v = offered(st)
  const pct = job ? job.percent : null
  const by = orgName ? t('upd.g14.pushedBy', { org: orgName }) : t('upd.g14.releasedBy')
  const sub = st.state === 'installing' ? t('upd.g14.installingNow') : st.deadline ? t('upd.g14.autoAt', { time: when(st.deadline) }) : t('upd.g14.autoSoon')
  const pausedVal = (st.reason === 'paused' || st.reason === 'pulled') && st.version
    ? t(st.reason === 'paused' ? 'upd.g14.pausedOne' : 'upd.g14.pulledOne', { version: st.version }) : t('upd.g14.pausedNone')
  const info: [string, string][] = [
    [t('upd.ringLabel'), `${RING[policy?.update_ring ?? 'stable']} · ${policy ? t('upd.g14.setByIt') : t('upd.onThisComputer')}`],
    [t('upd.g14.paused'), pausedVal],
    [t('upd.g14.lastChecked'), st.last_check ? fmtWhen(st.last_check) : t('settings.about.notYet')],
  ]
  return (
    <div className="flex min-h-0 flex-1 flex-col gap-4">
      {emergency(st) && (
        <div role="alert" className="flex items-center gap-3.5 rounded-[14px] border border-[rgba(255,138,122,0.55)] bg-[rgba(217,69,43,0.14)] px-[18px] py-4">
          <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-[10px] bg-[#D9452B]"><Svg d="M12 3l8 3v6c0 5-3.5 8-8 9-4.5-1-8-4-8-9V6zM12 8v5M12 16h.01" size={20} stroke="#FFFFFF" /></span>
          <span className="flex flex-1 flex-col gap-0.5">
            <span className="text-[15px] font-bold">{t('upd.g14.emergency', { version: v ?? '' })}</span>
            <span className="text-[13px] text-[#FFD2CA]">{by} · {sub}</span>
          </span>
          {st.state !== 'installing' && <button type="button" disabled={busy} onClick={() => void installNow()} className="cursor-pointer rounded-[10px] bg-white px-[18px] py-2.5 text-sm font-bold text-[#8A1F10] disabled:opacity-60">{t('upd.g14.installNow')}</button>}
        </div>
      )}

      {(st.state === 'installing' || interrupted(st)) && v && (
        <div className={`${panel} flex flex-col gap-2 px-[18px] py-4`} aria-live="polite">
          <div className="flex items-center justify-between">
            <span className="text-sm font-semibold">{t('upd.g14.downloading', { version: v })}{st.resumed ? ` · ${t('upd.g14.resumed')}` : ''}</span>
            {interrupted(st) && <button type="button" disabled={busy} onClick={() => void installNow()} className="cursor-pointer text-xs text-[#7FB2FF] hover:text-[#B8D4FF] disabled:opacity-50">{t('upd.g14.resume')}</button>}
          </div>
          <Progress value={interrupted(st) ? null : pct} label={t('upd.progress')} height={8} />
          <span className="font-mono text-[11px] text-[#8FA3C8]">
            {interrupted(st) ? t('upd.g14.stopped') : st.resumed ? t('upd.g14.resumedNote', { percent: pct == null ? '…' : formatNumber(pct) }) : pct == null ? t('upd.starting') : <CountUp value={pct} />}
          </span>
        </div>
      )}

      <UsbCard st={st} bundles={bundles} />

      <div className="grid grid-cols-3 gap-3">
        {info.map(([k, val]) => (
          <div key={k} className="flex flex-col gap-1 rounded-xl border border-[rgba(127,178,255,0.1)] bg-[rgba(14,32,72,0.5)] px-4 py-3.5">
            <span className="text-xs text-[#8FA3C8]">{k}</span><span className="text-sm font-medium">{val}</span>
          </div>
        ))}
      </div>
    </div>
  )
}

function UsbCard({ st, bundles }: { st: OsUpdateStatus; bundles: FoundBundle[] }) {
  const [chosen, setChosen] = useState<{ handle: string; name: string; drive: string | null } | null>(null)
  const [info, setInfo] = useState<BundleInfo | null>(null)
  const [msg, setMsg] = useState<{ text: string; error?: boolean } | null>(null)
  const [job, setJob] = useState<string | null>(null)
  const found = chosen ?? (bundles[0] ? { ...bundles[0] } : null)
  useEffect(() => {
    setInfo(null)
    if (!found) return
    let live = true
    void os.bundleInspect(found.handle).then((r) => { if (!live) return; if (r.ok) setInfo(r.value); else setMsg({ text: packageErrorText(r.error), error: true }) })
    return () => { live = false }
  }, [found?.handle]) // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => os.onPkgJob((e) => {
    if (e.kind !== 'finished' || e.job !== job) return
    setJob(null)
    setMsg(e.result === 'success' ? { text: t('upd.usb.installed') } : { text: packageErrorText(e.error ?? 'failed'), error: true })
  }), [job])
  const choose = async () => {
    setMsg(null)
    const f = await os.pickFile('wsupdate')
    if (!f.ok) { if (f.error !== 'cancelled') setMsg({ text: packageErrorText(f.error), error: true }); return }
    setChosen({ ...f.value, drive: null })
  }
  const install = async () => {
    if (!found) return
    const r = await os.bundleInstall(found.handle)
    if (r.ok) { setJob(r.value); setMsg({ text: t('upd.usb.installing') }) } else setMsg({ text: packageErrorText(r.error), error: true })
  }
  const newer = info ? cmpVersion(info.version, st.installed) > 0 : false
  return (
    <section aria-labelledby="g14-usb" className={`${panel} flex items-center gap-4 px-5 py-[18px]`}>
      <span className="flex h-12 w-12 shrink-0 items-center justify-center rounded-xl bg-[rgba(31,107,255,0.18)]"><Svg d="M9 3h6v6H9zM6 9h12v12H6zM10 13v4M14 13v4" size={24} stroke="#7FB2FF" /></span>
      <span className="flex min-w-0 flex-1 flex-col gap-[3px]">
        <span id="g14-usb" className="text-[15px] font-semibold">{t('upd.g14.usbTitle')}</span>
        <span className="text-[13px] text-[#8FA3C8]">
          {t('upd.g14.usbHint')}{' '}
          {found && (found.drive ? t('upd.g14.foundOn', { file: found.name, drive: found.drive }) : found.name)}
          {!found && t('upd.g14.noneFound')}
        </span>
        {info && (
          <span className="flex items-center gap-1.5 text-xs" style={{ color: newer ? '#5FD39A' : '#FFB98A' }}>
            <Svg d={newer ? 'M5 12.5l4.5 4.5L19 7.5' : 'M12 8v5M12 16.5v.5'} size={14} stroke={newer ? '#5FD39A' : '#FFB98A'} />
            {t('upd.g14.verified')} · {t(newer ? 'upd.g14.newer' : 'upd.g14.notNewer', { installed: st.installed })} · {formatBytes(info.bytes)}
          </span>
        )}
        {msg && <span role={msg.error ? 'alert' : 'status'} className={`text-xs ${msg.error ? 'text-[#FF8A7A]' : 'text-[#C9D6EE]'}`}>{msg.text}</span>}
      </span>
      {info && newer
        ? <button type="button" disabled={!!job} onClick={() => void install()} className="shrink-0 cursor-pointer rounded-[10px] border border-[rgba(127,178,255,0.25)] px-[18px] py-2.5 text-sm font-medium hover:bg-white/[0.06] disabled:opacity-50">{t('upd.g14.installUsb')}</button>
        : <button type="button" disabled={!!job} onClick={() => void choose()} className="shrink-0 cursor-pointer rounded-[10px] border border-[rgba(127,178,255,0.25)] px-[18px] py-2.5 text-sm font-medium hover:bg-white/[0.06] disabled:opacity-50">{t('upd.usb.choose')}</button>}
    </section>
  )
}

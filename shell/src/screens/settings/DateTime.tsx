// Settings › Date & time: the system clock through systemd-timedated (electron/peripherals.ts, timedatectl). Time
// zone, automatic time (NTP) and, with automatic time off, setting the time by hand. Changes are system-wide, so
// polkit asks for an administrator through the session's agent; the panel re-reads the clock after every change, so
// what it shows is what the system has, not what was asked for.
import { useEffect, useState } from 'react'
import { Switch, card } from '../../components/Dk'
import { Empty } from '../Hardware'
import { peripheralsApi, type ClockState } from '../../lib/peripheralsApi'
import { formatDate, t, type MessageKey } from '../../i18n'
import { H1, Note, Unavail } from './ui'

const pad = (n: number) => String(n).padStart(2, '0')
/** The clock's time in its own zone as YYYY-MM-DDTHH:MM, the value a datetime-local field takes. */
export function localInput(nowUs: number, tz: string): string {
  const parts = Object.fromEntries(new Intl.DateTimeFormat('en-GB', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' })
    .formatToParts(new Date(nowUs / 1000)).map((p) => [p.type, p.value]))
  return `${parts.year}-${parts.month}-${parts.day}T${parts.hour}:${parts.minute}`
}
const reasonText = (r: string) => {
  const k = `settings.dt.err.${r}` as MessageKey
  return ['not_authorized', 'ntp_on', 'invalid_argument'].includes(r) ? t(k) : t('settings.dt.err.failed')
}

export function DateTimePanel() {
  const api = peripheralsApi()
  const [clock, setClock] = useState<{ available: true; value: ClockState } | { available: false; reason: string } | null>(null)
  const [zones, setZones] = useState<string[]>([])
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [manual, setManual] = useState('')
  const [tick, setTick] = useState(0)
  const load = () => api ? api.clock().then((c) => { setClock(c); if (c.available) setManual((m) => m || localInput(c.value.nowUs, c.value.timezone)) }) : Promise.resolve(setClock({ available: false, reason: 'unavailable' }))
  useEffect(() => { void load(); if (api) void api.timezones().then((z) => { if (z.available) setZones(z.value) }) }, [])
  useEffect(() => { const id = setInterval(() => setTick((n) => n + 1), 1000); return () => clearInterval(id) }, [])

  const apply = async (fn: () => Promise<{ available: boolean; reason?: string }>) => {
    setBusy(true); setError(null)
    const r = await fn()
    if (!r.available) setError(reasonText(r.reason ?? 'failed'))
    await load(); setBusy(false)
    return r.available
  }

  if (!clock) return <><H1>{t('settings.nav.Date & time')}</H1><Empty title={t('settings.dt.reading')} /></>
  if (!clock.available) return <><H1>{t('settings.nav.Date & time')}</H1><Unavail what={t('settings.nav.Date & time')} reason={clock.reason} /></>
  const c = clock.value
  // The renderer's clock is the system clock; the tick only re-renders it every second. (Adding the seconds since the
  // panel opened to the last read made it run fast after every re-read, seen in a VM.)
  void tick
  const shownMs = Date.now()
  const list = zones.includes(c.timezone) ? zones : [c.timezone, ...zones]
  return <>
    <H1>{t('settings.nav.Date & time')}</H1>
    <div className={`${card} flex flex-col gap-1 px-5 py-[18px]`}>
      <span className="text-[34px] font-semibold tabular-nums" aria-live="off">{formatDate(shownMs, { timeZone: c.timezone, hour: '2-digit', minute: '2-digit', second: '2-digit' })}</span>
      <span className="text-[14px] text-[#C9D6EE]">{formatDate(shownMs, { timeZone: c.timezone, dateStyle: 'full' })}</span>
      <span className="text-[13px] text-[#8FA3C8]">{c.ntp ? (c.synchronized ? t('settings.dt.synced') : t('settings.dt.notSynced')) : t('settings.dt.manualNow')}</span>
    </div>
    {error && <p role="alert" className="m-0 text-[13px] text-[#FFB4A6]">{error}</p>}
    <div className={`${card} flex flex-col gap-4 px-5 py-[18px]`}>
      <label className="flex flex-col gap-1.5 text-[13px] font-semibold text-[#C9D6EE]">{t('settings.dt.zone')}
        <select className="h-11 rounded-xl border border-[rgba(127,178,255,0.22)] bg-[rgba(4,10,26,0.55)] px-3 text-[14px] text-[#E8EEFA]" value={c.timezone} disabled={busy}
          onChange={(e) => { const tz = e.target.value; void apply(() => api!.setTimezone(tz)) }}>
          {list.map((z) => <option key={z} value={z}>{z.replace(/_/g, ' ')}</option>)}
        </select>
      </label>
      <Switch label={t('settings.dt.auto')} checked={c.ntp} disabled={busy || !c.canNtp} unavailable={c.canNtp ? undefined : t('settings.dt.noNtp')}
        onChange={(v) => apply(() => api!.setNtp(v))} />
      {!c.ntp && (
        <div className="flex flex-wrap items-end gap-3">
          <label className="flex flex-col gap-1.5 text-[13px] font-semibold text-[#C9D6EE]">{t('settings.dt.set')}
            <input type="datetime-local" className="h-11 rounded-xl border border-[rgba(127,178,255,0.22)] bg-[rgba(4,10,26,0.55)] px-3 text-[14px] text-[#E8EEFA]"
              value={manual} onChange={(e) => setManual(e.target.value)} disabled={busy} />
          </label>
          <button type="button" className="h-11 rounded-xl bg-[#1F6BFF] px-5 text-[14px] font-semibold text-white disabled:opacity-50" disabled={busy || !manual}
            onClick={() => void apply(() => api!.setTime(manual.replace('T', ' '), c.timezone))}>{t('settings.dt.apply')}</button>
        </div>
      )}
    </div>
    <Note>{t('settings.dt.note')}</Note>
  </>
}

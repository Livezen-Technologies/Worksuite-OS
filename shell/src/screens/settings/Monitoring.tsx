// Settings › Privacy & security › Employee monitoring (#22): whether the organization monitors activity, exactly what
// is and is not collected, retention, the employee's own recorded days, and what the organization's server holds.
import { useEffect, useState } from 'react'
import { C, Svg, btnGhost, card, chip, rowLine } from '../../components/Dk'
import { formatDuration, os, type ActivityRemote, type ActivityStatus } from '../../lib/os'
import { fmtWhen } from '../../lib/updates'
import { formatNumber, formatTime, t } from '../../i18n'

export const EYE = 'M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7S2 12 2 12zM12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6z'
const hrs = (s: number) => formatDuration(s) ?? t('time.aboutM', { m: 0 })

/** Everything the policy has the shell collect (#22, #39); the same list in the disclosure and in Settings. */
export function CollectedList({ s }: { s: ActivityStatus }) {
  return <ul className="m-0 pl-4">
    <li>{t('mon.c.time')}</li><li>{t('mon.c.apps')}</li><li>{t('mon.c.events')}</li>
    <li>{t('mon.c.live')}</li><li>{t('mon.c.power')}</li><li>{t('mon.c.attendance')}</li>
    {s.web_domains && <li>{t('mon.c.web')}</li>}
  </ul>
}

const clock = (ms: number | null) => ms === null ? '—' : formatTime(ms)

export function useActivity(initial?: ActivityStatus | null) {
  const [s, setS] = useState<ActivityStatus | null>(initial ?? null)
  useEffect(() => {
    if (initial !== undefined) return
    void os.activityStatus().then(setS).catch(() => {})
    return os.onActivityChanged(setS)
  }, [initial])
  return [s, setS] as const
}

export function MonitoringSection({ initial }: { initial?: ActivityStatus | null }) {
  const [s] = useActivity(initial)
  const [remote, setRemote] = useState<string | null>(null)
  const [power, setPower] = useState<ActivityRemote['device_events']>([])
  const loadRemote = () => void os.activityRemote().then((r) => {
    if (!r.ok) { setRemote(t('mon.serverError')); return }
    setRemote(`${t('mon.serverDays', { count: formatNumber(r.value.items.length) })} ${t('mon.serverMore', { count: formatNumber(r.value.device_events.length) })}`)
    setPower(r.value.device_events)
  })
  const today = s?.days[0]
  return (
    <section aria-labelledby="mon-title" className="flex flex-col gap-2">
      <h2 id="mon-title" className="m-0 flex items-center gap-2 text-sm font-semibold"><Svg d={EYE} size={16} stroke={s?.enabled ? C.amber : C.muted} />{t('mon.title')}
        <span className={chip}>{s?.enabled ? t('mon.on', { org: s.org_name ?? t('settings.about.yourOrg') }) : t('mon.off')}</span></h2>
      {!s?.enabled ? <div className={`${card} px-4 py-3 text-xs text-[#8FA3C8]`}>{t('mon.offHint')}</div> : <>
        <div className={`${card} grid gap-3 px-4 py-3 text-xs leading-relaxed text-[#C9D6EE]`} style={{ gridTemplateColumns: 'minmax(0,1fr) minmax(0,1fr)' }}>
          <div><div className="mb-1 font-semibold text-[#E8EEFA]">{t('mon.collected')}</div>
            <CollectedList s={s} /></div>
          <div><div className="mb-1 font-semibold text-[#E8EEFA]">{t('mon.notCollected')}</div><p className="m-0">{t('mon.n.list')}</p>
            <p className="m-0 mt-2 text-[#8FA3C8]">{t('mon.retention', { days: formatNumber(s.retention_days), minutes: formatNumber(Math.round(s.idle_threshold_s / 60)) })}</p></div>
        </div>
        <div className={`${card} overflow-hidden`} role="table" aria-label={t('mon.yourData')}>
          <div role="row" className="flex px-4 py-[9px] text-[11px] text-[#8FA3C8]">
            <span role="columnheader" className="flex-1">{t('mon.yourData')}</span>
            <span role="columnheader" className="w-20 text-right">{t('mon.active')}</span><span role="columnheader" className="w-20 text-right">{t('mon.idle')}</span><span role="columnheader" className="w-20 text-right">{t('mon.locked')}</span>
          </div>
          {!s.days.length ? <div role="row" className={`px-4 py-2.5 text-xs text-[#8FA3C8] ${rowLine}`}><span role="cell">{t('mon.noData')}</span></div>
            : s.days.slice(0, 7).map((d) => (
              <div role="row" key={d.day} className={`flex items-center px-4 py-2 text-xs ${rowLine}`}>
                <span role="cell" className="flex-1">{d.day}</span>
                <span role="cell" className="w-20 text-right">{hrs(d.active_s)}</span><span role="cell" className="w-20 text-right">{hrs(d.idle_s)}</span><span role="cell" className="w-20 text-right">{hrs(d.locked_s)}</span>
              </div>
            ))}
        </div>
        {s.live && <div className={`${card} px-4 py-2.5 text-xs`} data-testid="mon-live">
          {t('mon.liveNow', { state: t(s.live.state === 'active' ? 'mon.active' : s.live.state === 'idle' ? 'mon.idle' : 'mon.locked'),
            app: s.live.app_id ? ` · ${today?.apps.find((a) => a.app_id === s.live!.app_id)?.name ?? s.live.app_id}` : '', when: fmtWhen(s.live.at) })}
        </div>}
        {today && today.first_active !== null && <div className="text-[11px] text-[#8FA3C8]">{today.day} · {t('mon.workday', { first: clock(today.first_active), last: clock(today.last_active) })}</div>}
        {today && today.apps.length > 0 && <div className={`${card} px-4 py-3 text-xs`}>
          <div className="mb-1 text-[11px] text-[#8FA3C8]">{t('mon.topApps')} · {today.day}</div>
          {today.apps.slice(0, 8).map((a) => <div key={a.app_id} className="flex justify-between py-0.5"><span>{a.name}</span><span className="text-[#C9D6EE]">{hrs(a.active_s)}</span></div>)}
        </div>}
        {s.web_domains && today && (today.domains?.length ?? 0) > 0 && <div className={`${card} px-4 py-3 text-xs`}>
          <div className="mb-1 text-[11px] text-[#8FA3C8]">{t('mon.websites')} · {today.day}</div>
          {today.domains!.slice(0, 8).map((d) => <div key={d.domain} className="flex justify-between py-0.5"><span>{d.domain}</span><span className="text-[#C9D6EE]">{hrs(d.active_s)}</span></div>)}
        </div>}
        {power.length > 0 && <div className={`${card} px-4 py-3 text-xs`}>
          <div className="mb-1 text-[11px] text-[#8FA3C8]">{t('mon.deviceEvents')}</div>
          {power.slice(0, 10).map((e) => <div key={`${e.device_id}-${e.at}-${e.type}`} className="flex justify-between py-0.5"><span>{t(e.type === 'startup' ? 'mon.startup' : 'mon.shutdown')}</span><span className="text-[#C9D6EE]">{fmtWhen(e.at)}</span></div>)}
        </div>}
        <div className="flex items-center gap-3 text-[11px] text-[#8FA3C8]">
          <span className="flex-1">{s.last_sent ? t('mon.lastSent', { when: fmtWhen(s.last_sent) }) : t('mon.notSent')}{remote ? ` · ${remote}` : ''}</span>
          <button type="button" className={btnGhost} onClick={loadRemote}>{t('mon.serverData')}</button>
        </div>
      </>}
    </section>
  )
}

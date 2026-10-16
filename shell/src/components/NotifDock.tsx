// Notification dock (NotifDock board): clock and focus mode, the month, and the shell's notices. Notices come from
// the system sources in lib/useNotices; chat and mail don't post here yet, so "Mentions" stays empty and says why.
// There is no media-session (MPRIS) bridge, so the board's now-playing card is left out.
import { useThemeIcon } from '../lib/appIcons'
import { useState, type ReactNode } from 'react'
import BIcon from './BIcon'
import { Icon, P } from './Ws'
import type { TimedNotice } from '../lib/useNotices'
import { AppNoticeActions, dismissAppNotices } from './AppNoticeActions'
import { appIdOf, notificationsApi } from '../lib/appNotifications'
import { ageLabel } from '../lib/power'
import { localeTag, useT } from '../i18n'
import { AnimatedProgress, CountUp } from './AnimatedProgress'

const TONE_BG: Record<TimedNotice['tone'], string> = { ok: '#2E9E6A', warn: '#B7791F', error: '#D9452B' }
const glass = 'rounded-[22px] border border-white/10 bg-[rgba(12,28,64,0.72)] shadow-[0_20px_50px_rgba(0,0,0,0.4)] backdrop-blur-[28px] backdrop-saturate-[1.4]'
const BELL = ['M6 8a6 6 0 0 1 12 0c0 7 3 8 3 8H3s3-1 3-8M10 20a2 2 0 0 0 4 0']
const MOON = ['M20 14A8 8 0 1 1 10 4a6 6 0 0 0 10 10z']
type Tab = 'all' | 'mentions' | 'system'

export default function NotifDock({ now, time, notices, setNotices, dnd, setDnd }: {
  now: Date; time: string; notices: TimedNotice[]; setNotices: (n: TimedNotice[]) => void; dnd: boolean; setDnd: (v: boolean) => void
}) {
  const t = useT()
  const [tab, setTab] = useState<Tab>('all')
  const [month, setMonth] = useState(() => new Date(now.getFullYear(), now.getMonth(), 1))
  const longDate = now.toLocaleDateString(localeTag(), { weekday: 'long', day: 'numeric', month: 'long' })
  const modes = [
    { on: !dnd, label: t('dock.everything'), d: BELL, bg: '#1F6BFF', pick: () => setDnd(false) },
    { on: dnd, label: t('quick.dnd'), d: MOON, bg: '#7A4FE0', pick: () => setDnd(true) },
  ]
  // Monday-first month grid.
  const lead = (month.getDay() + 6) % 7
  const daysIn = new Date(month.getFullYear(), month.getMonth() + 1, 0).getDate()
  const isThisMonth = month.getFullYear() === now.getFullYear() && month.getMonth() === now.getMonth()
  const dow = Array.from({ length: 7 }, (_, i) => new Date(2024, 0, 1 + i).toLocaleDateString(localeTag(), { weekday: 'narrow' }))
  const shift = (n: number) => setMonth(new Date(month.getFullYear(), month.getMonth() + n, 1))

  const shown = tab === 'mentions' ? [] : notices
  const priority = shown.filter((n) => n.tone !== 'ok')
  const earlier = shown.filter((n) => n.tone === 'ok')
  // App notifications are closed on the server too, so the app gets NotificationClosed (WSOS-INT-007).
  const dismiss = (id: string) => { const a = appIdOf({ id }); if (a !== null) void notificationsApi()?.dismiss(a); setNotices(notices.filter((n) => n.id !== id)) }
  const tabs: [Tab, string][] = [['all', t('dock.all')], ['mentions', t('dock.mentions')], ['system', t('dock.system')]]

  return (
    <aside id="ws-notifications" aria-label={t('notes.title')} className="absolute top-3 right-3 bottom-16 z-40 flex w-[408px] max-w-[calc(100%-24px)] flex-col gap-2.5 text-[#E8EEFA]">
      <div className={`${glass} flex gap-4 p-4`}>
        <div className="flex min-w-0 flex-1 flex-col gap-2.5">
          <span className="flex flex-col"><span className="text-[34px] leading-none font-light tracking-[-0.03em]">{time}</span><span className="mt-1 text-xs text-[#8FA3C8]">{longDate}</span></span>
          <div role="radiogroup" aria-label={t('dock.focus')} className="flex flex-col gap-1">
            {modes.map((m) => (
              <button key={m.label} type="button" role="radio" aria-checked={m.on} onClick={m.pick}
                className="flex cursor-pointer items-center gap-2 rounded-[10px] px-2.5 py-1.5 text-left text-xs font-medium" style={{ background: m.on ? m.bg : 'rgba(255,255,255,0.06)' }}>
                <Icon d={m.d} size={13} stroke="#FFFFFF" />{m.label}
              </button>
            ))}
          </div>
        </div>
        <div className="w-[176px] flex-none">
          <div className="mb-1.5 flex items-center justify-between text-[11px]">
            <span className="font-semibold">{month.toLocaleDateString(localeTag(), { month: 'long', year: isThisMonth ? undefined : 'numeric' })}</span>
            <span className="flex gap-0.5 text-[#8FA3C8]">
              <button type="button" aria-label={t('dock.prevMonth')} onClick={() => shift(-1)} className="cursor-pointer rounded px-1 hover:text-white">‹</button>
              <button type="button" aria-label={t('dock.nextMonth')} onClick={() => shift(1)} className="cursor-pointer rounded px-1 hover:text-white">›</button>
            </span>
          </div>
          <div className="grid grid-cols-7 gap-0.5 text-center text-[10px]" role="group" aria-label={t('dock.calendar')}>
            {dow.map((d, i) => <span key={i} className="pb-0.5 text-[#8FA3C8]" aria-hidden="true">{d}</span>)}
            {Array.from({ length: lead }, (_, i) => <span key={`e${i}`} />)}
            {Array.from({ length: daysIn }, (_, i) => {
              const day = i + 1
              const today = isThisMonth && day === now.getDate()
              const past = isThisMonth ? day < now.getDate() : month < now
              return <span key={day} aria-current={today ? 'date' : undefined} className="flex h-5 items-center justify-center rounded-md"
                style={{ background: today ? '#1F6BFF' : 'transparent', color: today ? '#FFFFFF' : past ? '#8FA3C8' : '#E8EEFA', fontWeight: today ? 700 : 400 }}>{day}</span>
            })}
          </div>
        </div>
      </div>

      <div className={`${glass} flex min-h-0 flex-1 flex-col overflow-hidden`}>
        <div className="flex items-center gap-2.5 px-4 pt-3.5 pb-2.5">
          <h2 className="m-0 text-[15px] font-semibold">{t('notes.title')}</h2>
          <span className="flex h-5 min-w-5 items-center justify-center rounded-[10px] bg-[rgba(31,107,255,0.35)] px-1.5 text-[11px] font-bold">{notices.length}</span>
          {notices.length > 0 && <button type="button" onClick={() => { dismissAppNotices(notices); setNotices([]) }} className="ml-auto cursor-pointer text-xs text-[#7FB2FF] hover:text-[#B8D4FF]">{t('notes.clearAll')}</button>}
        </div>
        <div role="tablist" aria-label={t('notes.title')} className="mx-4 mb-2.5 flex rounded-[10px] bg-white/[0.06] p-[3px]">
          {tabs.map(([id, label]) => (
            <button key={id} type="button" role="tab" aria-selected={tab === id} onClick={() => setTab(id)}
              className={`flex-1 cursor-pointer rounded-lg py-1.5 text-center text-xs font-semibold ${tab === id ? 'bg-white/[0.14] text-white' : 'text-[#8FA3C8]'}`}>{label}</button>
          ))}
        </div>
        <div className="flex min-h-0 flex-1 flex-col gap-2 overflow-auto px-3 pb-3">
          {shown.length === 0 && (
            <div className="flex flex-1 flex-col items-center justify-center gap-2.5 py-10 text-center text-[13px] text-[#8FA3C8]">
              <span className="flex h-14 w-14 items-center justify-center rounded-full bg-[rgba(95,211,154,0.12)]"><Icon d={P.check} size={26} stroke="#5FD39A" /></span>
              {tab === 'mentions' ? t('dock.noMentions') : t('dock.caughtUp')}
            </div>
          )}
          {[[t('dock.priority'), priority, '#18D4F0'], [t('dock.earlier'), earlier, '#5E739C']].map(([name, items, c]) => (items as TimedNotice[]).length > 0 && (
            <section key={name as string} aria-label={name as string} className="flex flex-col gap-2">
              <h3 className="m-0 px-1.5 pt-1 text-[11px] font-semibold tracking-[0.08em] uppercase" style={{ color: c as string }}>{name as string}</h3>
              {(items as TimedNotice[]).map((x) => (
                <div key={x.id} className="relative flex gap-3 rounded-2xl border p-3" style={{ background: x.tone !== 'ok' ? 'rgba(255,255,255,0.08)' : 'rgba(255,255,255,0.045)', borderColor: 'rgba(255,255,255,0.07)' }}>
                  <NoticeIcon icon={x.icon}><span className="flex h-[38px] w-[38px] flex-none items-center justify-center rounded-[10px] text-white" style={{ background: TONE_BG[x.tone] }}><BIcon name={x.tone === 'ok' ? 'check' : 'alert'} size={18} /></span></NoticeIcon>
                  <span className="flex min-w-0 flex-1 flex-col gap-[3px]">
                    <span className="flex items-baseline gap-1.5"><span className="truncate text-[13px] font-semibold">{x.title}</span><span className="ml-auto flex-none text-[11px] text-[#8FA3C8]">{ageLabel(x.at, now.getTime())}</span></span>
                    <span className="text-xs leading-[1.4] text-[#C9D6EE]">{x.body}</span>
                    {x.value != null && <span className="mt-1 flex items-center gap-2"><AnimatedProgress value={x.value} label={x.title} height={4} className="flex-1" tone={x.value >= 100 ? 'success' : 'default'} /><span className="font-mono text-[11px] text-[#8FA3C8]"><CountUp value={Math.round(x.value)} /></span></span>}
                    {x.app && <AppNoticeActions notice={x} onDone={() => setNotices(notices.filter((n) => n.id !== x.id))} />}
                  </span>
                  <button type="button" aria-label={t('notes.dismiss')} onClick={() => dismiss(x.id)}
                    className="absolute -top-1.5 -left-1.5 flex h-5 w-5 cursor-pointer items-center justify-center rounded-full border border-white/15 bg-[#2A3B66] text-xs leading-none hover:bg-[#3A4E80]"><Icon d={P.close} size={10} /></button>
                </div>
              ))}
            </section>
          ))}
        </div>
      </div>
    </aside>
  )
}

export { MOON }

/** The sending app's icon when it resolves; otherwise the tone mark (children). */
function NoticeIcon({ icon, children }: { icon?: string; children: ReactNode }) {
  const src = useThemeIcon(icon, 38)
  return src ? <img aria-hidden="true" alt="" src={src} width={38} height={38} className="ws-icon size-[38px] flex-none object-contain" /> : <>{children}</>
}

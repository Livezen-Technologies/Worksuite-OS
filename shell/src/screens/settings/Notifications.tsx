// Settings › Notifications (from Settings.tsx).
import { type ReactNode } from 'react'
import { useDnd } from '../../lib/dnd'
import { BigSwitch } from './ui'
import { Svg, Switch, card, rowLine } from '../../components/Dk'
import { t } from '../../i18n'
import { H1, Note } from './common'

// Notification sources table (#52): header and rows share the table's columns through subgrid.
const notifTable = 'grid grid-cols-[minmax(0,1fr)_repeat(3,minmax(4.5rem,max-content))_max-content] overflow-hidden @max-[520px]:block'
const notifRow = 'col-span-full grid grid-cols-subgrid gap-x-4 px-4 @max-[520px]:grid-cols-[minmax(0,1fr)_auto] @max-[520px]:gap-y-1.5'

/** One setting of a source; in the narrow (card) layout it carries its own label, as the header row is hidden. */
function NotifCell({ label, soft, children }: { label: string; soft?: boolean; children: ReactNode }) {
  return (
    <span role="cell" className={`min-w-0 break-words @max-[520px]:col-span-2 @max-[520px]:pl-[38px] ${soft ? 'text-[#C9D6EE]' : ''}`}>
      <span className="hidden text-[11px] text-[#8FA3C8] @max-[520px]:inline" aria-hidden="true">{label}: </span>{children}
    </span>
  )
}

/** SetNotifications board. The shell's notification sources are its own system services; there are no per-app
 *  notifications yet, so each source shows how it really behaves and can't be switched off. */
export function NotificationsPanel() {
  const [dnd, setDnd] = useDnd()
  const general = [
    [t('settings.notif.onLock'), t('settings.notif.titlesOnly')],
    [t('settings.notif.position'), t('settings.notif.topRight')],
    [t('settings.notif.badge'), t('common.on')],
  ]
  const sources = [
    { n: t('settings.notif.sync'), d: t('settings.notif.syncHint'), i: 'D', c: '#B7791F', b: t('settings.notif.banners'), l: t('settings.notif.titlesOnly') },
    { n: t('settings.nav.Updates'), d: t('settings.notif.updatesHint'), i: 'U', c: '#1F6BFF', b: t('settings.notif.cards'), l: t('settings.notif.hidden') },
    { n: t('settings.notif.devices'), d: t('settings.notif.devicesHint'), i: 'H', c: '#5E739C', b: t('settings.notif.cards'), l: t('settings.notif.hidden') },
  ]
  return <>
    <H1>{t('settings.nav.Notifications')}</H1>
    <div className="flex items-center gap-4 rounded-2xl border px-5 py-4" style={{ background: dnd ? 'rgba(122,79,224,0.18)' : 'rgba(14,32,72,0.7)', borderColor: dnd ? 'rgba(185,160,255,0.5)' : 'rgba(127,178,255,0.14)' }}>
      <span className="flex h-11 w-11 items-center justify-center rounded-xl" style={{ background: dnd ? '#7A4FE0' : 'rgba(127,178,255,0.2)' }}><Svg d="M20 14A8 8 0 1 1 10 4a6 6 0 0 0 10 10z" size={22} stroke="#FFFFFF" /></span>
      <span className="flex flex-1 flex-col gap-0.5"><span className="text-base font-semibold">{t('quick.dnd')}</span><span className="text-xs text-[#C9D6EE]">{dnd ? t('settings.notif.dndOn') : t('settings.notif.dndOff')}</span></span>
      <BigSwitch label={t('quick.dnd')} checked={dnd} color="#7A4FE0" onChange={setDnd} />
    </div>
    <div className="grid grid-cols-3 gap-2.5">
      {general.map(([k, v]) => <div key={k} className={`${card} flex flex-col gap-1.5 px-3.5 py-[13px]`}><span className="text-xs text-[#8FA3C8]">{k}</span><span className="text-sm font-medium">{v}</span></div>)}
    </div>
    <div className="flex items-baseline justify-between"><h2 className="m-0 text-sm font-semibold">{t('settings.notif.sources')}</h2><span className="text-[11px] text-[#8FA3C8]">{t('settings.notif.sourcesHint')}</span></div>
    {/* One grid for header and rows (subgrid), so columns size to their content in every language and at every
        scale instead of fixed 90/60 px tracks the switch and longer labels overflowed (#52). Below 520 px of panel
        width each source becomes a card: name and switch on top, the three settings labelled underneath. */}
    <div className="@container">
      <div className={`${card} ${notifTable}`} role="table" aria-label={t('settings.notif.sources')}>
        <div role="row" className={`${notifRow} border-b border-[rgba(127,178,255,0.1)] py-[9px] text-[11px] text-[#8FA3C8] @max-[520px]:sr-only`}>
          <span role="columnheader">{t('settings.notif.source')}</span><span role="columnheader">{t('settings.notif.banners')}</span><span role="columnheader">{t('settings.notif.lockScreen')}</span><span role="columnheader">{t('settings.notif.sound')}</span><span role="columnheader"><span className="sr-only">{t('settings.notif.allowed')}</span></span>
        </div>
        {sources.map((a) => (
          <div role="row" key={a.n} className={`${notifRow} items-center py-2.5 text-[13px] ${rowLine}`}>
            <span role="cell" className="flex min-w-0 items-center gap-2.5 @max-[520px]:col-start-1 @max-[520px]:row-start-1"><span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-[7px] text-xs font-bold" style={{ background: a.c }} aria-hidden="true">{a.i}</span><span className="flex min-w-0 flex-col"><span className="break-words">{a.n}</span><span className="text-[11px] break-words text-[#8FA3C8]">{a.d}</span></span></span>
            <NotifCell label={t('settings.notif.banners')}>{a.b}</NotifCell>
            <NotifCell label={t('settings.notif.lockScreen')} soft>{a.l}</NotifCell>
            <NotifCell label={t('settings.notif.sound')} soft>{t('common.off')}</NotifCell>
            <span role="cell" className="justify-self-end @max-[520px]:col-start-2 @max-[520px]:row-start-1"><Switch small label={t('settings.notif.allowName', { name: a.n })} checked disabled /></span>
          </div>
        ))}
      </div>
    </div>
    <Note>{t('settings.notif.note')}</Note>
  </>
}

// Desktop widgets: WorkSuite Desktop's Home cards (worksuite-desktop src/modules/home) on the wallpaper, once the OS
// has a WorkSuite account through the credentials broker. The data comes from the main process (electron/widgets.ts,
// the token never reaches here); every server string is rendered as React text, never as HTML. Each widget has its
// own loading, empty, error and offline states; one the person's org does not enable is absent, as on Desktop.
// Edit mode (the wallpaper's right-click menu): remove, move (drag, or the arrow buttons by keyboard), wide or
// narrow; "Add widgets" opens the picker. The layout is saved to the synced shell preferences by Desktop.tsx.
import { useCallback, useEffect, useMemo, useRef, useState, type DragEvent, type ReactNode } from 'react'
import { os } from '../lib/os'
import { formatTime, localeTag, useT, type MessageKey } from '../i18n'
import { Icon, P } from './Ws'
import type { WidgetsSnapshot } from '../../electron/widgets'
import {
  WIDGETS, add, agendaOf, available, compactCount, move, place, rankNotices, remove, resize, shown, sizeOf, taskBuckets,
  type WidgetId, type WidgetLayout,
} from '../lib/widgets'

/** Refresh every five minutes, on reconnect, and when asked. */
export const REFRESH_MS = 5 * 60_000

const loadWidgets = () => os.widgets()

export function useWidgetData(enabled: boolean, load: () => Promise<WidgetsSnapshot> = loadWidgets) {
  const [snap, setSnap] = useState<WidgetsSnapshot | null>(null)
  const [loading, setLoading] = useState(false)
  const [online, setOnline] = useState(() => (typeof navigator === 'undefined' ? true : navigator.onLine !== false))
  const live = useRef(true)
  const refresh = useCallback(() => {
    if (!enabled) return
    setLoading(true)
    void load().then((s) => { if (live.current) setSnap(s) }).catch(() => undefined).finally(() => { if (live.current) setLoading(false) })
  }, [enabled, load])
  useEffect(() => {
    live.current = true
    if (!enabled) { setSnap(null); return }
    refresh()
    const t = setInterval(refresh, REFRESH_MS)
    const up = () => { setOnline(true); refresh() }
    const down = () => setOnline(false)
    window.addEventListener('online', up)
    window.addEventListener('offline', down)
    return () => { live.current = false; clearInterval(t); window.removeEventListener('online', up); window.removeEventListener('offline', down) }
  }, [enabled, refresh])
  return { snap, loading, online, refresh }
}

const ICON: Record<WidgetId, readonly string[]> = {
  glance: ['M4 4h7v7H4z', 'M13 4h7v7h-7z', 'M4 13h7v7H4z', 'M13 13h7v7h-7z'],
  work: ['M9 11l3 3 8-8', 'M20 12v7a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V5a1 1 0 0 1 1-1h11'],
  calendar: ['M4 6h16v14H4z', 'M4 10h16', 'M8 3v4', 'M16 3v4'],
  waiting: ['M12 7v5l3 2', 'M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18z'],
  announcements: ['M3 11v2l13 5V6z', 'M16 8a4 4 0 0 1 0 8', 'M7 13l1 5h3l-1-4'],
  summary: ['M12 3l1.8 4.2L18 9l-4.2 1.8L12 15l-1.8-4.2L6 9l4.2-1.8z', 'M19 15l.8 1.7 1.7.8-1.7.8L19 20l-.8-1.7-1.7-.8 1.7-.8z'],
  activity: ['M3 12h4l3-8 4 16 3-8h4'],
  files: ['M3 6h6l2 2h10v11H3z'],
}
/** Where a widget's header link goes: the module, through the usual worksuite:// launch path. */
const MODULE: Partial<Record<WidgetId, string>> = { work: 'worksuite://tasks', calendar: 'worksuite://calendar', waiting: 'worksuite://hr', announcements: 'worksuite://home', activity: 'worksuite://home', files: 'worksuite://files', summary: 'worksuite://home' }
const EXT_COLOR: Record<string, string> = { xlsx: '#2E9E6A', ods: '#2E9E6A', csv: '#2E9E6A', docx: '#1F6BFF', odt: '#1F6BFF', doc: '#1F6BFF', pptx: '#D9572B', odp: '#D9572B', pdf: '#D9452B', png: '#7A4FE0', jpg: '#7A4FE0', jpeg: '#7A4FE0' }
const DRAG = 'application/x-worksuite-widget'

const timeOf = (s: string) => { const d = new Date(s.length === 10 ? `${s}T00:00:00` : s.replace(' ', 'T')); return Number.isNaN(d.getTime()) ? '' : formatTime(d) }
const dayOrTime = (s: string | null, today: string) => {
  if (!s) return ''
  if (s.slice(0, 10) === today) return timeOf(s)
  const d = new Date(`${s.slice(0, 10)}T12:00:00`)
  return Number.isNaN(d.getTime()) ? '' : d.toLocaleDateString(localeTag(), { day: 'numeric', month: 'short' })
}
const open = (link: string) => void os.openSearchResult(link).catch(() => undefined)

interface Props {
  snap: WidgetsSnapshot | null
  loading: boolean
  online: boolean
  layout: WidgetLayout
  onLayout: (l: WidgetLayout) => void
  editing: boolean
  onEditing: (v: boolean) => void
  picker: boolean
  onPicker: (v: boolean) => void
  onRefresh: () => void
  onSignIn: () => void
  /** The current day and minute, from Desktop's clock. */
  now: Date
}

export default function DesktopWidgets({ snap, loading, online, layout, onLayout, editing, onEditing, picker, onPicker, onRefresh, onSignIn, now }: Props) {
  const t = useT()
  const today = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`
  const nowMin = now.getHours() * 60 + now.getMinutes()

  if (!snap) return loading ? <Region t={t}><p className="m-0 rounded-2xl bg-[rgba(10,24,56,0.94)] px-4 py-3 text-[13px] text-[#8FA3C8]">{t('widgets.loading')}</p></Region> : null
  if (snap.state === 'disabled') return null
  // Signed out or not enrolled: one quiet card, never data.
  const gate: MessageKey | null = snap.state === 'not_signed_in' ? 'widgets.signIn' : snap.state === 'locked' ? 'widgets.locked' : snap.state === 'auth_required' ? 'widgets.authRequired' : (snap.state === 'offline' || snap.state === 'error') && snap.fetchedAt === null ? (snap.state === 'offline' ? 'widgets.offlineNone' : 'widgets.error') : null
  if (gate) {
    return (
      <Region t={t}>
        <div className="flex w-[320px] max-w-full items-center gap-3 rounded-2xl border border-[rgba(127,178,255,0.2)] bg-[rgba(10,24,56,0.94)] px-4 py-3 text-[#E8EEFA]">
          <span className="min-w-0 flex-1 text-[13px] leading-snug text-[#C9D6EE]">{t(gate)}</span>
          {gate === 'widgets.error' || gate === 'widgets.offlineNone'
            ? <button type="button" onClick={onRefresh} className="shrink-0 cursor-pointer rounded-lg bg-white/[0.07] px-3 py-1.5 text-xs hover:bg-white/10">{t('widgets.retry')}</button>
            : <button type="button" onClick={onSignIn} className="shrink-0 cursor-pointer rounded-lg bg-white/[0.07] px-3 py-1.5 text-xs hover:bg-white/10">{t('widgets.signInAction')}</button>}
        </div>
      </Region>
    )
  }
  return <Board {...{ snap, layout, onLayout, editing, onEditing, picker, onPicker, onRefresh, today, nowMin, online, loading, t }} />
}

function Region({ t, children }: { t: ReturnType<typeof useT>; children: ReactNode }) {
  return <section aria-label={t('widgets.region')} className="ws-widgets absolute top-6 right-6 z-[5] flex max-w-[calc(100%-48px)] flex-col items-end gap-3">{children}</section>
}

function Board({ snap, layout, onLayout, editing, onEditing, picker, onPicker, onRefresh, today, nowMin, online, loading, t }: {
  snap: WidgetsSnapshot; layout: WidgetLayout; onLayout: (l: WidgetLayout) => void; editing: boolean; onEditing: (v: boolean) => void
  picker: boolean; onPicker: (v: boolean) => void; onRefresh: () => void; today: string; nowMin: number; online: boolean; loading: boolean; t: ReturnType<typeof useT>
}) {
  const avail = useMemo(() => available(snap), [snap])
  const list = shown(layout).filter((id) => avail[id])
  const offline = !online || snap.state === 'offline' || snap.cached
  const stamp = snap.fetchedAt ? formatTime(new Date(snap.fetchedAt)) : ''
  useEffect(() => {
    if (!editing || picker) return
    const k = (e: KeyboardEvent) => { if (e.key === 'Escape') onEditing(false) }
    window.addEventListener('keydown', k)
    return () => window.removeEventListener('keydown', k)
  }, [editing, picker, onEditing])
  const drop = (e: DragEvent, before: WidgetId) => { const id = e.dataTransfer.getData(DRAG) as WidgetId; if (id && WIDGETS.includes(id)) { e.preventDefault(); onLayout(place(layout, id, before)) } }
  return (
    <section aria-label={t('widgets.region')} className="ws-widgets absolute top-6 right-6 bottom-[68px] z-[5] flex w-[664px] max-w-[calc(100%-48px)] flex-col items-stretch gap-2 text-[#E8EEFA]">
      <div className="flex items-center justify-end gap-2 text-xs text-[#C9D6EE]">
        <span role="status" className="mr-auto rounded-full bg-[rgba(6,14,34,0.88)] px-2.5 py-1 empty:hidden">{offline && stamp ? t('widgets.offline', { time: stamp }) : ''}</span>
        {editing && <button type="button" onClick={() => onPicker(true)} className="cursor-pointer rounded-lg bg-[rgba(6,14,34,0.88)] px-3 py-1.5 hover:bg-[rgba(31,107,255,0.4)]">{t('widgets.add')}</button>}
        {editing && <button type="button" onClick={() => onEditing(false)} className="cursor-pointer rounded-lg bg-[#1F6BFF] px-3 py-1.5 font-semibold text-white">{t('widgets.done')}</button>}
        {!editing && <button type="button" aria-label={t('widgets.edit')} title={t('widgets.edit')} onClick={() => onEditing(true)}
          className="flex size-7 cursor-pointer items-center justify-center rounded-lg bg-[rgba(6,14,34,0.88)] hover:bg-[rgba(31,107,255,0.4)]"><Icon d={['M4 20h4L19 9l-4-4L4 16z', 'M13 7l4 4']} size={14} /></button>}
        <button type="button" aria-label={t('widgets.refresh')} title={stamp ? t('widgets.updated', { time: stamp }) : t('widgets.refresh')} onClick={onRefresh} disabled={loading}
          className="flex size-7 cursor-pointer items-center justify-center rounded-lg bg-[rgba(6,14,34,0.88)] hover:bg-[rgba(31,107,255,0.4)] disabled:opacity-60"><Icon d={['M20 11a8 8 0 1 0-2.3 5.7', 'M20 4v7h-7']} size={14} /></button>
      </div>
      <ul role="list" className="m-0 grid min-h-0 list-none auto-rows-min grid-cols-1 content-start gap-3 overflow-y-auto p-0 min-[1100px]:grid-cols-2" style={{ scrollbarGutter: 'stable' }}>
        {list.map((id, i) => (
          <li key={id} data-widget={id} className={sizeOf(layout, id) === 'wide' ? 'min-[1100px]:col-span-2' : ''}
            onDragOver={(e) => { if (editing && e.dataTransfer.types.includes(DRAG)) e.preventDefault() }} onDrop={(e) => drop(e, id)}>
            <Card id={id} t={t} editing={editing} first={i === 0} last={i === list.length - 1} layout={layout} onLayout={onLayout}>
              <Body id={id} snap={snap} today={today} nowMin={nowMin} t={t} />
            </Card>
          </li>
        ))}
      </ul>
      {picker && <Picker layout={layout} avail={avail} t={t} onAdd={(id) => onLayout(add(layout, id))} onClose={() => onPicker(false)} />}
    </section>
  )
}

function Card({ id, t, editing, first, last, layout, onLayout, children }: { id: WidgetId; t: ReturnType<typeof useT>; editing: boolean; first: boolean; last: boolean; layout: WidgetLayout; onLayout: (l: WidgetLayout) => void; children: ReactNode }) {
  const name = t(`widgets.name.${id}` as MessageKey)
  const wide = sizeOf(layout, id) === 'wide'
  const link = MODULE[id]
  const tool = 'flex size-7 cursor-pointer items-center justify-center rounded-md bg-white/[0.07] hover:bg-white/10 disabled:cursor-default disabled:opacity-40'
  return (
    <article aria-label={name} className={`flex h-full flex-col rounded-2xl border bg-[rgba(10,24,56,0.94)] shadow-[0_12px_30px_rgba(0,0,0,0.35)] ${editing ? 'border-[#1F6BFF]' : 'border-[rgba(127,178,255,0.2)]'}`}>
      <header className="flex items-center gap-2 px-4 pt-3.5 pb-2">
        {editing && (
          <span draggable role="img" aria-label={t('widgets.drag', { name })} title={t('widgets.drag', { name })} className="cursor-grab text-[#8FA3C8]"
            onDragStart={(e) => { e.dataTransfer.setData(DRAG, id); e.dataTransfer.effectAllowed = 'move' }}><Icon d={['M9 5h.01', 'M15 5h.01', 'M9 12h.01', 'M15 12h.01', 'M9 19h.01', 'M15 19h.01']} size={14} width={3} /></span>
        )}
        <Icon d={ICON[id]} size={15} className="shrink-0 text-[#18D4F0]" />
        <h2 className="m-0 min-w-0 flex-1 truncate text-sm font-semibold">{name}</h2>
        {editing ? (
          <span className="flex shrink-0 gap-1">
            <button type="button" aria-label={t('widgets.moveUp', { name })} title={t('widgets.moveUp', { name })} disabled={first} onClick={() => onLayout(move(layout, id, -1))} className={tool}><Icon d={['M12 19V5', 'M6 11l6-6 6 6']} size={13} /></button>
            <button type="button" aria-label={t('widgets.moveDown', { name })} title={t('widgets.moveDown', { name })} disabled={last} onClick={() => onLayout(move(layout, id, 1))} className={tool}><Icon d={['M12 5v14', 'M6 13l6 6 6-6']} size={13} /></button>
            <button type="button" aria-label={t(wide ? 'widgets.makeNormal' : 'widgets.makeWide', { name })} title={t(wide ? 'widgets.makeNormal' : 'widgets.makeWide', { name })} aria-pressed={wide}
              onClick={() => onLayout(resize(layout, id, wide ? 'normal' : 'wide'))} className={tool}><Icon d={wide ? ['M4 12h6', 'M14 12h6', 'M7 9l3 3-3 3', 'M17 9l-3 3 3 3'] : ['M4 12h16', 'M7 9l-3 3 3 3', 'M17 9l3 3-3 3']} size={13} /></button>
            <button type="button" aria-label={t('widgets.remove', { name })} title={t('widgets.remove', { name })} onClick={() => onLayout(remove(layout, id))} className={tool}><Icon d={P.close} size={13} /></button>
          </span>
        ) : link ? (
          <button type="button" aria-label={name} title={name} onClick={() => open(link)} className="flex size-6 shrink-0 cursor-pointer items-center justify-center rounded-md text-[#8FA3C8] hover:bg-white/10 hover:text-[#E8EEFA]"><Icon d={['M9 6l6 6-6 6']} size={14} /></button>
        ) : null}
      </header>
      <div className="min-h-0 flex-1 px-2 pb-3">{children}</div>
    </article>
  )
}

function Line({ children }: { children: ReactNode }) {
  return <p className="m-0 px-2 py-1.5 text-[13px] text-[#8FA3C8]">{children}</p>
}

function Row({ onClick, children, label }: { onClick?: () => void; children: ReactNode; label?: string }) {
  return (
    <li>
      <button type="button" disabled={!onClick} onClick={onClick} aria-label={label}
        className={`flex w-full min-w-0 items-center gap-2.5 rounded-[10px] px-2 py-1.5 text-left ${onClick ? 'cursor-pointer hover:bg-white/[0.07]' : 'cursor-default'}`}>{children}</button>
    </li>
  )
}

/** Each widget's own loading, error, offline and empty state, then its rows. */
function Body({ id, snap, today, nowMin, t }: { id: WidgetId; snap: WidgetsSnapshot; today: string; nowMin: number; t: ReturnType<typeof useT> }) {
  const sectionOf = { glance: snap.tasks, work: snap.tasks, calendar: snap.events, waiting: snap.approvals, announcements: snap.announcements, summary: snap.summary, activity: snap.dashboard, files: snap.dashboard }[id]
  if (id !== 'glance' && sectionOf.state !== 'ok') return <Line>{sectionOf.state === 'offline' ? t('widgets.offlineNone') : t('widgets.error')}</Line>
  const ul = 'm-0 flex list-none flex-col p-0'
  switch (id) {
    case 'glance': {
      const b = snap.tasks.data ? taskBuckets(snap.tasks.data, today) : null
      const ag = snap.events.data ? agendaOf(snap.events.data, today, nowMin) : null
      const d = snap.dashboard.data
      const tiles: { key: string; label: string; n: number | null; note?: string | null; tone?: string; link: string }[] = []
      if (snap.tasks.state !== 'unavailable') tiles.push({ key: 'due', label: t('widgets.glance.due'), n: b ? b.today.length : null, note: b?.overdue.length ? t('widgets.glance.overdue', { count: b.overdue.length }) : null, tone: 'text-[#FF8A7A]', link: 'worksuite://tasks' })
      if (snap.events.state !== 'unavailable') tiles.push({ key: 'meetings', label: t('widgets.glance.meetings'), n: ag ? ag.meetings : null, note: ag?.next ? (ag.next.live ? t('widgets.glance.onNow') : t('widgets.glance.next', { time: timeOf(ag.next.e.start) })) : null, link: 'worksuite://calendar' })
      if (snap.dashboard.state !== 'unavailable') {
        tiles.push({ key: 'mail', label: t('widgets.glance.mail'), n: d ? d.unreadMail : null, link: 'worksuite://mail' })
        tiles.push({ key: 'chat', label: t('widgets.glance.chat'), n: d ? d.unreadChat : null, link: 'worksuite://chat' })
      }
      return (
        <ul className="m-0 grid list-none grid-cols-2 gap-1.5 p-0">
          {tiles.map((x) => (
            <li key={x.key}>
              <button type="button" onClick={() => open(x.link)} className="flex w-full cursor-pointer flex-col items-start gap-0.5 rounded-xl bg-white/[0.05] px-3 py-2 text-left hover:bg-white/10">
                <span className="text-[11px] text-[#8FA3C8]">{x.label}</span>
                <span className="text-xl font-semibold tabular-nums">{x.n === null ? '—' : x.n > 99 && (x.key === 'mail' || x.key === 'chat') ? '99+' : compactCount(x.n)}</span>
                {x.note && <span className={`text-[11px] ${x.tone ?? 'text-[#C9D6EE]'}`}>{x.note}</span>}
              </button>
            </li>
          ))}
        </ul>
      )
    }
    case 'work': {
      const b = taskBuckets(snap.tasks.data ?? [], today)
      if (!b.today.length && !b.overdue.length) return <Line>{t('widgets.work.empty')}</Line>
      const rows = [...b.overdue.map((x) => ({ x, late: true })), ...b.today.map((x) => ({ x, late: false }))]
      return (
        <ul className={ul}>
          {rows.slice(0, 6).map(({ x, late }) => (
            <Row key={x.id} onClick={() => open(x.link)}>
              <span aria-hidden="true" className={`size-2 shrink-0 rounded-full ${late ? 'bg-[#D9452B]' : 'bg-[#1F6BFF]'}`} />
              <span className="min-w-0 flex-1 truncate text-[13px]">{x.title}</span>
              <span className={`shrink-0 text-[11px] ${late ? 'text-[#FF8A7A]' : 'text-[#8FA3C8]'}`}>{late ? t('widgets.work.overdue') : x.dueAt ? timeOf(x.dueAt) : t('widgets.work.today')}</span>
            </Row>
          ))}
          {rows.length > 6 && <Row onClick={() => open('worksuite://tasks')}><span className="text-[12px] text-[#7FB2FF]">{t('widgets.more', { count: rows.length - 6 })}</span></Row>}
        </ul>
      )
    }
    case 'calendar': {
      const ag = agendaOf(snap.events.data ?? [], today, nowMin)
      if (!ag.allDay.length && !ag.timed.length) return <Line>{t('widgets.cal.empty')}</Line>
      return (
        <ul className={ul}>
          {ag.allDay.slice(0, 2).map((e) => (
            <Row key={`a${e.id}`} onClick={() => open(e.link)}>
              <span className="w-12 shrink-0 text-[11px] text-[#8FA3C8]">{t('widgets.cal.allDay')}</span>
              <span className="min-w-0 flex-1 truncate text-[13px]">{e.title}</span>
            </Row>
          ))}
          {ag.timed.filter((r) => !r.past).slice(0, 5).map((r) => (
            <Row key={r.e.id} onClick={() => open(r.e.link)}>
              <span className={`w-12 shrink-0 text-[11px] ${r.live ? 'font-semibold text-[#5FD39A]' : 'text-[#8FA3C8]'}`}>{r.live ? t('widgets.cal.now') : timeOf(r.e.start)}</span>
              <span aria-hidden="true" className="h-6 w-[3px] shrink-0 rounded-full" style={{ background: r.e.color ?? '#1F6BFF' }} />
              <span className="flex min-w-0 flex-1 flex-col"><span className="truncate text-[13px]">{r.e.title}</span>{r.e.location && <span className="truncate text-[11px] text-[#8FA3C8]">{r.e.location}</span>}</span>
            </Row>
          ))}
          {ag.timed.length > 0 && ag.timed.every((r) => r.past) && !ag.allDay.length && <Line>{t('widgets.cal.empty')}</Line>}
        </ul>
      )
    }
    case 'waiting': {
      const a = snap.approvals.data
      if (!a || (!a.count && !a.items.length)) return <Line>{t('widgets.waiting.empty')}</Line>
      return (
        <ul className={ul}>
          {a.items.slice(0, 5).map((x) => (
            <Row key={`${x.kind}${x.id}`} onClick={() => open(x.link)}>
              <span aria-hidden="true" className="size-2 shrink-0 rounded-full bg-[#B7791F]" />
              <span className="flex min-w-0 flex-1 flex-col"><span className="truncate text-[13px]">{x.title}</span>{x.who && <span className="truncate text-[11px] text-[#8FA3C8]">{x.who}</span>}</span>
              <span className="shrink-0 text-[11px] text-[#8FA3C8]">{dayOrTime(x.at, today)}</span>
            </Row>
          ))}
          {a.count > Math.min(5, a.items.length) && <Row onClick={() => open('worksuite://hr')}><span className="text-[12px] text-[#7FB2FF]">{t('widgets.more', { count: a.count - Math.min(5, a.items.length) })}</span></Row>}
        </ul>
      )
    }
    case 'announcements': {
      const all = rankNotices(snap.announcements.data ?? [])
      if (!all.length) return <Line>{t('widgets.ann.empty')}</Line>
      const items = all.filter((a) => !a.read || a.pinned || a.priority === 'urgent')
      if (!items.length) return <Line>{t('widgets.ann.caughtUp')}</Line>
      return (
        <ul className={ul}>
          {items.slice(0, 3).map((a) => (
            <Row key={a.id} onClick={() => open(a.link)}>
              <span className="flex min-w-0 flex-1 flex-col gap-0.5">
                <span className="flex min-w-0 items-center gap-1.5">
                  {a.priority !== 'normal' && <span className={`shrink-0 rounded-full px-1.5 text-[10px] font-bold ${a.priority === 'urgent' ? 'bg-[rgba(217,69,43,0.25)] text-[#FF8A7A]' : 'bg-[rgba(183,121,31,0.25)] text-[#FFB98A]'}`}>{t(a.priority === 'urgent' ? 'widgets.ann.urgent' : 'widgets.ann.important')}</span>}
                  {a.pinned && <span className="shrink-0 text-[10px] text-[#8FA3C8]">{t('widgets.ann.pinned')}</span>}
                  <span className={`truncate text-[13px] ${a.read ? '' : 'font-semibold'}`}>{a.title}</span>
                </span>
                {a.preview && <span className="line-clamp-2 text-[11px] text-[#8FA3C8]">{a.preview}</span>}
              </span>
              {!a.read && <span className="shrink-0 rounded-full bg-[rgba(31,107,255,0.35)] px-1.5 text-[10px] font-semibold">{t('widgets.ann.new')}</span>}
            </Row>
          ))}
        </ul>
      )
    }
    case 'summary': {
      const s = snap.summary.data
      if (!s || (!s.text && !s.points.length)) return <Line>{t('widgets.summary.empty')}</Line>
      return (
        <div className="flex flex-col gap-1.5 px-2">
          {s.text && <p className="m-0 text-[13px] leading-relaxed text-[#C9D6EE]">{s.text}</p>}
          {s.points.length > 0 && (
            <ul className={ul}>
              {s.points.map((p, i) => (
                <Row key={i} onClick={p.link ? () => open(p.link!) : undefined}><span aria-hidden="true" className="size-1.5 shrink-0 rounded-full bg-[#18D4F0]" /><span className="min-w-0 flex-1 text-[12px]">{p.text}</span></Row>
              ))}
            </ul>
          )}
        </div>
      )
    }
    case 'activity': {
      const items = snap.dashboard.data?.activity ?? []
      if (!items.length) return <Line>{t('widgets.activity.empty')}</Line>
      return (
        <ul className={ul}>
          {items.slice(0, 5).map((a) => (
            <Row key={a.id} onClick={a.link ? () => open(a.link!) : undefined}>
              <span aria-hidden="true" className="flex size-7 shrink-0 items-center justify-center rounded-full bg-[linear-gradient(135deg,#1F6BFF,#18D4F0)] text-[10px] font-semibold text-white">{initials(a.user ?? 'WorkSuite')}</span>
              <span className="flex min-w-0 flex-1 flex-col">
                <span className="truncate text-[12px] text-[#C9D6EE]">{a.user && <b className="font-semibold text-[#E8EEFA]">{a.user} </b>}{a.text}{a.count > 1 && <span className="ml-1 text-[11px] text-[#8FA3C8]">×{compactCount(a.count)}</span>}</span>
                {a.module && <span className="truncate text-[11px] text-[#8FA3C8] capitalize">{a.module}</span>}
              </span>
              <span className="shrink-0 text-[11px] text-[#8FA3C8]">{dayOrTime(a.at, today)}</span>
            </Row>
          ))}
        </ul>
      )
    }
    case 'files': {
      const items = snap.dashboard.data?.files ?? []
      if (!items.length) return <Line>{t('widgets.files.empty')}</Line>
      return (
        <ul className={ul}>
          {items.slice(0, 5).map((f) => (
            <Row key={f.id} onClick={() => open(f.link)}>
              <span aria-hidden="true" className="flex size-7 shrink-0 items-center justify-center rounded-md font-mono text-[8px] font-bold text-white uppercase" style={{ background: EXT_COLOR[f.ext] ?? '#3D5280' }}>{f.ext.slice(0, 4) || '—'}</span>
              <span className="flex min-w-0 flex-1 flex-col">
                <span className="truncate text-[13px]">{f.name}</span>
                <span className="truncate text-[11px] text-[#8FA3C8]">{f.status === 'processing' ? t('widgets.files.processing') : f.status === 'failed' ? t('widgets.files.failed') : f.location ?? t('widgets.files.drive')}</span>
              </span>
              <span className="shrink-0 text-[11px] text-[#8FA3C8]">{dayOrTime(f.at, today)}</span>
            </Row>
          ))}
        </ul>
      )
    }
  }
}

function Picker({ layout, avail, t, onAdd, onClose }: { layout: WidgetLayout; avail: Record<WidgetId, boolean>; t: ReturnType<typeof useT>; onAdd: (id: WidgetId) => void; onClose: () => void }) {
  const ref = useRef<HTMLDivElement>(null)
  useEffect(() => {
    ref.current?.querySelector<HTMLElement>('button')?.focus()
    const k = (e: KeyboardEvent) => { if (e.key === 'Escape') { e.stopPropagation(); onClose() } }
    window.addEventListener('keydown', k, true)
    return () => window.removeEventListener('keydown', k, true)
  }, [onClose])
  const hidden = WIDGETS.filter((id) => layout.hidden.includes(id) && avail[id])
  return (
    <div ref={ref} role="dialog" aria-modal="true" aria-label={t('widgets.add')} className="absolute top-10 right-0 z-10 flex w-[340px] max-w-full flex-col gap-2 rounded-2xl border border-[rgba(127,178,255,0.2)] bg-[rgba(10,24,56,0.97)] p-3 shadow-[0_24px_60px_rgba(0,0,0,0.55)]">
      <div className="flex items-center gap-2 px-1">
        <h2 className="m-0 flex-1 text-sm font-semibold">{t('widgets.add')}</h2>
        <button type="button" aria-label={t('widgets.close')} onClick={onClose} className="flex size-7 cursor-pointer items-center justify-center rounded-md hover:bg-white/10"><Icon d={P.close} size={14} /></button>
      </div>
      <p className="m-0 px-1 text-[12px] text-[#8FA3C8]">{t('widgets.pickerHint')}</p>
      {hidden.length ? (
        <ul className="m-0 flex list-none flex-col gap-1 p-0">
          {hidden.map((id) => (
            <li key={id}>
              <button type="button" onClick={() => onAdd(id)} className="flex w-full cursor-pointer items-center gap-3 rounded-xl px-2 py-2 text-left hover:bg-white/[0.07]">
                <span aria-hidden="true" className="flex size-8 shrink-0 items-center justify-center rounded-lg bg-white/[0.07] text-[#18D4F0]"><Icon d={ICON[id]} size={16} /></span>
                <span className="flex min-w-0 flex-1 flex-col"><span className="text-[13px] font-semibold">{t(`widgets.name.${id}` as MessageKey)}</span><span className="text-[11px] text-[#8FA3C8]">{t(`widgets.desc.${id}` as MessageKey)}</span></span>
                <Icon d={['M12 5v14', 'M5 12h14']} size={14} />
              </button>
            </li>
          ))}
        </ul>
      ) : <p className="m-0 px-1 py-2 text-[13px] text-[#C9D6EE]">{t('widgets.pickerEmpty')}</p>}
    </div>
  )
}

function initials(name: string) {
  const w = name.split(/[\s._-]+/).filter(Boolean)
  return ((w[0]?.[0] ?? '') + (w[1]?.[0] ?? '')).toUpperCase() || '?'
}

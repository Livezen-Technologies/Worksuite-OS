// File operations (boards FO1–FO4): the progress window for every running copy, move, compress and extract job
// (pause, resume and cancel per job, live speed and time left, "Notify me when done"), the name-conflict dialog,
// the delete confirmation (Trash or permanently), and the toasts and error cards the jobs raise.
// Everything shown comes from the job events (electron/fileops.ts, electron/archives.ts); speed and time left are
// measured here from those events, never estimated from nothing.
import { useCallback, useEffect, useRef, useState } from 'react'
import { AnimatedProgress, CountUp } from '../../components/AnimatedProgress'
import { formatBytes, os, type FileEntry, type FileJob } from '../../lib/os'
import { formatDate, formatNumber, t, type MessageKey } from '../../i18n'
import { C, P, Svg, day, kindOf } from './parts'
import { archiveError } from './archive'

const btn = 'cursor-pointer disabled:cursor-default'
const ghost = `${btn} rounded-[10px] px-[18px] py-[11px] text-sm`
const line = '1px solid rgba(127,178,255,0.25)'
const SURFACE = { background: '#10244F', border: '1px solid rgba(127,178,255,0.2)', boxShadow: '0 30px 80px rgba(0,0,0,0.5)', color: C.text }

const ICON = {
  copy: 'M8 8h11v11H8zM5 16V5h11', move: 'M4 12h14M13 6l6 6-6 6', done: 'M5 12.5l4.5 4.5L19 7.5', warn: 'M12 3l10 18H2zM12 10v5M12 18h.01',
  pause: 'M7 5h4v14H7zM13 5h4v14h-4z', play: 'M7 5l12 7-12 7z', space: 'M3 6h18v12H3zM7 10h6', lock: 'M5 10h14v10H5zM8 10V7a4 4 0 0 1 8 0v3',
  error: 'M12 8v5M12 16h.01M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18z', minimize: 'M6 12h12',
}
const TINT = {
  blue: ['rgba(31,107,255,0.2)', C.link], cyan: ['rgba(24,212,240,0.16)', C.cyan], green: ['rgba(95,211,154,0.14)', '#5FD39A'],
  amber: ['rgba(255,159,90,0.16)', '#FFB98A'], red: ['rgba(255,138,122,0.16)', '#FF8A7A'],
} as const

const live = (j: FileJob) => j.state !== 'done' && j.state !== 'failed' && j.state !== 'cancelled'
const waiting = (j: FileJob) => j.state === 'conflict' || j.state === 'password' || j.state === 'confirm' || j.state === 'error'
const pctOf = (j: FileJob) => j.bytes_total ? Math.min(100, Math.round((j.bytes_done / j.bytes_total) * 100)) : j.total ? Math.round((j.done / j.total) * 100) : j.state === 'done' ? 100 : 0
const canPause = (j: FileJob) => (j.op === 'copy' || j.op === 'move') && (j.state === 'running' || j.state === 'paused')

/** Speed in bytes/s per job, measured from the bytes_done of successive events (smoothed). */
function useSpeeds(jobs: FileJob[]): Record<string, number> {
  const last = useRef<Record<string, { at: number; bytes: number; bps: number }>>({})
  const [out, setOut] = useState<Record<string, number>>({})
  useEffect(() => {
    const now = Date.now(), next: Record<string, number> = {}
    for (const j of jobs) {
      const prev = last.current[j.id]
      if (j.state !== 'running') { if (prev) last.current[j.id] = { ...prev, at: now, bytes: j.bytes_done }; continue }
      if (prev && now > prev.at && j.bytes_done >= prev.bytes) {
        const inst = ((j.bytes_done - prev.bytes) * 1000) / (now - prev.at)
        const bps = prev.bps ? prev.bps * 0.7 + inst * 0.3 : inst
        last.current[j.id] = { at: now, bytes: j.bytes_done, bps }
        if (bps > 0) next[j.id] = bps
      } else last.current[j.id] = { at: now, bytes: j.bytes_done, bps: 0 }
    }
    setOut(next)
  }, [jobs])
  return out
}

function timeLeft(j: FileJob, bps: number | undefined): string | null {
  if (!bps || !j.bytes_total || j.state !== 'running') return null
  const s = Math.max(1, Math.round((j.bytes_total - j.bytes_done) / bps))
  return s < 60 ? t('files.ops.secsLeft', { n: formatNumber(s) }) : t('files.ops.minsLeft', { n: formatNumber(Math.round(s / 60)) })
}

function titleOf(j: FileJob): string {
  if (j.op === 'compress') return t('files.job.compressing', { name: j.name ?? '' })
  if (j.op === 'extract') return t('files.job.extracting', { name: j.name ?? '', dest: j.dest })
  return t(j.op === 'move' ? 'files.ops.moving' : 'files.ops.copying', { count: formatNumber(j.total) })
}
function routeOf(j: FileJob): string {
  return j.src ? t('files.ops.route', { src: j.src, dest: j.dest }) : j.dest
}
function stateText(j: FileJob, bps: number | undefined): { text: string; color: string } {
  if (j.state === 'paused') return { text: t('files.job.paused'), color: '#FFB98A' }
  if (waiting(j)) return { text: t('files.ops.needsYou'), color: '#FFB98A' }
  if (j.state === 'done') return { text: t('files.job.done'), color: '#5FD39A' }
  if (j.state === 'cancelled') return { text: t('files.job.cancelled'), color: C.muted }
  if (j.state === 'failed') return { text: t('files.ops.failed'), color: '#FF8A7A' }
  return { text: timeLeft(j, bps) ?? t('files.ops.working'), color: C.soft }
}
function amounts(j: FileJob): string {
  if ((j.op === 'compress' || j.op === 'extract') && !j.total) return `${formatBytes(j.bytes_done)} / ${formatBytes(j.bytes_total || null)}`
  return t('files.ops.amounts', { bytes: formatBytes(j.bytes_done), bytesTotal: formatBytes(j.bytes_total), done: formatNumber(j.done), total: formatNumber(j.total) })
}

function IconTile({ d, tint, size = 36 }: { d: string; tint: readonly [string, string]; size?: number }) {
  return <span className="flex flex-none items-center justify-center rounded-[10px]" style={{ width: size, height: size, background: tint[0] }}><Svg d={d} size={size / 2} stroke={tint[1]} /></span>
}
function SquareBtn({ label, onClick, children }: { label: string; onClick: () => void; children: React.ReactNode }) {
  return <button type="button" aria-label={label} title={label} onClick={onClick} className={`${btn} flex size-8 flex-none items-center justify-center rounded-lg hover:bg-white/[0.06]`} style={{ border: '1px solid rgba(127,178,255,0.2)' }}>{children}</button>
}

function JobRow({ j, bps }: { j: FileJob; bps: number | undefined }) {
  const pct = pctOf(j)
  const st = stateText(j, bps)
  const kind = j.state === 'done' ? TINT.green : j.state === 'failed' ? TINT.red : j.op === 'move' ? TINT.cyan : TINT.blue
  const d = j.state === 'done' ? ICON.done : j.state === 'failed' ? ICON.error : j.op === 'move' ? ICON.move : j.op === 'compress' ? P.compress : j.op === 'extract' ? P.download : ICON.copy
  const unknown = (j.op === 'compress' || j.op === 'extract') && !j.total && !j.bytes_total
  return (
    <div className="flex flex-col gap-2.5 px-5 py-4" style={{ borderBottom: '1px solid rgba(127,178,255,0.08)' }}>
      <div className="flex items-center gap-3">
        <IconTile d={d} tint={kind} />
        <span className="flex min-w-0 flex-1 flex-col gap-0.5">
          <span className="truncate text-sm font-semibold" title={titleOf(j)}>{titleOf(j)}</span>
          <span className="truncate text-xs" style={{ color: C.muted }} title={routeOf(j)}>{routeOf(j)}</span>
        </span>
        {canPause(j) && (
          <SquareBtn label={j.state === 'paused' ? t('files.ops.resume') : t('files.ops.pause')} onClick={() => void os.filesResolve(j.id, j.state === 'paused' ? 'resume' : 'pause', false)}>
            <Svg d={j.state === 'paused' ? ICON.play : ICON.pause} size={14} fill={C.soft} />
          </SquareBtn>
        )}
        {live(j) && <SquareBtn label={t('files.job.cancel')} onClick={() => void os.filesResolve(j.id, 'cancel', false)}><Svg d={P.close} size={14} stroke={C.soft} width={2.4} /></SquareBtn>}
      </div>
      <AnimatedProgress value={unknown ? null : pct} label={titleOf(j)} height={6}
        tone={j.state === 'paused' || waiting(j) ? 'paused' : j.state === 'failed' ? 'error' : j.state === 'done' ? 'success' : 'default'} />
      <div className="flex justify-between gap-3 font-mono text-xs" style={{ color: C.muted }}>
        <span className="truncate">{amounts(j)}</span><span className="shrink-0" style={{ color: st.color }}>{st.text}</span>
      </div>
    </div>
  )
}

/** FO1: the progress window, centred over Files. Minimize keeps the jobs running in the small card. */
export function JobsWindow({ jobs, notify, setNotify, onMinimize }: { jobs: FileJob[]; notify: boolean; setNotify: (v: boolean) => void; onMinimize: () => void }) {
  const speeds = useSpeeds(jobs)
  const [detail, setDetail] = useState(true)
  const active = jobs.filter(live)
  const total = jobs.reduce((a, j) => a + (j.bytes_total || 0), 0), done = jobs.reduce((a, j) => a + (j.bytes_done || 0), 0)
  const overall = total ? Math.round((done / total) * 100) : null
  const now = active.find((j) => j.state === 'running' && j.current) ?? active.find((j) => j.current)
  const bps = now ? speeds[now.id] : undefined
  const ref = useRef<HTMLElement>(null)
  useEffect(() => { ref.current?.focus() }, [])
  return (
    <div className="fixed inset-0 z-[65] flex items-center justify-center" style={{ background: 'rgba(3,8,22,0.55)' }}>
      <section ref={ref} tabIndex={-1} role="dialog" aria-modal="false" aria-label={t('files.ops.window')} onKeyDown={(e) => { if (e.key === 'Escape') { e.stopPropagation(); onMinimize() } }}
        className="box-border w-[620px] max-w-[calc(100vw-32px)] overflow-hidden rounded-2xl outline-none" style={SURFACE}>
        <header className="flex items-center gap-3 px-5 py-4" style={{ borderBottom: `1px solid ${C.line}` }}>
          <span className="flex-1 text-[15px] font-semibold">{active.length ? t('files.ops.headline', { count: formatNumber(active.length) }) : t('files.ops.allDone')}</span>
          {overall != null && <span className="font-mono text-xs" style={{ color: C.muted }}>{t('files.ops.overall', { pct: formatNumber(overall) })}</span>}
          <button type="button" aria-label={t('files.ops.minimize')} title={t('files.ops.minimize')} onClick={onMinimize} className={`${btn} flex size-7 items-center justify-center rounded-lg hover:bg-white/10`}><Svg d={ICON.minimize} size={14} stroke={C.muted} /></button>
        </header>
        <div className="flex max-h-[420px] flex-col overflow-auto">{jobs.map((j) => <JobRow key={j.id} j={j} bps={speeds[j.id]} />)}</div>
        {detail && now && (
          <dl className="m-0 grid grid-cols-[110px_minmax(0,1fr)] gap-x-3 gap-y-1.5 px-5 py-3.5 text-xs" style={{ background: 'var(--ws-g-field)' }}>
            <dt style={{ color: C.muted }}>{now.op === 'move' ? t('files.ops.nowMoving') : t('files.ops.nowCopying')}</dt><dd className="m-0 truncate font-mono">{now.current}</dd>
            <dt style={{ color: C.muted }}>{t('files.ops.speed')}</dt><dd className="m-0 font-mono">{bps ? t('files.ops.perSec', { size: formatBytes(bps) }) : now.state === 'paused' ? t('files.job.paused') : t('files.ops.measuring')}</dd>
            <dt style={{ color: C.muted }}>{t('files.ops.destination')}</dt><dd className="m-0 truncate">{now.free != null ? t('files.ops.destFree', { dest: now.dest, free: formatBytes(now.free) }) : now.dest}</dd>
          </dl>
        )}
        <footer className="flex items-center justify-between px-5 py-3">
          <button type="button" onClick={() => setDetail(!detail)} className={`${btn} text-[13px]`} style={{ color: C.link }} aria-expanded={detail}>{detail ? t('files.ops.hideDetails') : t('files.ops.showDetails')}</button>
          <label className="flex items-center gap-2 text-xs" style={{ color: C.muted }}>
            <input type="checkbox" checked={notify} onChange={(e) => setNotify(e.target.checked)} className="size-4" style={{ accentColor: C.blue }} />{t('files.ops.notify')}
          </label>
        </footer>
      </section>
    </div>
  )
}

/** The minimized window: one card at the bottom right with the overall progress; click to open the window again. */
export function JobsChip({ jobs, onOpen }: { jobs: FileJob[]; onOpen: () => void }) {
  const active = jobs.filter(live)
  const total = jobs.reduce((a, j) => a + (j.bytes_total || 0), 0), done = jobs.reduce((a, j) => a + (j.bytes_done || 0), 0)
  const pct = total ? Math.round((done / total) * 100) : null
  const need = jobs.some(waiting), paused = active.length > 0 && active.every((j) => j.state === 'paused')
  const label = active.length ? t('files.ops.headline', { count: formatNumber(active.length) }) : t('files.ops.allDone')
  return (
    <button type="button" onClick={onOpen} aria-label={t('files.ops.open', { what: label })}
      className={`${btn} absolute right-4 bottom-11 z-40 box-border flex w-[320px] flex-col gap-2 rounded-[14px] px-4 py-3 text-left`} style={{ background: 'var(--ws-g-menu)', border: '1px solid rgba(127,178,255,0.22)', boxShadow: '0 16px 40px rgba(0,0,0,0.5)', color: C.text }}>
      <span className="flex justify-between gap-2 text-[13px]">
        <span className="truncate font-semibold">{label}</span>
        <span className="shrink-0" style={{ color: need || paused ? '#FFB98A' : C.muted }}>{need ? t('files.ops.needsYou') : paused ? t('files.job.paused') : pct != null ? <CountUp value={pct} /> : null}</span>
      </span>
      <AnimatedProgress value={pct} label={label} height={5} tone={need || paused ? 'paused' : active.length ? 'default' : 'success'} />
    </button>
  )
}

/** Keeps the job list: newest events win, finished jobs stay until every job is finished, then clear after a moment. */
export function useFileJobs(onFinished: (j: FileJob) => void) {
  const [jobs, setJobs] = useState<FileJob[]>([])
  const fin = useRef(onFinished)
  fin.current = onFinished
  useEffect(() => os.onFilesJob((e) => {
    setJobs((list) => {
      const i = list.findIndex((j) => j.id === e.id)
      const prev = i >= 0 ? list[i] : null
      if (!live(e) && (!prev || live(prev))) queueMicrotask(() => fin.current(e))
      return i >= 0 ? list.map((j, k) => (k === i ? e : j)) : [...list, e]
    })
  }), [])
  const allDone = jobs.length > 0 && !jobs.some(live)
  useEffect(() => { if (allDone) { const id = setTimeout(() => setJobs((l) => (l.some(live) ? l : [])), 2500); return () => clearTimeout(id) } }, [allDone])
  const clear = useCallback(() => setJobs((l) => l.filter(live)), [])
  return { jobs, clear }
}

// ---- FO2: name conflict ----
const stampWhen = (ms: number) => t('files.ops.edited', { when: `${day(ms)}, ${formatDate(ms, { hour: '2-digit', minute: '2-digit' })}` })
function keepBothName(name: string): string {
  const dot = name.lastIndexOf('.')
  return dot > 0 ? `${name.slice(0, dot)} (2)${name.slice(dot)}` : `${name} (2)`
}

export function ConflictDialog({ job }: { job: FileJob }) {
  const c = job.conflict!
  type Act = 'keep' | 'replace' | 'skip'
  const [act, setAct] = useState<Act>('keep')
  const [all, setAll] = useState(false)
  const newer = c.incoming.modified > c.existing.modified
  const diff = c.incoming.size - c.existing.size
  const count = c.count ?? c.remaining + 1
  const send = (r: Act | 'cancel') => void os.filesResolve(job.id, r, all)
  const k = kindOf(c.name, false)
  const fromLabel = job.op === 'extract' ? t('files.cf.fromArchive') : job.op === 'compress' ? t('files.cf.newArchive') : t('files.ops.incoming')
  const note = newer ? (diff > 0 ? t('files.ops.newerLarger', { size: formatBytes(diff) }) : diff < 0 ? t('files.ops.newerSmaller', { size: formatBytes(-diff) }) : t('files.ops.newer')) : ''
  const sides = [
    { id: 'existing', label: t('files.ops.existing'), s: c.existing, on: act === 'skip', pick: () => setAct('skip'), note: '' },
    { id: 'incoming', label: fromLabel, s: c.incoming, on: act === 'replace', pick: () => setAct('replace'), note },
  ]
  const acts: { id: Act; name: string; hint: string }[] = [
    { id: 'keep', name: t('files.cf.keep'), hint: keepBothName(c.name) },
    { id: 'replace', name: t('files.cf.replace'), hint: t('files.ops.replaceHint') },
    { id: 'skip', name: t('files.cf.skip'), hint: t('files.ops.skipHint') },
  ]
  const cta = { keep: all ? 'files.ops.keepAll' : 'files.cf.keep', replace: all ? 'files.ops.replaceAll' : 'files.cf.replace', skip: all ? 'files.ops.skipAll' : 'files.cf.skip' }[act] as MessageKey
  const sub = job.op === 'copy' || job.op === 'move'
    ? t(job.op === 'move' ? 'files.ops.cfMoving' : 'files.ops.cfCopying', { dest: job.dest, i: formatNumber(c.index ?? 1), n: formatNumber(count) })
    : t('files.cf.body', { dest: job.dest })
  return (
    <div className="fixed inset-0 z-[70] flex items-center justify-center" style={{ background: 'rgba(3,8,22,0.55)' }}>
      <section role="alertdialog" aria-modal="true" aria-labelledby="cf-t" aria-describedby="cf-s" className="box-border flex w-[640px] max-w-[calc(100vw-32px)] flex-col gap-[18px] rounded-2xl px-7 py-[26px]" style={SURFACE}>
        <div className="flex items-start gap-3.5">
          <IconTile d={ICON.warn} tint={TINT.amber} size={42} />
          <div className="flex min-w-0 flex-col gap-1">
            <h2 id="cf-t" className="m-0 text-lg font-bold break-words">{t('files.cf.title', { name: c.name })}</h2>
            <span id="cf-s" className="text-[13px]" style={{ color: C.muted }}>{sub}</span>
          </div>
        </div>
        <div className="grid grid-cols-2 gap-3">
          {sides.map((x) => (
            <button key={x.id} type="button" aria-pressed={x.on} onClick={x.pick} className={`${btn} flex gap-3 rounded-xl p-3.5 text-left`}
              style={{ border: `1px solid ${x.on ? C.blue : 'var(--ws-g-line)'}`, background: x.on ? 'rgba(31,107,255,0.12)' : 'rgba(4,10,26,0.3)' }}>
              <span className="box-border flex h-[54px] w-11 flex-none items-end justify-center rounded-md pb-1.5 text-[10px] font-bold" style={{ background: '#E8EEFA', color: k.color }}>{k.ext}</span>
              <span className="flex min-w-0 flex-col gap-[3px] text-xs" style={{ color: C.soft }}>
                <span className="truncate text-[11px] tracking-[0.06em] uppercase" style={{ color: C.muted }}>{x.label}</span>
                <span className="text-sm font-semibold" style={{ color: C.text }}>{formatBytes(x.s.size)}</span>
                <span>{stampWhen(x.s.modified)}</span>
                {x.note && <span style={{ color: '#5FD39A' }}>{x.note}</span>}
              </span>
            </button>
          ))}
        </div>
        <div role="radiogroup" aria-label={t('files.ops.whatToDo')} className="flex flex-col gap-2">
          {acts.map((a) => {
            const on = a.id === act
            return (
              <button key={a.id} type="button" role="radio" aria-checked={on} onClick={() => setAct(a.id)} className={`${btn} flex items-center gap-3 rounded-[10px] px-3.5 py-[11px] text-left`}
                style={{ border: `1px solid ${on ? C.blue : 'var(--ws-g-line)'}`, background: on ? 'rgba(31,107,255,0.12)' : 'transparent' }}>
                <span className="box-border flex size-4 items-center justify-center rounded-full" style={{ border: `2px solid ${on ? C.blue : 'rgba(127,178,255,0.35)'}` }}><span className="size-1.5 rounded-full" style={{ background: on ? C.blue : 'transparent' }} /></span>
                <span className="flex-1 text-sm">{a.name}</span>
                <span className="max-w-[260px] truncate font-mono text-xs" style={{ color: C.muted }}>{a.hint}</span>
              </button>
            )
          })}
        </div>
        <div className="flex items-center gap-3 pt-1.5">
          <label className="flex flex-1 items-center gap-2 text-[13px]" style={{ color: C.soft }}>
            {count > 1 && <><input type="checkbox" checked={all} onChange={(e) => setAll(e.target.checked)} className="size-4" style={{ accentColor: C.blue }} />{t('files.ops.forAll', { count: formatNumber(count) })}</>}
          </label>
          <button type="button" onClick={() => send('cancel')} className={ghost} style={{ border: line }}>{job.op === 'copy' ? t('files.cf.cancel') : job.op === 'move' ? t('files.ops.cancelMove') : t('files.cf.cancelJob')}</button>
          <button type="button" autoFocus onClick={() => send(act)} className={`${btn} rounded-[10px] px-6 py-[11px] text-sm font-semibold`} style={{ background: C.blue }}>{t(cta)}</button>
        </div>
      </section>
    </div>
  )
}

// ---- FO3: delete confirmation ----
export function DeleteDialog({ items, permanent: startPermanent, canTrash, onCancel, onConfirm }: {
  items: FileEntry[]; permanent: boolean; canTrash: boolean; onCancel: () => void; onConfirm: (permanent: boolean) => void
}) {
  const [perm, setPerm] = useState(startPermanent || !canTrash)
  const n = items.length
  const bytes = items.every((e) => !e.dir && e.size != null) ? items.reduce((a, e) => a + (e.size ?? 0), 0) : null
  const shown = items.slice(0, 3)
  const tint = perm ? TINT.red : TINT.blue
  const one = n === 1 ? items[0].name : null
  const title = perm ? (one ? t('files.del.permOne', { name: one }) : t('files.del.permMany', { count: formatNumber(n) }))
    : (one ? t('files.del.trashOne', { name: one }) : t('files.del.trashMany', { count: formatNumber(n) }))
  const body = perm ? (bytes != null ? t('files.del.permBodySize', { size: formatBytes(bytes) }) : t('files.del.permBody')) : t('files.del.trashBody')
  return (
    <div className="fixed inset-0 z-[70] flex items-center justify-center" style={{ background: 'rgba(3,8,22,0.55)' }}>
      <section role="alertdialog" aria-modal="true" aria-labelledby="del-t" aria-describedby="del-b" onKeyDown={(e) => { if (e.key === 'Escape') onCancel() }}
        className="box-border flex w-[520px] max-w-[calc(100vw-32px)] flex-col gap-[18px] rounded-2xl px-7 py-[26px]" style={SURFACE}>
        <div className="flex items-start gap-3.5">
          <IconTile d={P.trash} tint={tint} size={42} />
          <div className="flex min-w-0 flex-col gap-1">
            <h2 id="del-t" className="m-0 text-lg font-bold break-words">{title}</h2>
            <span id="del-b" className="text-[13px] leading-normal" style={{ color: C.soft }}>{body}</span>
          </div>
        </div>
        <ul aria-label={t('files.del.items')} className="m-0 flex list-none flex-col gap-1.5 rounded-xl px-3.5 py-3 text-[13px]" style={{ background: 'var(--ws-g-field)' }}>
          {shown.map((e) => {
            const k = kindOf(e.name, e.dir)
            return (
              <li key={e.name} className="flex items-center justify-between gap-3">
                <span className="flex min-w-0 items-center gap-2"><Svg d={e.dir ? P.folder : P.open} size={14} stroke={e.dir ? C.link : k.color} /><span className="truncate">{e.name}</span></span>
                <span className="shrink-0 font-mono" style={{ color: C.muted }}>{e.dir ? (e.items != null ? t('files.del.folderItems', { count: formatNumber(e.items) }) : t('files.folder')) : formatBytes(e.size)}</span>
              </li>
            )
          })}
          {shown.length < n && <li style={{ color: C.muted }}>{t('files.del.more', { count: formatNumber(n - shown.length) })}</li>}
        </ul>
        {canTrash && (
          <div role="radiogroup" aria-label={t('files.del.mode')} className="flex rounded-[10px] p-[3px]" style={{ background: 'var(--ws-g-field)' }}>
            {[false, true].map((v) => (
              <button key={String(v)} type="button" role="radio" aria-checked={v === perm} onClick={() => setPerm(v)} className={`${btn} flex-1 rounded-lg p-2 text-center text-[13px]`}
                style={{ background: v === perm ? (v ? 'rgba(229,72,77,0.35)' : C.blue) : 'transparent' }}>{v ? t('files.del.modePerm') : t('files.moveToTrash')}</button>
            ))}
          </div>
        )}
        <div className="flex justify-end gap-2.5">
          <button type="button" autoFocus onClick={onCancel} className={ghost} style={{ border: line }}>{t('common.cancel')}</button>
          <button type="button" onClick={() => onConfirm(perm)} className={`${btn} rounded-[10px] px-[22px] py-[11px] text-sm font-semibold text-white`} style={{ background: perm ? '#E5484D' : C.blue }}>{perm ? t('files.del.permCta') : t('files.moveToTrash')}</button>
        </div>
      </section>
    </div>
  )
}

// ---- FO4: toasts and error cards ----
export type ToastKind = 'ok' | 'move' | 'trash' | 'paused' | 'error'
export interface Toast { id: number; kind: ToastKind; text: string; action?: { label: string; run: () => void } }

const TOAST_LOOK: Record<ToastKind, [readonly [string, string], string]> = {
  ok: [TINT.green, ICON.done], move: [TINT.green, ICON.move], trash: [TINT.blue, P.trash], paused: [TINT.amber, ICON.pause], error: [TINT.red, ICON.error],
}

/** Bottom-centre toasts; each goes after 6 s (one with an action such as Undo after 12 s: on a slow machine the pointer
 *  often got there just as it went) unless the pointer is on it. */
export function Toasts({ toasts, dismiss }: { toasts: Toast[]; dismiss: (id: number) => void }) {
  if (!toasts.length) return null
  return (
    <div className="pointer-events-none absolute bottom-11 left-1/2 z-[45] flex w-[460px] max-w-[calc(100%-32px)] -translate-x-1/2 flex-col gap-2">
      {toasts.map((x) => <ToastCard key={x.id} toast={x} dismiss={dismiss} />)}
    </div>
  )
}
function ToastCard({ toast, dismiss }: { toast: Toast; dismiss: (id: number) => void }) {
  const [hold, setHold] = useState(false)
  useEffect(() => { if (hold) return; const id = setTimeout(() => dismiss(toast.id), toast.action ? 12_000 : 6000); return () => clearTimeout(id) }, [hold, toast.id, toast.action, dismiss])
  const [tint, d] = TOAST_LOOK[toast.kind]
  return (
    <div role="status" onMouseEnter={() => setHold(true)} onMouseLeave={() => setHold(false)} className="pointer-events-auto flex items-center gap-3 rounded-[14px] py-3 pr-3.5 pl-4"
      style={{ background: 'rgba(16,36,79,0.96)', border: '1px solid rgba(127,178,255,0.18)', boxShadow: '0 14px 40px rgba(0,0,0,0.4)', color: C.text }}>
      <span className="flex size-[30px] flex-none items-center justify-center rounded-full" style={{ background: tint[0] }}><Svg d={d} size={15} stroke={tint[1]} width={2.6} /></span>
      <span className="min-w-0 flex-1 text-sm break-words">{toast.text}</span>
      {toast.action && <button type="button" onClick={() => { toast.action!.run(); dismiss(toast.id) }} className={`${btn} rounded-lg px-3 py-[7px] text-[13px] font-semibold hover:bg-white/[0.06]`} style={{ color: C.link }}>{toast.action.label}</button>}
      <button type="button" aria-label={t('common.dismiss')} onClick={() => dismiss(toast.id)} className={`${btn} flex size-7 items-center justify-center rounded-lg hover:bg-white/10`}><Svg d={P.close} size={12} stroke={C.muted} /></button>
    </div>
  )
}

const ERR: Record<string, { title: MessageKey; body: MessageKey; d: string; red?: boolean }> = {
  no_space: { title: 'files.err.spaceTitle', body: 'files.err.spaceBody', d: ICON.space },
  permission: { title: 'files.err.permTitle', body: 'files.err.permBody', d: ICON.lock },
  io: { title: 'files.err.ioTitle', body: 'files.err.ioBody', d: ICON.error, red: true },
  busy: { title: 'files.err.busyTitle', body: 'files.err.busyBody', d: ICON.copy },
  missing: { title: 'files.err.goneTitle', body: 'files.err.goneBody', d: ICON.error, red: true },
  failed: { title: 'files.err.failTitle', body: 'files.err.failBody', d: ICON.error, red: true },
}

/** A job stopped on an error (state 'error'): explain it and offer Retry / Skip / Cancel. */
export function JobErrorCard({ job }: { job: FileJob }) {
  const e = ERR[job.error ?? 'failed'] ?? ERR.failed
  const tint = e.red ? TINT.red : TINT.amber
  const vars = { name: job.error_name ?? '', dest: job.dest, need: formatBytes(job.bytes_total - job.bytes_done), free: formatBytes(job.free ?? null) }
  const send = (r: 'retry' | 'skip' | 'cancel') => void os.filesResolve(job.id, r, false)
  const fileLevel = job.error !== 'no_space'
  return (
    <div className="fixed inset-0 z-[70] flex items-center justify-center" style={{ background: 'rgba(3,8,22,0.45)' }}>
      <section role="alertdialog" aria-modal="true" aria-labelledby="fe-t" aria-describedby="fe-b" className="box-border flex w-[520px] max-w-[calc(100vw-32px)] flex-col gap-3 rounded-2xl px-5 py-[18px]"
        style={{ ...SURFACE, border: `1px solid ${e.red ? 'rgba(255,138,122,0.4)' : 'rgba(255,159,90,0.4)'}` }}>
        <div className="flex items-start gap-3">
          <IconTile d={e.d} tint={tint} />
          <span className="flex min-w-0 flex-col gap-[3px]">
            <span id="fe-t" className="text-[15px] font-semibold break-words">{t(e.title, vars)}</span>
            <span id="fe-b" className="text-[13px] leading-[1.45] break-words" style={{ color: C.soft }}>{t(e.body, vars)}</span>
          </span>
        </div>
        <div className="flex justify-end gap-2">
          <button type="button" onClick={() => send('cancel')} className={`${btn} rounded-lg px-3.5 py-2 text-[13px]`} style={{ color: C.soft }}>{t(job.op === 'move' ? 'files.ops.cancelMove' : 'files.cf.cancel')}</button>
          {fileLevel && <button type="button" onClick={() => send('skip')} className={`${btn} rounded-lg px-3.5 py-2 text-[13px]`} style={{ border: line }}>{t('files.cf.skip')}</button>}
          <button type="button" autoFocus onClick={() => send('retry')} className={`${btn} rounded-lg px-4 py-2 text-[13px] font-semibold`} style={{ background: e.red ? '#E5484D' : C.blue }}>{t('files.err.retry')}</button>
        </div>
      </section>
    </div>
  )
}

/** Text for a finished job's toast, or null when nothing needs saying. */
export function finishedToast(j: FileJob): Pick<Toast, 'kind' | 'text'> | null {
  if (j.state === 'cancelled') return null
  if (j.state === 'failed') return { kind: 'error', text: j.op === 'compress' || j.op === 'extract' ? archiveError(j.error) : t('files.job.failed') }
  if (j.op === 'compress') return { kind: 'ok', text: t('files.ops.toastCompressed', { name: j.name ?? '' }) }
  if (j.op === 'extract') return { kind: 'ok', text: t('files.ops.toastExtracted', { name: j.name ?? '', dest: j.dest }) }
  const key = j.op === 'move' ? (j.done === 1 ? 'files.ops.toastMovedOne' : 'files.ops.toastMoved') : (j.done === 1 ? 'files.ops.toastCopiedOne' : 'files.ops.toastCopied')
  return { kind: j.op === 'move' ? 'move' : 'ok', text: t(key, { count: formatNumber(j.done), dest: j.dest }) }
}

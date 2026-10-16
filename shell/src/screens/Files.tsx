// Files (§7.2, boards FMSide and FM1–FM6): real folders through the Electron bridge, WorkSuite Drive with sync states
// from the sync service, Recent (recently-used.xbel), Starred, freedesktop.org Trash, search, copy/move jobs, and
// archives: Compress…, Extract here / to a folder, and Open archive (read-only browsing, files/archive.tsx).
// File operations (FO1–FO4: progress window, conflicts, delete confirmation, toasts and errors) are in files/ops.tsx.
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { WindowProps } from './types'
import { formatBytes, os, type FileEntry, type FileHit, type FileJob, type FilePlaces, type TrashItem } from '../lib/os'
import { formatDate, formatDecimal, formatNumber, messages, t } from '../i18n'
import { C, FilesSide, Modal, P, Svg, day, folderColor, folderLabel, kindOf, sizeOf, thumbBg, type Place } from './files/parts'
import { ArchiveView, CompressDialog, LargeDialog, PasswordDialog, archiveError, archiveKind, stemOf } from './files/archive'
import { ConflictDialog, DeleteDialog, JobErrorCard, JobsChip, JobsWindow, Toasts, finishedToast, useFileJobs, type Toast } from './files/ops'

const SYNC_LABEL = messages({ synced: 'files.sync.synced', syncing: 'files.sync.syncing', pending: 'files.sync.pending', conflict: 'files.sync.conflict', 'online-only': 'files.sync.online', error: 'files.sync.error', unknown: 'files.sync.unknown' })
const SYNC_DOT: Record<string, string> = { synced: '#4ADE80', syncing: C.link, pending: C.muted, conflict: '#FFB98A', 'online-only': '#C4B5FD', error: '#FF8A7A', unknown: C.dim }
const DRIVE_META = messages({ idle: 'files.drive.synced', syncing: 'files.drive.syncing', offline: 'files.drive.offline', off: 'files.drive.off' })

type Clip = { op: 'copy' | 'move'; root: string; rels: string[] }
type Menu = { x: number; y: number; name: string | null }
type Ask = { kind: 'mkdir' } | { kind: 'rename'; name: string } | { kind: 'empty' } | { kind: 'delete'; names: string[]; permanent: boolean } | null

const btn = 'cursor-pointer disabled:cursor-default'
const iconBtn = `${btn} flex h-[34px] w-[34px] items-center justify-center rounded-lg hover:bg-white/10 disabled:opacity-40 disabled:hover:bg-transparent`

/** archive: an archive opened with Files from elsewhere (the default handler for archive types); n changes per request. */
export default function Files({ onClose, archive }: WindowProps & { archive?: { root: string; rel: string; n: number } | null }) {
  const [places, setPlaces] = useState<FilePlaces | null>(null)
  const [hist, setHist] = useState<{ list: Place[]; i: number }>({ list: [{ kind: 'dir', root: 'home', rel: 'Documents' }], i: 0 })
  const place = hist.list[hist.i]
  const [view, setView] = useState<'grid' | 'list'>('grid')
  const [entries, setEntries] = useState<FileEntry[] | null>(null)
  const [hits, setHits] = useState<FileHit[] | null>(null)
  const [trashItems, setTrashItems] = useState<TrashItem[] | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [status, setStatus] = useState<Awaited<ReturnType<typeof os.filesStatus>> | null>(null)
  const [driveState, setDriveState] = useState<string | null>(null)
  const [stars, setStars] = useState<string[]>([])
  const [sel, setSel] = useState<string[]>([])
  const [menu, setMenu] = useState<Menu | null>(null)
  const [clip, setClip] = useState<Clip | null>(null)
  const [ask, setAsk] = useState<Ask>(null)
  const [notice, setNotice] = useState<string | null>(null)
  const [toasts, setToasts] = useState<Toast[]>([])
  const toastSeq = useRef(0)
  const toast = useCallback((x: Omit<Toast, 'id'>) => setToasts((l) => [...l.slice(-2), { ...x, id: ++toastSeq.current }]), [])
  const dropToast = useCallback((id: number) => setToasts((l) => l.filter((x) => x.id !== id)), [])
  // Where each copy/move job writes, so its toast can open that folder.
  const jobDest = useRef<Record<string, Place>>({})
  const [jobsOpen, setJobsOpen] = useState(true)
  const [notifyDone, setNotifyDone] = useState(false)
  const [search, setSearch] = useState<{ q: string; kind: string; days: number } | null>(null)
  const [found, setFound] = useState<{ hits: FileHit[]; ms: number; truncated: boolean } | null>(null)
  const [tick, setTick] = useState(0)
  const [winApp, setWinApp] = useState<string | null>(null)
  const [readOnly, setReadOnly] = useState<string | null>(null)
  const [compressing, setCompressing] = useState<string[] | null>(null)
  // The password of the archive being browsed; kept only while it is open, for extracting from it.
  const [arcPw, setArcPw] = useState<string | null>(null)
  const reload = useCallback(() => setTick((n) => n + 1), [])

  const go = (p: Place) => { setHist((h) => ({ list: [...h.list.slice(0, h.i + 1), p], i: h.i + 1 })); setSel([]); setSearch(null); setMenu(null) }
  const dir = place.kind === 'dir' ? place : null
  const arc = place.kind === 'archive' ? place : null
  useEffect(() => { if (archive) go({ kind: 'archive', root: archive.root, rel: archive.rel, inner: '' }) }, [archive?.n]) // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => { if (!arc) setArcPw(null) }, [arc?.root, arc?.rel]) // eslint-disable-line react-hooks/exhaustive-deps
  const cloud = dir?.root === 'drive'

  useEffect(() => { void os.filesPlaces().then(setPlaces); void os.filesStatus('drive').then((s) => setDriveState(s.drive ? s.drive.service_state : 'off')) }, [tick])
  useEffect(() => { void os.filesStarred().then((s) => setStars(s.keys)) }, [tick])
  const { jobs } = useFileJobs((e) => {
    reload()
    const msg = finishedToast(e)
    if (!msg) return
    const to = jobDest.current[e.id]
    toast({ ...msg, action: to && e.state === 'done' ? { label: t('files.ops.openFolder'), run: () => go(to) } : undefined })
    if (notifyDone && e.state !== 'failed' && !document.hasFocus()) void os.filesNotify(msg.text, '')
  })
  const job = jobs.find((j) => j.state === 'conflict' || j.state === 'password' || j.state === 'confirm' || j.state === 'error') ?? null
  const started = (r: { ok: boolean; value?: unknown }, to: Place) => { if (r.ok && typeof r.value === 'string') { jobDest.current[r.value] = to; setJobsOpen(true) } }

  useEffect(() => {
    setError(null)
    if (place.kind === 'dir') {
      setEntries(null)
      void os.filesList(place.root, place.rel).then((r) => (r.ok ? setEntries(r.value) : setError(t('files.cantOpen'))))
      void os.filesStatus(place.root).then(setStatus)
    } else if (place.kind === 'recent') { setHits(null); void os.filesRecent().then(setHits) }
    else if (place.kind === 'starred') { setHits(null); void os.filesStarred().then((s) => setHits(s.hits)) }
    else if (place.kind === 'archive') return
    else { setTrashItems(null); void os.filesTrashList().then(setTrashItems) }
  }, [place, tick])

  useEffect(() => {
    if (!search?.q.trim() || !dir) { setFound(null); return }
    const id = setTimeout(() => { void os.filesSearch(dir.root, dir.rel, search.q, search.kind, search.days).then((r) => setFound(r.ok ? r.value : { hits: [], ms: 0, truncated: false })) }, 200)
    return () => clearTimeout(id)
  }, [search, dir?.root, dir?.rel]) // eslint-disable-line react-hooks/exhaustive-deps

  const folderName = (p: Place) => p.kind === 'recent' ? t('files.recent') : p.kind === 'starred' ? t('files.starred') : p.kind === 'trash' ? t('files.trash')
    : p.kind === 'archive' ? [p.rel.split('/').pop()!, ...p.inner.split('/').filter(Boolean)].join(' › ')
    : p.rel ? folderLabel(p.rel.split('/').pop()!) : p.root === 'home' ? (places?.user ?? t('files.home')) : p.root === 'drive' ? 'WorkSuite Drive' : places?.media.find((m) => m.id === p.root)?.label ?? p.root
  const crumbs = dir ? [{ label: folderName({ ...dir, rel: '' }), rel: '' }, ...dir.rel.split('/').filter(Boolean).map((s, i, all) => ({ label: i === 0 && dir.root === 'home' ? folderLabel(s) : s, rel: all.slice(0, i + 1).join('/') }))] : []

  const rows = entries ?? []
  const byName = (n: string) => rows.find((e) => e.name === n)
  const relOf = (n: string) => (dir!.rel ? `${dir!.rel}/${n}` : n)
  // Windows programs are never run; the main process refuses them and this explains why (WSOS-LCH-003).
  const openFile = (root: string, rel: string, name: string) => void os.filesOpen(root, rel).then((r) => { if (!r.ok && r.error === 'windows_program') setWinApp(name); if (r.ok && (r.value as unknown) === 'read_only_copy') setReadOnly(name) })
  // Archives open in Files' own read-only view.
  const open = (e: FileEntry) => { if (e.dir) go({ kind: 'dir', root: dir!.root, rel: relOf(e.name) }); else if (e.local && archiveKind(e.name)) go({ kind: 'archive', root: dir!.root, rel: relOf(e.name), inner: '' }); else if (e.local) openFile(dir!.root, relOf(e.name), e.name) }
  const openHit = (h: FileHit) => { if (h.dir) go({ kind: 'dir', root: h.root, rel: h.rel }); else if (archiveKind(h.name)) go({ kind: 'archive', root: h.root, rel: h.rel, inner: '' }); else openFile(h.root, h.rel, h.name) }
  // Selection: click, Ctrl+click to add or remove, Shift+click for a range (in the order shown), Ctrl+A for all.
  const pick = (name: string, ev: React.MouseEvent) => setSel((s) => {
    if (ev.shiftKey && s.length) { const order = shown.map((e) => e.name), a = order.indexOf(s[s.length - 1]), b = order.indexOf(name); if (a >= 0 && b >= 0) return order.slice(Math.min(a, b), Math.max(a, b) + 1) }
    return ev.ctrlKey || ev.metaKey ? (s.includes(name) ? s.filter((x) => x !== name) : [...s, name]) : [name]
  })
  const arcJob = (p: Promise<{ ok: boolean; error?: string }>) => void p.then((r) => { if (!r.ok) setNotice(archiveError(r.error)) })
  const extract = (root: string, rel: string, mode: 'here' | 'folder', items: string[] = [], pw: string | null = null) => arcJob(os.filesExtract(root, rel, mode, items, pw))
  const targets = (name: string | null) => (name && !sel.includes(name) ? [name] : sel)

  const act = async (fn: () => Promise<{ ok: boolean; error?: string }>) => {
    const r = await fn()
    if (!r.ok) setNotice(r.error === 'exists' ? t('files.err.exists') : r.error === 'unavailable' ? t('files.job.unavailable') : t('files.err.generic'))
    reload()
    return r
  }
  const paste = () => { if (clip && dir) { const to: Place = { ...dir }; void act(() => os.filesPaste(clip.op, clip.root, clip.rels, dir.root, dir.rel)).then((r) => started(r, to)); if (clip.op === 'move') setClip(null) } }
  // FO3: Delete asks first (Trash, or permanently with Shift+Delete); FO4: the toast offers Undo for the Trash.
  const askDelete = (names: string[], permanent: boolean) => { if (dir && names.length) setAsk({ kind: 'delete', names, permanent }) }
  const doDelete = async (names: string[], permanent: boolean) => {
    if (!dir) return
    setAsk(null); setSel([])
    if (permanent) {
      const r = await os.filesDelete(dir.root, names.map(relOf))
      if (r.ok) toast({ kind: 'trash', text: r.value === 1 ? t('files.ops.toastDeletedOne') : t('files.ops.toastDeleted', { count: formatNumber(r.value) }) })
      else setNotice(r.error === 'permission' ? t('files.err.permShort') : r.error === 'busy' ? t('files.err.busyShort') : t('files.err.generic'))
    } else {
      const r = await os.filesTrash(dir.root, names.map(relOf))
      if (r.ok) {
        const ids = r.value.ids
        toast({ kind: 'trash', text: names.length === 1 ? t('files.ops.toastTrashedOne', { name: names[0] }) : t('files.ops.toastTrashed', { count: formatNumber(r.value.count) }),
          action: { label: t('files.ops.undo'), run: () => void os.filesTrashRestore(ids).then((x) => { if (x.ok && x.value.skipped) setNotice(t('files.trash.skipped', { count: x.value.skipped })); reload() }) } })
      } else setNotice(t('files.err.generic'))
    }
    reload()
  }
  const star = (name: string) => { if (!dir) return; const on = !stars.includes(`${dir.root}:${relOf(name)}`); void os.filesStar(dir.root, relOf(name), on).then((r) => { if (r.ok) setStars(r.value) }) }

  // Drag files out to another app: a native drag with the real paths (text/uri-list on Wayland).
  const dragOut = (ev: React.DragEvent, name: string) => {
    ev.preventDefault()
    if (dir) void os.filesStartDrag(dir.root, (sel.includes(name) ? sel : [name]).map(relOf))
  }

  // Keyboard: Enter, F2, Delete, Ctrl+X/C/V (FM3 shortcuts).
  const mainRef = useRef<HTMLDivElement>(null)
  const onKey = (ev: React.KeyboardEvent) => {
    if (!dir || ask || search || (ev.target as HTMLElement).tagName === 'INPUT') return
    const one = sel.length === 1 ? byName(sel[0]) : undefined
    if (ev.key === 'Escape') { if (menu) setMenu(null); else onClose() }
    else if (ev.key === 'Enter' && one) open(one)
    else if (ev.key === 'F2' && one) setAsk({ kind: 'rename', name: one.name })
    else if (ev.key === 'Delete' && sel.length) askDelete(sel, ev.shiftKey)
    else if (ev.ctrlKey && (ev.key === 'c' || ev.key === 'x') && sel.length) setClip({ op: ev.key === 'c' ? 'copy' : 'move', root: dir.root, rels: sel.map(relOf) })
    else if (ev.ctrlKey && ev.key === 'v') paste()
    else if (ev.ctrlKey && ev.key === 'a') setSel(shown.map((e) => e.name))
    else return
    ev.preventDefault()
  }

  const folders = rows.filter((e) => e.dir), files = rows.filter((e) => !e.dir)
  const shown = view === 'grid' ? [...folders, ...files] : rows
  const selBytes = sel.map(byName).reduce((a, e) => a + (e && !e.dir ? e.size ?? 0 : 0), 0)
  const conflicts = rows.filter((e) => e.state === 'conflict').length
  const selected = sel.length === 1 ? byName(sel[0]) : undefined

  return (
    <div role="dialog" aria-modal="false" aria-label={t('files.title')} className="fixed inset-0 z-50 flex font-sans" style={{ background: C.page, color: C.text }} onKeyDown={onKey}>
      <FilesSide place={place} places={places} drive={driveState ? DRIVE_META[driveState as keyof typeof DRIVE_META] ?? driveState : null} onGo={go}
        onEject={(id, label) => void os.filesEject(id).then((r) => { if (!r.ok) setNotice(t('files.ejectFailed', { name: label })); else go({ kind: 'dir', root: 'home', rel: '' }); reload() })} />
      <main ref={mainRef} className="relative flex min-w-0 flex-1 flex-col" onClick={() => setMenu(null)}
        onDragOver={(ev) => { if (dir && ev.dataTransfer.types.includes('Files')) { ev.preventDefault(); ev.dataTransfer.dropEffect = 'copy' } }}
        onDrop={(ev) => {
          // Files dropped from another app (WSOS-DSK-013) are copied here, like Paste.
          if (!dir || !ev.dataTransfer.files.length) return
          ev.preventDefault()
          const paths = [...ev.dataTransfer.files].map((f) => os.pathForFile(f)).filter(Boolean)
          void os.filesDrop(paths, dir.root, dir.rel).then((r) => { if (!r.ok || r.value.rejected) setNotice(t('files.dropRejected')) })
        }}>
        {/* Header: FM1/FM2 toolbar, FM5 search bar, FM6 trash actions */}
        <header className="box-border flex h-[60px] shrink-0 items-center gap-2.5 px-5" style={{ borderBottom: `1px solid ${C.line}`, background: C.bar }}>
          {search && dir ? <>
            <label className="box-border flex h-[38px] flex-1 items-center gap-2.5 rounded-[10px] px-3.5 text-sm" style={{ background: 'var(--ws-g-field)', border: `1px solid ${C.blue}` }}>
              <Svg d="M11 4a7 7 0 1 0 0 14 7 7 0 0 0 0-14zM20 20l-4-4" stroke={C.link} width={2.2} />
              <input autoFocus type="text" value={search.q} onChange={(e) => setSearch({ ...search, q: e.target.value })} aria-label={t('files.search.label')}
                onKeyDown={(e) => { if (e.key === 'Escape') setSearch(null) }} className="min-w-0 grow border-0 bg-transparent text-sm outline-none" style={{ color: C.text, background: 'transparent' }} />
              <span className="ml-auto shrink-0 text-xs" style={{ color: C.muted }}>{t('files.search.scope', { folder: folderName(dir) })}</span>
            </label>
            <button type="button" onClick={() => setSearch(null)} className={`${btn} px-1.5 text-[13px]`} style={{ color: C.link }}>{t('common.cancel')}</button>
          </> : place.kind === 'trash' ? <>
            <span className="text-[15px] font-semibold">{t('files.trash')}</span>
            <button type="button" disabled={!trashItems?.length} onClick={() => void os.filesTrashRestore(trashItems!.map((x) => x.id)).then((r) => { if (r.ok && r.value.skipped) setNotice(t('files.trash.skipped', { count: r.value.skipped })); reload() })}
              className={`${btn} ml-auto flex h-[34px] items-center rounded-lg px-3.5 text-[13px] disabled:opacity-40`} style={{ border: '1px solid rgba(127,178,255,0.25)' }}>{t('files.trash.restoreAll')}</button>
            <button type="button" disabled={!trashItems?.length} onClick={() => setAsk({ kind: 'empty' })}
              className={`${btn} flex h-[34px] items-center rounded-lg px-3.5 text-[13px] font-semibold disabled:opacity-40`} style={{ border: '1px solid rgba(255,138,122,0.45)', color: '#FFB4A8' }}>{t('files.trash.empty')}</button>
          </> : <>
            <button type="button" aria-label={t('files.back')} disabled={hist.i === 0} onClick={() => { setHist((h) => ({ ...h, i: h.i - 1 })); setSel([]) }} className={iconBtn}><Svg d={P.back} stroke={C.soft} width={2.2} /></button>
            <button type="button" aria-label={t('files.forward')} disabled={hist.i >= hist.list.length - 1} onClick={() => { setHist((h) => ({ ...h, i: h.i + 1 })); setSel([]) }} className={iconBtn}><Svg d={P.fwd} stroke={C.soft} width={2.2} /></button>
            <nav aria-label={t('files.path')} className="flex min-w-0 items-center gap-1.5 text-sm" style={{ color: C.muted }}>
              {dir ? crumbs.map((c, i) => (
                <span key={c.rel} className="flex items-center gap-1.5">
                  {i > 0 && <span aria-hidden="true">{'›'}</span>}
                  {i === crumbs.length - 1 ? <span className="font-semibold text-white">{c.label}</span>
                    : <button type="button" onClick={() => go({ kind: 'dir', root: dir.root, rel: c.rel })} className={`${btn} hover:text-white`}>{c.label}</button>}
                </span>
              )) : <span className="font-semibold text-white">{folderName(place)}</span>}
            </nav>
            {dir && <button type="button" onClick={() => setSearch({ q: '', kind: 'any', days: 0 })} className={`${btn} ml-auto box-border flex h-[34px] w-[240px] items-center gap-2 rounded-lg px-3 text-[13px]`}
              style={{ background: 'var(--ws-g-field)', border: '1px solid rgba(127,178,255,0.14)', color: C.muted }}>
              <Svg d="M11 4a7 7 0 1 0 0 14 7 7 0 0 0 0-14zM20 20l-4-4" size={14} stroke={C.muted} width={2.2} /><span className="truncate">{t('files.search.placeholder', { folder: folderName(place) })}</span>
            </button>}
            {dir && <div className="flex overflow-hidden rounded-lg" style={{ border: '1px solid rgba(127,178,255,0.18)' }}>
              {(['grid', 'list'] as const).map((v) => (
                <button key={v} type="button" aria-label={v === 'grid' ? t('files.gridView') : t('files.listView')} aria-pressed={view === v} onClick={() => setView(v)}
                  className={`${btn} flex h-8 w-[34px] items-center justify-center`} style={{ background: view === v ? 'rgba(31,107,255,0.25)' : 'transparent' }}>
                  <Svg d={v === 'grid' ? P.grid : P.list} size={14} stroke={view === v ? 'var(--ws-g-strong)' : C.muted} width={2.2} />
                </button>
              ))}
            </div>}
            {dir && view === 'grid' && <button type="button" onClick={() => setAsk({ kind: 'mkdir' })} title={t('files.newFolder')} className={`${btn} flex h-[34px] items-center gap-1.5 rounded-lg px-3.5 text-[13px] font-semibold`} style={{ background: C.blue, color: '#FFFFFF' }}>{`+ ${t('files.new')}`}</button>}
          </>}
          {!search && <button type="button" aria-label={t('files.close')} onClick={onClose} className={`${iconBtn} ${dir ? '' : arc ? 'ml-auto' : 'ml-1'}`} style={{ color: C.muted }}><Svg d={P.close} /></button>}
        </header>

        {readOnly && (
          <div role="status" className="mx-6 mt-4 flex items-center gap-3 rounded-xl px-4 py-3 text-[13px]" style={{ background: 'rgba(31,107,255,0.08)', border: '1px solid rgba(31,107,255,0.3)', color: C.soft }}>
            <span className="grow">{t('files.readOnlyCopy', { name: readOnly })}</span>
            <button type="button" onClick={() => setReadOnly(null)} className={`${btn} text-[13px]`} style={{ color: C.link }}>{t('common.dismiss')}</button>
          </div>
        )}
        {winApp && (
          <div role="alert" className="mx-6 mt-4 flex items-center gap-3 rounded-xl px-4 py-3 text-[13px]" style={{ background: 'rgba(31,107,255,0.08)', border: '1px solid rgba(31,107,255,0.3)', color: C.soft }}>
            <span className="grow"><b>{t('files.winTitle')}</b> {t('files.winBody', { name: winApp })}</span>
            <button type="button" onClick={() => setWinApp(null)} className={`${btn} text-[13px]`} style={{ color: C.link }}>{t('common.dismiss')}</button>
          </div>
        )}
        {cloud && conflicts > 0 && !search && (
          <div role="alert" className="mx-6 mt-4 flex items-center gap-3 rounded-xl px-4 py-3 text-[13px]" style={{ background: 'rgba(255,185,138,0.1)', border: '1px solid rgba(255,185,138,0.4)', color: '#FFD9BF' }}>
            <span className="grow"><b>{t('files.conflicts', { count: formatNumber(conflicts) })}</b> {t('files.conflictBody')}</span>
          </div>
        )}

        {arc ? <ArchiveView root={arc.root} rel={arc.rel} inner={arc.inner} password={arcPw} setPassword={setArcPw}
            onGo={(inner) => go({ ...arc, inner })} onLeave={() => (hist.i > 0 ? setHist((h) => ({ ...h, i: h.i - 1 })) : go({ kind: 'dir', root: arc.root, rel: arc.rel.split('/').slice(0, -1).join('/') }))}
            onExtract={(items) => extract(arc.root, arc.rel, items.length ? 'here' : 'folder', items, arcPw)} />
          : search && dir ? <SearchView search={search} setSearch={setSearch} found={found} openHit={openHit} />
          : place.kind === 'trash' ? <TrashView items={trashItems} act={act} setNotice={setNotice} />
          : place.kind !== 'dir' ? <HitList hits={hits} empty={place.kind === 'recent' ? t('files.recentNone') : t('files.starredNone')} openHit={openHit} />
          : error ? <p className="p-6 text-sm" style={{ color: '#FF8A7A' }}>{error}</p>
          : !entries ? <p className="p-6 text-sm" style={{ color: C.muted }}>{t('common.loading')}</p>
          : view === 'grid' ? (
            <div className="flex flex-1 flex-col gap-3.5 overflow-auto px-6 py-[22px]" style={{ background: 'radial-gradient(ellipse 80% 50% at 80% 0%, var(--ws-g-glow) 0%, var(--ws-g-page) 60%)' }}
              onContextMenu={(ev) => { ev.preventDefault(); setMenu({ x: ev.clientX, y: ev.clientY, name: null }) }} onClick={(ev) => { if (ev.target === ev.currentTarget) setSel([]) }}>
              {rows.length === 0 && <p className="text-sm" style={{ color: C.muted }}>{t('files.empty')}</p>}
              {folders.length > 0 && <><span className="text-xs" style={{ color: C.muted }}>{t('files.foldersSection')}</span>
                <div className="grid grid-cols-6 gap-3">
                  {folders.map((f, i) => (
                    <button key={f.name} type="button" draggable onDragStart={(ev) => dragOut(ev, f.name)} onClick={(ev) => { ev.stopPropagation(); pick(f.name, ev) }} onDoubleClick={() => open(f)} onContextMenu={(ev) => { ev.preventDefault(); ev.stopPropagation(); if (!sel.includes(f.name)) setSel([f.name]); setMenu({ x: ev.clientX, y: ev.clientY, name: f.name }) }}
                      aria-pressed={sel.includes(f.name)} className={`${btn} flex items-center gap-2.5 rounded-[10px] p-3 text-left`}
                      style={{ background: sel.includes(f.name) ? 'rgba(31,107,255,0.18)' : C.card, border: `1px solid ${sel.includes(f.name) ? C.blue : C.line}` }}>
                      <Svg d={P.folder} size={22} fill={folderColor(i)} />
                      <span className="flex min-w-0 flex-col"><span className="truncate text-[13px] font-medium">{f.name}</span><span className="text-[11px]" style={{ color: C.muted }}>{sizeOf(f)}</span></span>
                    </button>
                  ))}
                </div></>}
              {files.length > 0 && <><span className="mt-1.5 text-xs" style={{ color: C.muted }}>{t('files.filesHeading')}</span>
                <div className="grid grid-cols-6 gap-3">
                  {files.map((f) => {
                    const k = kindOf(f.name, false), on = sel.includes(f.name)
                    return (
                      <button key={f.name} type="button" draggable onDragStart={(ev) => dragOut(ev, f.name)} onClick={(ev) => { ev.stopPropagation(); pick(f.name, ev) }} onDoubleClick={() => open(f)} onContextMenu={(ev) => { ev.preventDefault(); ev.stopPropagation(); if (!sel.includes(f.name)) setSel([f.name]); setMenu({ x: ev.clientX, y: ev.clientY, name: f.name }) }}
                        aria-pressed={on} title={!f.local ? t('files.onlineOnly') : undefined} className={`${btn} flex flex-col gap-2 rounded-xl p-2.5 text-left`}
                        style={{ background: on ? 'rgba(31,107,255,0.18)' : 'var(--ws-g-card)', border: `1px solid ${on ? C.blue : 'var(--ws-g-line)'}`, opacity: f.local ? 1 : 0.7 }}>
                        <span className="flex h-24 items-center justify-center rounded-lg" style={{ background: thumbBg(k.image) }}>
                          <span className="rounded-[5px] px-[7px] py-[3px] font-mono text-[11px] font-semibold text-white" style={{ background: k.color }}>{k.ext}</span>
                        </span>
                        <span className="truncate text-[13px] font-medium">{f.name}</span>
                        <span className="-mt-1 flex items-center gap-1.5 text-[11px]" style={{ color: C.muted }}>
                          {cloud && SYNC_LABEL[f.state as keyof typeof SYNC_LABEL] && <span className="size-[7px] shrink-0 rounded-full" style={{ background: SYNC_DOT[f.state] }} title={SYNC_LABEL[f.state as keyof typeof SYNC_LABEL]} />}
                          {day(f.modified)}
                        </span>
                      </button>
                    )
                  })}
                </div></>}
            </div>
          ) : (
            <div className="flex min-h-0 flex-1">
              <div className="flex min-w-0 flex-1 flex-col overflow-auto" onContextMenu={(ev) => { ev.preventDefault(); setMenu({ x: ev.clientX, y: ev.clientY, name: null }) }}>
                <div className="grid grid-cols-[minmax(0,1fr)_110px_90px_120px] gap-3 px-6 py-2.5 text-xs" style={{ color: C.muted, borderBottom: '1px solid rgba(127,178,255,0.1)' }}>
                  <span>{t('files.sortedByName')}</span><span>{t('files.col.modified')}</span><span>{t('files.col.size')}</span><span>{cloud ? t('files.col.sync') : t('files.col.kind')}</span>
                </div>
                {rows.length === 0 && <p className="px-6 py-4 text-sm" style={{ color: C.muted }}>{t('files.empty')}</p>}
                {rows.map((f, i) => {
                  const k = kindOf(f.name, f.dir), on = sel.includes(f.name)
                  return (
                    <button key={f.name} type="button" draggable onDragStart={(ev) => dragOut(ev, f.name)} onClick={(ev) => { ev.stopPropagation(); pick(f.name, ev) }} onDoubleClick={() => open(f)}
                      onContextMenu={(ev) => { ev.preventDefault(); ev.stopPropagation(); if (!sel.includes(f.name)) setSel([f.name]); setMenu({ x: ev.clientX, y: ev.clientY, name: f.name }) }}
                      aria-pressed={on} className={`${btn} grid grid-cols-[minmax(0,1fr)_110px_90px_120px] items-center gap-3 px-6 py-[9px] text-left text-[13px]`}
                      style={{ background: on ? 'rgba(31,107,255,0.22)' : f.state === 'conflict' ? 'rgba(255,185,138,0.08)' : i % 2 ? 'rgba(255,255,255,0.015)' : 'transparent', opacity: f.local ? 1 : 0.7 }}>
                      <span className="flex min-w-0 items-center gap-2.5">
                        <span className="flex size-[26px] flex-none items-center justify-center rounded-md font-mono text-[8px] font-bold" style={{ background: k.color }}>{k.ext}</span>
                        <span className="truncate" style={{ fontWeight: f.dir ? 600 : 400 }}>{f.name}</span>
                        {stars.includes(`${dir!.root}:${relOf(f.name)}`) && <span style={{ color: '#FFB98A' }}>{'★'}</span>}
                      </span>
                      <span style={{ color: C.soft }}>{day(f.modified)}</span>
                      <span className="font-mono text-xs" style={{ color: C.soft }}>{sizeOf(f)}</span>
                      <span className="flex items-center gap-1.5 truncate" style={{ color: C.muted }}>
                        {cloud && SYNC_LABEL[f.state as keyof typeof SYNC_LABEL] ? <><span className="size-[7px] shrink-0 rounded-full" style={{ background: SYNC_DOT[f.state] }} />{SYNC_LABEL[f.state as keyof typeof SYNC_LABEL]}</> : k.label}
                      </span>
                    </button>
                  )
                })}
              </div>
              <Preview entry={selected} dirLabel={dir ? `${crumbs.length ? (dir.root === 'home' ? '~' : crumbs[0].label) : ''}${dir.rel ? '/' + dir.rel : ''}` : ''} cloud={cloud}
                onOpen={() => selected && open(selected)} />
            </div>
          )}

        {dir && !search && (
          <footer className="box-border flex h-8 shrink-0 items-center justify-between px-5 text-xs" style={{ borderTop: `1px solid ${C.line}`, color: C.muted }}>
            <span>{t('files.summary', { folders: formatNumber(folders.length), files: formatNumber(files.length) })}</span>
            <span>{sel.length ? (selBytes ? t('files.selected', { count: formatNumber(sel.length), size: formatBytes(selBytes) }) : t('files.selectedOnly', { count: formatNumber(sel.length) }))
              : cloud ? (status?.drive ? t('files.lastSync', { when: status.drive.last_sync ? formatDate(status.drive.last_sync) : t('settings.about.notYet') }) : t('files.noService'))
              : status?.free_bytes != null ? t('files.free', { size: formatBytes(status.free_bytes) }) : ''}</span>
          </footer>
        )}

        {menu && dir && <ContextMenu menu={menu} entry={menu.name ? byName(menu.name) : undefined} starred={!!menu.name && stars.includes(`${dir.root}:${relOf(menu.name)}`)} canPaste={!!clip} multi={targets(menu.name).length > 1}
          onPick={(a) => {
            const names = targets(menu.name), one = menu.name ? byName(menu.name) : undefined
            setMenu(null)
            if (a === 'open' && one) open(one)
            else if (a === 'cut' || a === 'copy') setClip({ op: a === 'cut' ? 'move' : 'copy', root: dir.root, rels: names.map(relOf) })
            else if (a === 'paste') paste()
            else if (a === 'duplicate') { const to: Place = { ...dir }; void act(() => os.filesPaste('duplicate', dir.root, names.map(relOf), dir.root, dir.rel)).then((r) => started(r, to)) }
            else if (a === 'rename' && one) setAsk({ kind: 'rename', name: one.name })
            else if (a === 'star' && one) star(one.name)
            else if (a === 'compress') setCompressing(names)
            else if (a === 'openArchive' && one) open(one)
            else if ((a === 'extractHere' || a === 'extractTo') && one) extract(dir.root, relOf(one.name), a === 'extractHere' ? 'here' : 'folder')
            else if (a === 'properties' && one) { setView('list'); setSel([one.name]) }
            else if (a === 'trash') askDelete(names, false)
            else if (a === 'mkdir') setAsk({ kind: 'mkdir' })
          }} />}

        {!!jobs.length && !jobsOpen && <JobsChip jobs={jobs} onOpen={() => setJobsOpen(true)} />}
        <Toasts toasts={toasts} dismiss={dropToast} />
        {notice && (
          <div role="status" className="absolute bottom-11 left-1/2 flex -translate-x-1/2 items-center gap-3 rounded-xl px-4 py-2.5 text-[13px]" style={{ background: 'var(--ws-g-menu)', border: '1px solid rgba(127,178,255,0.22)' }}>
            {notice}<button type="button" onClick={() => setNotice(null)} className={btn} style={{ color: C.link }}>{t('common.dismiss')}</button>
          </div>
        )}
      </main>

      {!!jobs.length && jobsOpen && !job && <JobsWindow jobs={jobs} notify={notifyDone} setNotify={setNotifyDone} onMinimize={() => setJobsOpen(false)} />}
      {job?.state === 'conflict' && job.conflict && <ConflictDialog key={`${job.id}:${job.conflict.index ?? job.conflict.name}`} job={job} />}
      {job?.state === 'error' && <JobErrorCard key={`${job.id}:${job.error}:${job.error_name}`} job={job} />}
      {ask?.kind === 'delete' && dir && <DeleteDialog items={ask.names.map((n) => byName(n) ?? { name: n, dir: false, size: null, modified: null, state: 'local', local: true })} permanent={ask.permanent} canTrash
        onCancel={() => setAsk(null)} onConfirm={(perm) => void doDelete(ask.names, perm)} />}
      {job?.state === 'password' && <PasswordDialog key={`${job.id}:${job.ask?.wrong}`} name={job.name ?? ''} wrong={!!job.ask?.wrong} onCancel={() => void os.filesArchivePassword(job.id, null)} onSubmit={(pw) => void os.filesArchivePassword(job.id, pw)} />}
      {job?.state === 'confirm' && <LargeDialog job={job} />}
      {compressing && dir && <CompressDialog names={compressing} onCancel={() => setCompressing(null)}
        onSubmit={(o) => { setCompressing(null); arcJob(os.filesCompress(dir.root, compressing.map(relOf), o)) }} />}
      {ask && dir && (ask.kind === 'mkdir' || ask.kind === 'rename') && <NameDialog title={ask.kind === 'mkdir' ? t('files.newFolder') : t('files.renameTitle', { name: ask.name })} initial={ask.kind === 'rename' ? ask.name : ''}
        action={ask.kind === 'mkdir' ? t('files.create') : t('files.rename')} onCancel={() => setAsk(null)}
        onSubmit={async (name) => {
          const r = ask.kind === 'mkdir' ? await os.filesMkdir(dir.root, dir.rel, name) : await os.filesRename(dir.root, relOf(ask.name), name)
          if (!r.ok) return r.error === 'exists' ? t('files.err.exists') : t('files.err.generic')
          setAsk(null); setSel([r.value.split('/').pop()!]); reload(); return null
        }} />}
      {ask?.kind === 'empty' && <Confirm text={t('files.trash.confirm', { count: formatNumber(trashItems?.length ?? 0) })} action={t('files.trash.empty')} onCancel={() => setAsk(null)}
        onOk={() => { setAsk(null); void act(() => os.filesTrashDelete('all')) }} />}
    </div>
  )
}

// FM2 preview pane.
function Preview({ entry, dirLabel, cloud, onOpen }: { entry: FileEntry | undefined; dirLabel: string; cloud: boolean; onOpen: () => void }) {
  if (!entry) return <aside aria-label={t('files.preview')} className="box-border w-[300px] shrink-0" style={{ borderLeft: `1px solid ${C.line}`, background: C.bar }} />
  const k = kindOf(entry.name, entry.dir)
  const meta: [string, string][] = [[t('files.col.modified'), day(entry.modified)], [t('files.meta.location'), dirLabel],
    [t('files.meta.synced'), cloud ? (SYNC_LABEL[entry.state as keyof typeof SYNC_LABEL] ?? '—') : t('files.notInDrive')]]
  return (
    <aside aria-label={t('files.preview')} className="box-border flex w-[300px] shrink-0 flex-col gap-3.5 p-5" style={{ borderLeft: `1px solid ${C.line}`, background: C.bar }}>
      <div className="flex h-[170px] items-center justify-center rounded-xl" style={{ background: thumbBg(k.image) }}>
        <span className="rounded-md px-2.5 py-1.5 font-mono text-sm font-bold" style={{ background: k.color }}>{k.badge}</span>
      </div>
      <div className="flex flex-col gap-1"><span className="text-base font-semibold break-words">{entry.name}</span><span className="text-xs" style={{ color: C.muted }}>{`${k.label} · ${sizeOf(entry)}`}</span></div>
      <div className="flex gap-2">
        <button type="button" disabled={!entry.dir && !entry.local} onClick={onOpen} className={`${btn} flex-1 rounded-lg py-[9px] text-center text-[13px] font-semibold disabled:opacity-40`} style={{ background: C.blue }}>{t('files.open')}</button>
        <button type="button" disabled title={t('files.shareNone')} className="flex-1 rounded-lg py-[9px] text-center text-[13px] opacity-40" style={{ border: '1px solid rgba(127,178,255,0.25)' }}>{t('files.share')}</button>
      </div>
      <dl className="m-0 flex flex-col gap-2 text-xs">
        {meta.map(([key, v]) => <div key={key} className="flex justify-between gap-3"><dt style={{ color: C.muted }}>{key}</dt><dd className="m-0 truncate">{v}</dd></div>)}
      </dl>
    </aside>
  )
}

// FM3 right-click menu.
type MenuAction = 'open' | 'cut' | 'copy' | 'paste' | 'duplicate' | 'rename' | 'star' | 'compress' | 'openArchive' | 'extractHere' | 'extractTo' | 'properties' | 'trash' | 'mkdir'
function ContextMenu({ menu, entry, starred, canPaste, multi, onPick }: { menu: Menu; entry: FileEntry | undefined; starred: boolean; canPaste: boolean; multi: boolean; onPick: (a: MenuAction) => void }) {
  type It = [MenuAction | null, string, string, string, boolean?, string?] | null
  // Archives: open (browse) and extract, for a single archive.
  const archive: It[] = entry && !entry.dir && !multi && archiveKind(entry.name) ? [
    ['openArchive', t('files.arc.open'), P.open, '', !entry.local], ['extractHere', t('files.arc.extractHere'), P.download, '', !entry.local],
    ['extractTo', t('files.arc.extractTo', { name: stemOf(entry.name) }), P.folder, '', !entry.local], null,
  ] : []
  const items: It[] = entry ? [...archive,
    ['open', t('files.open'), P.open, 'Enter', !entry.dir && !entry.local], [null, t('files.openWith'), P.chevron, '', true, t('files.openWithNone')], null,
    ['cut', t('files.cut'), P.cut, 'Ctrl X', !entry.local], ['copy', t('files.copy'), P.copy, 'Ctrl C', !entry.local], ['duplicate', t('files.duplicate'), P.duplicate, '', !entry.local], null,
    ['rename', t('files.rename'), P.rename, 'F2', !entry.local], ['star', starred ? t('files.unstar') : t('files.star'), P.star, '', !entry.local], [null, t('files.share'), P.share, '', true, t('files.shareNone')], ['compress', t('files.compressMore'), P.compress, '', !entry.local], null,
    ['properties', t('files.properties'), P.info, ''], ['trash', t('files.moveToTrash'), P.trash, 'Del', !entry.local],
  ] : [['mkdir', t('files.newFolder'), P.folder, ''], ['paste', t('files.paste'), P.paste, 'Ctrl V', !canPaste]]
  const ref = useRef<HTMLDivElement>(null)
  useEffect(() => { ref.current?.querySelector<HTMLButtonElement>('button:not(:disabled)')?.focus() }, [])
  const x = Math.min(menu.x, window.innerWidth - 270), y = Math.max(8, Math.min(menu.y, window.innerHeight - (entry ? 420 + archive.length * 34 : 100)))
  return (
    <div ref={ref} role="menu" aria-label={entry ? t('files.menuFor', { name: entry.name }) : t('files.new')} onClick={(e) => e.stopPropagation()}
      onKeyDown={(e) => {
        const all = [...(ref.current?.querySelectorAll<HTMLButtonElement>('button:not(:disabled)') ?? [])]
        const i = all.indexOf(document.activeElement as HTMLButtonElement)
        if (e.key === 'ArrowDown' || e.key === 'ArrowUp') { e.preventDefault(); all[(i + (e.key === 'ArrowDown' ? 1 : all.length - 1)) % all.length]?.focus() }
      }}
      className="fixed z-[60] box-border flex w-[260px] flex-col rounded-xl p-1.5" style={{ left: x, top: y, background: 'var(--ws-g-menu)', border: '1px solid rgba(127,178,255,0.22)', boxShadow: '0 20px 50px rgba(0,0,0,0.55)' }}>
      {items.map((it, i) => it === null ? <div key={i} className="mx-1.5 my-1 h-px" style={{ background: C.line }} /> : (
        <button key={i} type="button" role="menuitem" disabled={it[4] || !it[0]} title={it[5]} onClick={() => it[0] && onPick(it[0])}
          className="flex cursor-pointer items-center gap-3 rounded-[7px] px-2.5 py-2 text-left text-[13px] outline-none hover:bg-[rgba(31,107,255,0.25)] focus:bg-[rgba(31,107,255,0.25)] disabled:cursor-default disabled:opacity-40 disabled:hover:bg-transparent"
          style={{ color: it[0] === 'trash' ? '#FF8A7A' : C.text }}>
          <Svg d={it[2]} size={15} stroke={it[0] === 'trash' ? '#FF8A7A' : C.text} />
          <span className="flex-1">{it[1]}</span>
          <span className="font-mono text-[11px]" style={{ color: C.dim }}>{it[3]}</span>
        </button>
      ))}
    </div>
  )
}

// FM5 search results.
function SearchView({ search, setSearch, found, openHit }: { search: { q: string; kind: string; days: number }; setSearch: (s: { q: string; kind: string; days: number }) => void; found: { hits: FileHit[]; ms: number; truncated: boolean } | null; openHit: (h: FileHit) => void }) {
  const chips: { label: string; on: boolean; click?: () => void; title?: string }[] = [
    { label: t('files.search.any'), on: search.kind === 'any', click: () => setSearch({ ...search, kind: 'any' }) },
    { label: t('files.search.docs'), on: search.kind === 'documents', click: () => setSearch({ ...search, kind: 'documents' }) },
    { label: t('files.search.sheets'), on: search.kind === 'spreadsheets', click: () => setSearch({ ...search, kind: 'spreadsheets' }) },
    { label: t('files.search.last30'), on: search.days === 30, click: () => setSearch({ ...search, days: search.days === 30 ? 0 : 30 }) },
    { label: t('files.search.contents'), on: false, title: t('files.search.contentsNone') },
  ]
  const q = search.q.trim().toLowerCase()
  return (
    <>
      <div role="group" aria-label={t('files.search.filters')} className="flex gap-2 px-6 py-3.5" style={{ borderBottom: '1px solid rgba(127,178,255,0.1)' }}>
        {chips.map((c) => (
          <button key={c.label} type="button" aria-pressed={c.on} disabled={!c.click} title={c.title} onClick={c.click}
            className={`${btn} rounded-full px-3 py-1.5 text-xs disabled:opacity-40`} style={{ border: `1px solid ${c.on ? C.blue : 'var(--ws-g-line)'}`, background: c.on ? 'rgba(31,107,255,0.2)' : 'transparent' }}>{c.label}</button>
        ))}
      </div>
      <div className="flex flex-1 flex-col gap-1.5 overflow-auto px-6 py-4">
        {found && q && <span className="mb-1 text-xs" style={{ color: C.muted }}>
          {t('files.search.results', { count: formatNumber(found.hits.length), secs: formatDecimal(found.ms / 1000, 2) })}{found.truncated ? ` · ${t('files.search.more', { count: formatNumber(found.hits.length) })}` : ''}
        </span>}
        {found && q && found.hits.length === 0 && <p className="text-sm" style={{ color: C.muted }}>{t('files.search.none', { q: search.q.trim() })}</p>}
        {q && found?.hits.map((h, i) => <HitRow key={h.root + h.rel} h={h} q={q} first={i === 0} onOpen={() => openHit(h)} />)}
      </div>
    </>
  )
}

function HitRow({ h, q, first, onOpen }: { h: FileHit; q?: string; first?: boolean; onOpen: () => void }) {
  const k = kindOf(h.name, h.dir)
  const at = q ? h.name.toLowerCase().indexOf(q) : -1
  return (
    <button type="button" onDoubleClick={onOpen} onKeyDown={(e) => { if (e.key === 'Enter') onOpen() }} className={`${btn} flex items-center gap-3.5 rounded-[10px] px-3.5 py-3 text-left hover:bg-white/5 focus:bg-[rgba(31,107,255,0.18)]`}
      style={{ background: first ? 'rgba(31,107,255,0.18)' : 'transparent' }}>
      <span className="flex size-[34px] flex-none items-center justify-center rounded-lg font-mono text-[9px] font-bold" style={{ background: k.color }}>{k.ext}</span>
      <span className="flex min-w-0 flex-1 flex-col gap-0.5">
        <span className="truncate text-sm">{at < 0 ? h.name : <>{h.name.slice(0, at)}<mark className="rounded-[3px] px-0.5 text-white" style={{ background: 'rgba(24,212,240,0.25)' }}>{h.name.slice(at, at + q!.length)}</mark>{h.name.slice(at + q!.length)}</>}</span>
        <span className="truncate font-mono text-[11px]" style={{ color: C.muted }}>{h.where}</span>
      </span>
      <span className="text-xs" style={{ color: C.muted }}>{day(h.modified)}</span>
    </button>
  )
}

function HitList({ hits, empty, openHit }: { hits: FileHit[] | null; empty: string; openHit: (h: FileHit) => void }) {
  return (
    <div className="flex flex-1 flex-col gap-1.5 overflow-auto px-6 py-4">
      {!hits ? <p className="text-sm" style={{ color: C.muted }}>{t('common.loading')}</p>
        : hits.length === 0 ? <p className="text-sm" style={{ color: C.muted }}>{empty}</p>
        : hits.map((h) => <HitRow key={h.root + h.rel} h={h} onOpen={() => openHit(h)} />)}
    </div>
  )
}

// FM6 Trash.
function TrashView({ items, act, setNotice }: { items: TrashItem[] | null; act: (fn: () => Promise<{ ok: boolean; error?: string }>) => Promise<{ ok: boolean }>; setNotice: (s: string) => void }) {
  const total = (items ?? []).reduce((a, x) => a + x.size, 0)
  const cols = 'grid grid-cols-[minmax(0,1fr)_240px_120px_140px] gap-3 items-center'
  return (
    <>
      <div className="mx-6 mt-4 flex items-center gap-3 rounded-xl px-4 py-3 text-[13px]" style={{ background: 'rgba(31,107,255,0.08)', border: '1px solid rgba(31,107,255,0.3)', color: C.soft }}>
        <Svg d={P.recent} size={18} stroke={C.link} />
        <span>{t('files.trash.info', { count: formatNumber(items?.length ?? 0), size: formatBytes(total) })}</span>
      </div>
      <div className="flex flex-1 flex-col overflow-auto px-6 py-3">
        <div className={`${cols} px-3.5 py-2.5 text-xs`} style={{ color: C.muted }}><span>{t('files.col.name')}</span><span>{t('files.trash.orig')}</span><span>{t('files.trash.deleted')}</span><span /></div>
        {!items ? <p className="px-3.5 text-sm" style={{ color: C.muted }}>{t('common.loading')}</p>
          : items.length === 0 ? <p className="px-3.5 text-sm" style={{ color: C.muted }}>{t('files.trash.none')}</p>
          : items.map((x, i) => {
            const k = kindOf(x.name, x.dir)
            return (
              <div key={x.id} className={`${cols} rounded-[10px] px-3.5 py-2.5 text-[13px]`} style={{ background: i % 2 ? 'rgba(255,255,255,0.02)' : 'transparent' }}>
                <span className="flex min-w-0 items-center gap-2.5 opacity-85">
                  <span className="flex size-[26px] flex-none items-center justify-center rounded-md font-mono text-[8px] font-bold" style={{ background: k.color }}>{k.ext}</span><span className="truncate">{x.name}</span>
                </span>
                <span className="truncate font-mono text-xs" style={{ color: C.muted }}>{x.where}</span>
                <span style={{ color: C.soft }}>{day(x.deleted)}</span>
                <span className="flex justify-end gap-3">
                  <button type="button" onClick={() => void act(() => os.filesTrashRestore([x.id]).then((r) => { if (r.ok && r.value.skipped) setNotice(t('files.trash.skipped', { count: 1 })); return r }))} className={`${btn} text-[13px]`} style={{ color: C.link }}>{t('files.trash.restore')}</button>
                  <button type="button" onClick={() => void act(() => os.filesTrashDelete([x.id]))} className={`${btn} text-[13px]`} style={{ color: C.muted }}>{t('files.trash.delete')}</button>
                </span>
              </div>
            )
          })}
      </div>
    </>
  )
}

function NameDialog({ title, initial, action, onCancel, onSubmit }: { title: string; initial: string; action: string; onCancel: () => void; onSubmit: (name: string) => Promise<string | null> }) {
  const [name, setName] = useState(initial)
  const [err, setErr] = useState<string | null>(null)
  const ref = useRef<HTMLInputElement>(null)
  useEffect(() => { const el = ref.current; if (el) { el.focus(); const dot = initial.lastIndexOf('.'); el.setSelectionRange(0, dot > 0 ? dot : initial.length) } }, [initial])
  const ok = useMemo(() => name.trim() && !name.includes('/') && name.trim() !== '.' && name.trim() !== '..' && name.trim() !== initial, [name, initial])
  return (
    <Modal label={title}>
      <h2 className="m-0 text-[19px] font-bold">{title}</h2>
      <form className="flex flex-col gap-4" onSubmit={(e) => { e.preventDefault(); if (ok) void onSubmit(name.trim()).then(setErr) }}>
        <label className="flex flex-col gap-1.5 text-xs" style={{ color: C.muted }}>{t('files.nameLabel')}
          <input ref={ref} value={name} onChange={(e) => { setName(e.target.value); setErr(null) }} onKeyDown={(e) => { if (e.key === 'Escape') onCancel() }}
            className="h-10 rounded-lg px-3 text-sm outline-none" style={{ background: 'var(--ws-g-field)', border: `1px solid ${err ? '#FF8A7A' : C.blue}`, color: C.text }} />
        </label>
        {err && <p role="alert" className="m-0 text-[13px]" style={{ color: '#FFB4A8' }}>{err}</p>}
        <div className="flex justify-end gap-2">
          <button type="button" onClick={onCancel} className={`${btn} rounded-[10px] px-4 py-2.5 text-sm`} style={{ border: '1px solid rgba(127,178,255,0.25)' }}>{t('common.cancel')}</button>
          <button type="submit" disabled={!ok} className={`${btn} rounded-[10px] px-[18px] py-2.5 text-sm font-semibold disabled:opacity-40`} style={{ background: C.blue }}>{action}</button>
        </div>
      </form>
    </Modal>
  )
}

function Confirm({ text, action, onCancel, onOk }: { text: string; action: string; onCancel: () => void; onOk: () => void }) {
  return (
    <Modal label={action}>
      <h2 className="m-0 text-[19px] font-bold">{action}</h2>
      <p className="m-0 text-sm" style={{ color: C.soft }}>{text}</p>
      <div className="flex justify-end gap-2">
        <button type="button" autoFocus onClick={onCancel} className={`${btn} rounded-[10px] px-4 py-2.5 text-sm`} style={{ border: '1px solid rgba(127,178,255,0.25)' }}>{t('common.cancel')}</button>
        <button type="button" onClick={onOk} className={`${btn} rounded-[10px] px-[18px] py-2.5 text-sm font-semibold`} style={{ background: '#B42318' }}>{action}</button>
      </div>
    </Modal>
  )
}

// App Center (G08 browse, G09 app detail, G10 install from file). The organization's catalog through the package
// service (WSOS-APP-001/002), the user's AppImages (WSOS-AIM-001…004), local .deb files (WSOS-APT-005) and Flatpak
// permissions (WSOS-FLP-002…004). Nothing here is sample data: what the services don't report is left out or says so.
import { AnimatedProgress, CountUp } from '../components/AnimatedProgress'
import { useEffect, useMemo, useState } from 'react'
import type { WindowProps } from './types'
import { C, card, Dialog, dialogFooter, btnGhost, btnPrimary, Svg, Switch } from '../components/Dk'
import { formatBytes, os, packageErrorText, type AppCatalog, type AppImageRecord, type AppPermissions, type InstalledApp, type LocalDebPreview, type PackageJobEvent, type PackagePreview } from '../lib/os'
import { buildApps, catalogNotice, categories, filterApps, SOURCES, type AppView, type Section } from '../lib/appcatalog'
import { appColor, detailSecurity, expandPermissions, featuredApp, formatLabel, launchIdFor } from '../lib/appdetail'
import { formatNumber, t, useT, type MessageKey } from '../i18n'

type Level = 'Review' | 'Broad'
interface Perm { title: string; detail: string; level: Level }

/** Flatpak metadata permission ("key=value") → a line people can read (WSOS-FLP-002). */
function describePermission(p: string, broad: boolean): Perm {
  const [k, v = ''] = p.split('=')
  const vals = v.split(';').filter(Boolean)
  const level: Level = broad ? 'Broad' : 'Review'
  if (k === 'shared' && vals.includes('network')) return { title: t('appc.perm.network'), detail: p, level }
  if (k === 'filesystems') return { title: vals.some((x) => /^(home|host)/.test(x)) ? t('appc.perm.home') : t('appc.perm.files', { paths: vals.join(', ') }), detail: p, level }
  if (k === 'sockets' && vals.includes('x11')) return { title: t('appc.perm.x11'), detail: t('appc.perm.x11Hint'), level }
  if (k === 'sockets' && vals.includes('session-bus')) return { title: t('appc.perm.bus'), detail: p, level }
  if (k === 'sockets' && vals.includes('pulseaudio')) return { title: t('appc.perm.sound'), detail: p, level }
  if (k === 'sockets' && vals.some((x) => x === 'wayland' || x === 'fallback-x11')) return { title: t('appc.perm.windows'), detail: p, level }
  if (k === 'shared' && vals.includes('ipc')) return { title: t('appc.perm.ipc'), detail: p, level }
  if (k === 'devices') return { title: vals.includes('all') ? t('appc.perm.allDevices') : t('appc.perm.devices', { list: vals.join(', ') }), detail: p, level }
  return { title: p, detail: t('appc.perm.declared'), level }
}

const initials = (name: string) => name.split(/[\s.-]+/).filter(Boolean).slice(0, 1).map((w) => w[0]!.toUpperCase()).join('') || '?'
const errText = (e: string) => (e === 'cancelled' ? '' : packageErrorText(e))
type Op = 'install' | 'remove' | 'update' | 'reset' | 'prune'
type View = { kind: 'section'; section: Section; category: string } | { kind: 'detail'; key: string }

function AppIcon({ a, size, radius, font }: { a: Pick<AppView, 'name'>; size: number; radius: number; font: number }) {
  return <span aria-hidden="true" className="flex flex-none items-center justify-center font-bold text-white" style={{ width: size, height: size, borderRadius: radius, fontSize: font, background: appColor(a.name) }}>{initials(a.name)}</span>
}

export default function AppCenter({ onClose }: WindowProps) {
  useT()
  const [view, setView] = useState<View>({ kind: 'section', section: 'discover', category: 'All' })
  const [query, setQuery] = useState('')
  const [catalog, setCatalog] = useState<AppCatalog | null>(null)
  const [catalogError, setCatalogError] = useState<string | null>(null)
  const [appimages, setAppimages] = useState<AppImageRecord[]>([])
  const loadCatalog = () => {
    setCatalog(null); setCatalogError(null)
    void os.pkgCatalog().then((r) => { if (r.ok) setCatalog(r.value); else setCatalogError(packageErrorText(r.error)) })
    void os.appimageList().then((r) => { if (r.ok) setAppimages(r.value) })
  }
  useEffect(loadCatalog, [])
  const [installedApps, setInstalledApps] = useState<InstalledApp[]>([])
  const [office, setOffice] = useState(false)
  useEffect(() => { void os.installedApps().then((r) => { setOffice(!!r.office); setInstalledApps(r.apps) }).catch(() => {}) }, [])
  const [org, setOrg] = useState<string | null>(null)
  useEffect(() => { void os.deviceInfo().then((d) => setOrg(d.org_name)).catch(() => {}) }, [])
  const apps = useMemo(() => buildApps(catalog, appimages, office), [catalog, appimages, office])
  const notice0 = catalogNotice(catalog, catalogError)

  const [available, setAvailable] = useState<{ packages: string[]; flatpaks: string[]; reboot: boolean } | null>(null)
  const [updatesError, setUpdatesError] = useState<string | null>(null)
  const loadUpdates = () => void os.pkgCheckUpdates().then((r) => {
    if (r.ok) { setAvailable({ packages: r.value.packages, flatpaks: r.value.flatpaks, reboot: r.value.reboot_required }); setUpdatesError(null) }
    else setUpdatesError(packageErrorText(r.error))
  })
  useEffect(loadUpdates, [])
  const pending = available ? [...available.packages.map((n) => `apt:${n}`), ...available.flatpaks.map((n) => `flatpak:${n}`)] : []
  const updates = new Set(pending)
  const otherUpdates = pending.filter((id) => !apps.some((a) => a.catalogId === id))

  const [review, setReview] = useState<AppView | null>(null)
  const [busy, setBusy] = useState(false)
  const [preview, setPreview] = useState<{ loading: boolean; data?: PackagePreview; error?: string }>({ loading: false })
  const [deb, setDeb] = useState<{ loading: boolean; name: string; data?: LocalDebPreview; error?: string } | null>(null)
  const [aiConfirm, setAiConfirm] = useState<{ record: AppImageRecord; file: string } | null>(null)
  const [fileMenu, setFileMenu] = useState(false)
  const [jobs, setJobs] = useState<Record<string, { name: string; op: Op; key?: string }>>({})
  const [progress, setProgress] = useState<Record<string, number>>({})
  const [notice, setNotice] = useState<{ text: string; error?: boolean } | null>(null)
  const say = (text: string, error = false) => { if (text) setNotice({ text, error }) }

  useEffect(() => os.onPkgJob((e: PackageJobEvent) => {
    if (e.kind === 'progress') { setProgress((p) => ({ ...p, [e.job]: e.percent ?? 0 })); return }
    setJobs((all) => {
      const j = all[e.job]
      if (!j) return all
      const { [e.job]: _done, ...rest } = all
      if (e.result === 'success') {
        setNotice({ text: j.op === 'install' ? t('appc.done.installed', { name: j.name }) : j.op === 'remove' ? t('appc.done.removed', { name: j.name }) : j.op === 'reset' ? t('appc.done.reset', { name: j.name }) : j.op === 'prune' ? t('appc.done.pruned') : t('appc.done.updates') })
        loadCatalog(); if (j.op === 'update') loadUpdates()
      } else setNotice({ text: `${j.name}: ${packageErrorText(e.error ?? 'failed')}`, error: true })
      return rest
    })
  }), [])
  const jobFor = (a: AppView) => Object.entries(jobs).find(([, j]) => j.key === a.key || j.name === a.name)
  const track = (job: string, name: string, op: Op, key?: string) => setJobs((j) => ({ ...j, [job]: { name, op, key } }))

  useEffect(() => {
    if (!review?.catalogId) { setPreview({ loading: false }); return }
    let live = true
    setPreview({ loading: true })
    void os.pkgPreview(review.catalogId, 'install').then((r) => { if (live) setPreview(r.ok ? { loading: false, data: r.value } : { loading: false, error: packageErrorText(r.error) }) })
    return () => { live = false }
  }, [review])

  const section = view.kind === 'section' ? view.section : 'discover'
  const category = view.kind === 'section' ? view.category : 'All'
  const allSources = useMemo(() => new Set(SOURCES.map((s) => s.id)), [])
  const list = filterApps(apps, { section, sources: allSources, category, query, updates })
  const cats = categories(apps).filter((c) => c !== 'All')
  const featured = section === 'discover' && category === 'All' && !query ? featuredApp(apps) : null

  const start = async (a: AppView, op: 'install' | 'remove') => {
    if (!a.catalogId) return
    setBusy(true); setNotice(null)
    const r = op === 'install' ? await os.pkgInstall(a.catalogId) : await os.pkgRemove(a.catalogId)
    setBusy(false)
    if (!r.ok) { say(`${a.name}: ${packageErrorText(r.error)}`, true); return }
    track(r.value, a.name, op, a.key); setReview(null)
  }
  const updateAll = async () => {
    setNotice(null)
    const r = await os.pkgApplyUpdate()
    if (!r.ok) { say(`${t('settings.nav.Updates')}: ${packageErrorText(r.error)}`, true); return }
    track(r.value, t('settings.nav.Updates'), 'update')
  }
  const updating = Object.values(jobs).some((j) => j.op === 'update')

  // ---- AppImage (G10): imported into the user's store unapproved, confirmed here, removed again on Cancel ----
  const pickAppImage = async () => {
    setNotice(null); setFileMenu(false)
    const f = await os.pickFile('appimage')
    if (!f.ok) { say(errText(f.error), true); return }
    const r = await os.appimageImport(f.value.handle)
    if (!r.ok) { say(`${f.value.name}: ${packageErrorText(r.error)}`, true); return }
    setAiConfirm({ record: r.value, file: f.value.name })
    loadCatalog()
  }
  const aiDecide = async (allow: boolean) => {
    if (!aiConfirm) return
    const { record } = aiConfirm
    setBusy(true)
    const r = allow ? await os.appimageApprove(record.id) : await os.appimageRemove(record.id)
    setBusy(false); setAiConfirm(null)
    if (allow) say(r.ok ? t('appc.allowed', { name: record.name }) : `${record.name}: ${packageErrorText(r.error)}`, !r.ok)
    loadCatalog()
  }
  const appimageAct = async (a: AppView, op: 'approve' | 'remove' | 'update' | 'open') => {
    const id = a.appimageId!
    setNotice(null)
    if (op === 'update') {
      const f = await os.pickFile('appimage')
      if (!f.ok) { say(errText(f.error), true); return }
      const r = await os.appimageUpdate(id, f.value.handle)
      say(r.ok ? t('appc.updated', { name: a.name }) : `${a.name}: ${packageErrorText(r.error)}`, !r.ok)
    } else {
      const r = op === 'approve' ? await os.appimageApprove(id) : op === 'remove' ? await os.appimageRemove(id) : await os.appimageLaunch(id)
      say(r.ok ? (op === 'approve' ? t('appc.allowed', { name: a.name }) : op === 'remove' ? t('appc.aiRemoved', { name: a.name }) : '') : `${a.name}: ${packageErrorText(r.error)}`, !r.ok)
      if (op === 'remove' && r.ok) setView({ kind: 'section', section: 'installed', category: 'All' })
    }
    loadCatalog()
  }

  // ---- local .deb (G10, WSOS-APT-005) ----
  const pickDeb = async () => {
    setNotice(null); setFileMenu(false)
    const f = await os.pickFile('deb')
    if (!f.ok) { say(errText(f.error), true); return }
    setDeb({ loading: true, name: f.value.name })
    const r = await os.localDebPreview(f.value.handle)
    setDeb(r.ok ? { loading: false, name: f.value.name, data: r.value } : { loading: false, name: f.value.name, error: packageErrorText(r.error) })
  }
  const installDeb = async () => {
    if (!deb?.data) return
    setBusy(true)
    const r = await os.localDebInstall(deb.data.token)
    setBusy(false)
    if (!r.ok) { setDeb({ ...deb, error: packageErrorText(r.error) }); return }
    track(r.value, deb.data.package, 'install'); setDeb(null)
  }
  const prune = async () => {
    const r = await os.pruneRuntimes()
    if (!r.ok) { say(packageErrorText(r.error), true); return }
    track(r.value, t('appc.runtimes'), 'prune')
  }

  const openApp = (a: AppView) => {
    if (a.builtin === 'office') { void os.launchOffice('start'); return }
    if (a.appimageId) { void appimageAct(a, 'open'); return }
    const id = launchIdFor(a, installedApps)
    if (id) void os.launchApp(id)
  }
  const cta = (a: AppView): { label: string; act?: () => void; primary?: boolean; disabled?: boolean } => {
    if (a.builtin === 'office') return { label: t('common.open'), act: () => openApp(a) }
    if (jobFor(a)) return { label: t('appc.working'), disabled: true }
    if (a.appimageId) return a.needsApproval ? { label: t('appc.allow'), act: () => void appimageAct(a, 'approve'), primary: true } : { label: t('common.open'), act: () => openApp(a) }
    if (a.blocked) return { label: t('common.unavailable'), disabled: true }
    if (a.catalogId && updates.has(a.catalogId)) return updating ? { label: t('appc.updating'), disabled: true } : { label: t('appc.update'), act: () => void updateAll(), primary: true }
    if (a.source === 'AppImage') return { label: t('appc.importFile'), act: () => void pickAppImage(), primary: true }
    if (a.installed) return launchIdFor(a, installedApps) ? { label: t('common.open'), act: () => openApp(a) } : { label: t('appc.details'), act: () => setView({ kind: 'detail', key: a.key }) }
    return { label: t('common.install'), act: () => setReview(a), primary: true }
  }

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape' || busy || review || deb || aiConfirm) return
      if (fileMenu) setFileMenu(false)
      else if (view.kind === 'detail') setView({ kind: 'section', section: 'discover', category: 'All' })
      else onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [busy, review, deb, aiConfirm, fileMenu, view, onClose])

  const navBtn = (label: string, on: boolean, go: () => void, count?: number) => (
    <button key={label} type="button" aria-current={on ? 'page' : undefined} onClick={go}
      className="flex cursor-pointer items-center rounded-lg px-2.5 py-2 text-left text-[13px] hover:bg-white/[0.05]"
      style={{ background: on ? 'rgba(31,107,255,0.2)' : undefined, color: on ? '#FFFFFF' : C.soft, fontWeight: on ? 600 : 400 }}>
      {label}{count ? <span className="ml-auto text-[11px]" style={{ color: C.dim }}>{formatNumber(count)}</span> : null}
    </button>
  )
  const isSec = (s: Section, c = 'All') => view.kind === 'section' && view.section === s && view.category === c
  const detailApp = view.kind === 'detail' ? apps.find((a) => a.key === view.key) ?? null : null

  const appCard = (a: AppView) => {
    const c = cta(a)
    const job = jobFor(a)
    return (
      <div key={a.key} className={`${card} relative flex items-center gap-3 p-3.5`}>
        <button type="button" onClick={() => setView({ kind: 'detail', key: a.key })} aria-label={t('appc.detailsOf', { name: a.name })} className="absolute inset-0 cursor-pointer rounded-[14px] hover:bg-white/[0.03]" />
        <AppIcon a={a} size={46} radius={12} font={18} />
        <span className="pointer-events-none relative flex min-w-0 flex-1 flex-col gap-[3px]">
          <span className="truncate text-sm font-semibold">{a.name}</span>
          <span className="flex items-center gap-1.5 text-[11px]" style={{ color: C.muted }}>
            <span className="rounded px-[5px] py-px font-mono text-[9px]" style={{ background: 'rgba(127,178,255,0.14)', color: C.soft }}>{formatLabel(a.source)}</span>
            <span className="truncate">{a.needsApproval ? t('appc.needsApproval') : a.blocked ?? a.category}</span>
          </span>
          {job && <AnimatedProgress className="mt-[3px]" value={progress[job[0]] ?? null} label={a.name} height={4} />}
        </span>
        <button type="button" disabled={c.disabled} onClick={c.act} aria-label={t('appc.ctaLabel', { action: c.label, name: a.name })}
          className="relative cursor-pointer rounded-lg border px-3 py-[7px] text-xs font-semibold disabled:cursor-default disabled:opacity-60"
          style={{ borderColor: c.primary ? C.blue : 'rgba(127,178,255,0.25)', background: c.primary ? C.blue : 'transparent' }}>{c.label}</button>
      </div>
    )
  }

  return (
    <div role="dialog" aria-modal="false" aria-label={t('launcher.appCenter')} className="fixed inset-x-0 top-0 bottom-[52px] z-50 flex font-sans" style={{ background: '#0A1A3D', color: C.ink }}>
      <nav aria-label={t('appc.sections')} className="box-border flex w-[220px] shrink-0 flex-col gap-0.5 overflow-auto border-r px-3 py-[18px]" style={{ background: '#071330', borderColor: 'rgba(127,178,255,0.12)' }}>
        <div className="flex items-center gap-2.5 px-2 pt-1 pb-4"><span aria-hidden="true" className="flex size-[26px] items-center justify-center rounded-[7px] text-[13px] font-bold" style={{ background: C.blue }}>A</span><span className="text-[15px] font-semibold">{t('launcher.appCenter')}</span></div>
        {navBtn(t('appc.discover'), isSec('discover'), () => setView({ kind: 'section', section: 'discover', category: 'All' }))}
        {cats.map((c) => navBtn(c, isSec('discover', c), () => setView({ kind: 'section', section: 'discover', category: c }), apps.filter((a) => a.category === c).length))}
        {navBtn(t('common.installed'), isSec('installed'), () => setView({ kind: 'section', section: 'installed', category: 'All' }), apps.filter((a) => a.installed).length)}
        {navBtn(t('settings.nav.Updates'), isSec('updates'), () => setView({ kind: 'section', section: 'updates', category: 'All' }), pending.length)}
        <span className="relative">
          <button type="button" aria-haspopup="menu" aria-expanded={fileMenu} onClick={() => setFileMenu((v) => !v)} className="flex w-full cursor-pointer items-center rounded-lg px-2.5 py-2 text-left text-[13px] hover:bg-white/[0.05]" style={{ color: C.soft }}>{t('appc.fromFile')}</button>
          {fileMenu && (
            <div role="menu" className="absolute top-full left-0 z-10 mt-1 flex w-[200px] flex-col rounded-xl border border-[rgba(127,178,255,0.2)] bg-[#0F2350] p-1 shadow-[0_16px_40px_rgba(0,0,0,0.5)]">
              <button type="button" role="menuitem" onClick={() => void pickDeb()} className="cursor-pointer rounded-lg px-3 py-2 text-left text-[13px] hover:bg-white/[0.07]">{t('appc.fileDeb')}</button>
              <button type="button" role="menuitem" onClick={() => void pickAppImage()} className="cursor-pointer rounded-lg px-3 py-2 text-left text-[13px] hover:bg-white/[0.07]">{t('appc.fileAppImage')}</button>
            </div>
          )}
        </span>
        {catalog && <div className="mt-auto px-2.5 pt-4 text-[11px] leading-normal" style={{ color: C.dim }}>{catalog.state === 'ok' ? t('appc.orgApproved') : t('appc.noCatalog')} {t('appc.device', { arch: catalog.arch })}</div>}
      </nav>

      <main className="relative flex min-w-0 flex-1 flex-col gap-[18px] overflow-auto px-7 py-[22px]" style={{ background: 'radial-gradient(ellipse 80% 50% at 80% 0%, var(--ws-g-glow) 0%, var(--ws-g-page) 60%)' }}>
        <button type="button" aria-label={t('common.close')} onClick={onClose} className="absolute top-[22px] right-5 z-10 flex size-10 cursor-pointer items-center justify-center rounded-[10px] hover:bg-white/10" style={{ color: C.soft }}><Svg d="M6 6l12 12M18 6L6 18" size={16} /></button>
        {notice && (
          <div role="status" className="mr-12 flex items-center gap-3 rounded-xl px-4 py-2.5 text-[13px]" style={{ background: notice.error ? 'rgba(255,138,122,0.12)' : 'rgba(95,211,154,0.12)', color: notice.error ? '#FFB4A8' : '#BFF0D6' }}>
            <span className="grow">{notice.text}</span>
            <button type="button" aria-label={t('common.dismiss')} onClick={() => setNotice(null)} className="cursor-pointer opacity-70 hover:opacity-100"><Svg d="M6 6l12 12M18 6L6 18" size={14} /></button>
          </div>
        )}

        {view.kind === 'detail' ? (
          detailApp ? <AppDetail a={detailApp} org={org} launchable={!!launchIdFor(detailApp, installedApps) || !!detailApp.appimageId || detailApp.builtin === 'office'}
            job={!!jobFor(detailApp)} onBack={() => setView({ kind: 'section', section: 'discover', category: 'All' })} onOpen={() => openApp(detailApp)}
            onInstall={() => setReview(detailApp)} onRemove={() => (detailApp.appimageId ? void appimageAct(detailApp, 'remove') : void start(detailApp, 'remove'))}
            onApprove={() => void appimageAct(detailApp, 'approve')} onTracked={(job, op) => track(job, detailApp.name, op, detailApp.key)} say={say} />
            : <p className="text-sm" style={{ color: C.muted }}>{t('appc.noMatch')}</p>
        ) : <>
          <label className="mr-12 box-border flex h-10 shrink-0 items-center gap-2 rounded-[10px] border px-3.5 text-[13px] focus-within:border-[#1F6BFF]" style={{ background: 'rgba(4,10,26,0.5)', borderColor: 'rgba(127,178,255,0.14)', color: C.muted }}>
            <Svg d="M11 4a7 7 0 1 0 0 14 7 7 0 0 0 0-14zM20 20l-4-4" size={15} width={2.2} />
            <input type="text" value={query} onChange={(e) => setQuery(e.target.value)} placeholder={apps.length ? t('appc.searchN', { count: formatNumber(apps.length) }) : t('appc.search')} aria-label={t('appc.search')}
              className="grow border-0 bg-transparent text-[13px] text-[#E8EEFA] outline-none placeholder:text-[#8FA3C8] focus-visible:shadow-none focus-visible:outline-none" />
          </label>

          {featured && (
            <div className="box-border flex h-[150px] shrink-0 items-center gap-[22px] rounded-2xl px-[26px] py-[22px]" style={{ background: 'radial-gradient(circle at 85% 30%, rgba(24,212,240,0.4), transparent 50%), linear-gradient(120deg, #1F4FB0, #0D2353)' }}>
              <AppIcon a={featured} size={84} radius={20} font={34} />
              <span className="flex min-w-0 flex-1 flex-col gap-1.5">
                <span className="font-mono text-[11px] tracking-[0.08em] uppercase" style={{ color: '#D6F7FF' }}>{org ? t('appc.approvedBy', { org }) : t('appc.approvedByOrg')}</span>
                <span className="text-2xl font-bold">{featured.name}</span>
                <span className="truncate text-[13px]" style={{ color: '#DCE7FF' }}>{[featured.summary || featured.category, formatLabel(featured.source), featured.source === 'Flatpak' ? t('appc.sandboxed') : null].filter(Boolean).join(' · ')}</span>
              </span>
              <button type="button" onClick={() => setReview(featured)} className="cursor-pointer rounded-[10px] bg-white px-[22px] py-[11px] text-sm font-bold text-[#0A1A3D] hover:bg-[#E8EEFA]">{t('common.install')}</button>
            </div>
          )}

          {Object.entries(jobs).filter(([, j]) => !j.key).map(([path, j]) => (
            <div key={path} aria-live="polite" className={`${card} flex items-center gap-3 px-4 py-2.5 text-[13px]`}>
              <span className="grow">{j.op === 'update' ? t('appc.job.updates') : j.op === 'prune' ? t('appc.job.prune') : t('appc.job.install', { name: j.name })}</span>
              <AnimatedProgress className="w-40" value={progress[path] ?? null} label={j.name} height={6} />
            </div>
          ))}

          {section === 'updates' && (
            <div className={`${card} flex flex-col gap-2 px-4 py-3 text-[13px]`}>
              <div className="flex items-center gap-3">
                <span className="grow">
                  {updatesError ? updatesError : !available ? t('appc.checking') : pending.length === 0 ? t('appc.upToDate') : t('appc.available', { count: formatNumber(pending.length) })}
                  {available?.reboot && ` ${t('appc.reboot')}`}
                </span>
                {pending.length > 0 && <button type="button" disabled={updating} onClick={() => void updateAll()} className={btnPrimary}>{updating ? t('appc.updating') : t('appc.updateAll')}</button>}
              </div>
              {otherUpdates.length > 0 && (
                <details style={{ color: C.muted }}>
                  <summary className="cursor-pointer">{t('appc.systemPackages', { count: formatNumber(otherUpdates.length) })}</summary>
                  <ul className="m-0 mt-2 columns-3 pl-5 font-mono text-[12px]">{otherUpdates.map((id) => <li key={id}>{id.split(':')[1]}</li>)}</ul>
                </details>
              )}
            </div>
          )}

          <div className="flex items-baseline justify-between">
            <h2 className="m-0 text-base font-semibold">{section === 'installed' ? t('common.installed') : section === 'updates' ? t('settings.nav.Updates') : category !== 'All' ? category : t('appc.forYourWork')}</h2>
            {section === 'installed' && apps.some((a) => a.installed && a.source === 'Flatpak') && <button type="button" onClick={() => void prune()} disabled={Object.values(jobs).some((j) => j.op === 'prune')} className="cursor-pointer text-xs text-[#7FB2FF] hover:text-[#B8D4FF] disabled:opacity-50">{t('appc.prune')}</button>}
          </div>
          {notice0 && !apps.length && (
            <div role="status" className={`${card} flex items-center gap-3 border-dashed px-4 py-6 text-sm`} style={{ color: C.soft }}>
              <span className="grow">{notice0.text}</span>
              {notice0.retry && <button type="button" onClick={loadCatalog} className={btnGhost}>{t('common.tryAgain')}</button>}
            </div>
          )}
          {list.length ? <div className="grid grid-cols-3 gap-3">{list.map(appCard)}</div>
            : !notice0 || apps.length ? <p className="m-0 text-sm" style={{ color: C.muted }}>{t('appc.noMatch')}</p> : null}
        </>}
      </main>

      {review && (
        <Dialog width={600} onClose={busy ? undefined : () => setReview(null)} label={t('appc.reviewOf', { name: review.name })}>
          {() => <>
            <div className="flex items-center gap-[18px] border-b border-[rgba(127,178,255,0.12)] p-6">
              <AppIcon a={review} size={60} radius={14} font={24} />
              <div className="flex flex-1 flex-col gap-1"><h2 className="m-0 text-xl font-bold">{t('appc.installQ', { name: review.name })}</h2><span className="font-mono text-xs" style={{ color: C.muted }}>{review.catalogId?.split(':')[1]} · {t('appc.forEveryone')}</span></div>
              <span className="rounded-md px-2 py-1 font-mono text-[11px]" style={{ background: 'rgba(127,178,255,0.14)' }}>{formatLabel(review.source)}</span>
            </div>
            <div className="flex flex-col gap-3 px-6 py-[18px]">
              {(preview.data?.permissions.length ?? 0) > 0 && (
                <div className="overflow-hidden rounded-xl" style={{ background: 'rgba(4,10,26,0.45)' }}>
                  <div className="px-3.5 pt-2.5 pb-1 text-[11px] tracking-[0.06em] uppercase" style={{ color: C.muted }}>{t('appc.ableTo')}</div>
                  {preview.data!.permissions.map((p) => describePermission(p, preview.data!.broad.includes(p))).map((p) => (
                    <div key={p.detail + p.title} className="flex items-center gap-2.5 border-t border-[rgba(127,178,255,0.08)] px-3.5 py-2 text-[13px]">
                      <span aria-hidden="true" className="size-2 rounded-full" style={{ background: p.level === 'Broad' ? C.amber : C.link }} />
                      <span className="flex-1">{p.title}</span><span className="text-[11px]" style={{ color: p.level === 'Broad' ? C.amber : C.muted }}>{t(`appc.level.${p.level}` as MessageKey)}</span>
                    </div>
                  ))}
                </div>
              )}
              <Rows rows={[
                [t('appc.disk'), preview.loading ? '…' : preview.data ? formatBytes(preview.data.disk_bytes) : '—'],
                [t('appc.alsoInstalls'), preview.loading ? '…' : preview.data ? (preview.data.plan.install.length > 1 ? t('appc.packages', { count: formatNumber(preview.data.plan.install.length - 1) }) : t('appc.nothingElse')) : '—'],
                [t('appc.removes'), preview.loading ? '…' : preview.data ? (preview.data.plan.remove.length ? preview.data.plan.remove.map((c) => c.name).join(', ') : t('appc.nothing')) : '—'],
              ]} />
            </div>
            <div className={`${dialogFooter} justify-between`}>
              <span className="text-xs" style={{ color: preview.error ? C.red : C.muted }} aria-live="polite">{busy ? t('appc.waitingApproval') : preview.error ?? (preview.loading ? t('appc.checkingPkg') : t('appc.allowedPolicy'))}</span>
              <span className="flex gap-2.5">
                <button type="button" disabled={busy} onClick={() => setReview(null)} className={btnGhost}>{t('common.cancel')}</button>
                <button type="button" disabled={busy || preview.loading || !!preview.error} onClick={() => void start(review, 'install')} className={btnPrimary}>{busy ? t('common.installing') : t('common.install')}</button>
              </span>
            </div>
          </>}
        </Dialog>
      )}

      {deb && (
        <Dialog width={600} onClose={busy ? undefined : () => setDeb(null)} label={t('appc.debLabel', { name: deb.name })}>
          {() => <>
            <div className="flex items-center gap-[18px] border-b border-[rgba(127,178,255,0.12)] p-6">
              <AppIcon a={{ name: deb.data?.package ?? deb.name }} size={60} radius={14} font={24} />
              <div className="flex min-w-0 flex-1 flex-col gap-1"><h2 className="m-0 text-xl font-bold">{t('appc.installQ', { name: deb.data?.package ?? deb.name })}</h2><span className="truncate font-mono text-xs" style={{ color: C.muted }}>{deb.name}</span></div>
              <span className="rounded-md px-2 py-1 font-mono text-[11px]" style={{ background: 'rgba(127,178,255,0.14)' }}>{formatLabel('APT')}</span>
            </div>
            <div className="flex flex-col gap-3 px-6 py-[18px]">
              <Warn text={t('appc.debWarn')} />
              {deb.data && <Rows rows={[
                [t('appc.publisher'), `${deb.data.publisher} ${t('appc.notVerified')}`, C.amber],
                [t('appc.versionLabel'), deb.data.version],
                [t('appc.size'), formatBytes(deb.data.disk_bytes)],
                [t('appc.alsoInstalls'), (() => { const n = deb.data!.plan.install.filter((c) => c.name !== deb.data!.package).length; return n ? t('appc.fromRepos', { count: formatNumber(n) }) : t('appc.nothingElse') })()],
                ...(deb.data.plan.remove.length ? [[t('appc.removes'), deb.data.plan.remove.map((c) => c.name).join(', '), C.amber] as [string, string, string]] : []),
                ['SHA-256', `${deb.data.token.slice(0, 16)}…`],
              ]} />}
            </div>
            <div className={`${dialogFooter} justify-between`}>
              <span className="text-xs" style={{ color: deb.error ? C.red : C.muted }} aria-live="polite">{busy ? t('appc.waitingApproval') : deb.error ?? (deb.loading ? t('appc.checkingApt') : t('appc.needsAdmin'))}</span>
              <span className="flex gap-2.5">
                <button type="button" disabled={busy} onClick={() => setDeb(null)} className={btnGhost}>{t('common.cancel')}</button>
                <button type="button" disabled={busy || deb.loading || !deb.data} onClick={() => void installDeb()} className={btnPrimary}>{t('common.install')}</button>
              </span>
            </div>
          </>}
        </Dialog>
      )}

      {aiConfirm && (
        <Dialog width={600} onClose={busy ? undefined : () => void aiDecide(false)} label={t('appc.installQ', { name: aiConfirm.record.name })}>
          {() => {
            const r = aiConfirm.record
            const sig = r.signature
            return <>
              <div className="flex items-center gap-[18px] border-b border-[rgba(127,178,255,0.12)] p-6">
                <AppIcon a={r} size={60} radius={14} font={24} />
                <div className="flex min-w-0 flex-1 flex-col gap-1"><h2 className="m-0 text-xl font-bold">{t('appc.installQ', { name: r.name })}</h2><span className="truncate font-mono text-xs" style={{ color: C.muted }}>{aiConfirm.file}</span></div>
                <span className="rounded-md px-2 py-1 font-mono text-[11px]" style={{ background: 'rgba(127,178,255,0.14)' }}>{formatLabel('AppImage')}</span>
              </div>
              <div className="flex flex-col gap-3 px-6 py-[18px]">
                <Warn text={t('appc.aiWarn')} />
                <Rows rows={[
                  [t('appc.publisher'), sig.status === 'signed' ? (sig.trusted ? t('appc.sigTrusted') : t('appc.sigValid')) : sig.status === 'invalid' ? t('appc.sigInvalid') : t('appc.sigNone'), sig.status === 'signed' ? C.green : C.amber],
                  [t('appc.versionLabel'), r.version ?? '—'],
                  [t('appc.size'), formatBytes(r.size)],
                  [t('appc.installsTo'), t('appc.justForYou')],
                  ['SHA-256', `${r.sha256.slice(0, 16)}…`],
                ]} />
              </div>
              <div className={`${dialogFooter} justify-between`}>
                <span className="text-xs" style={{ color: C.muted }}>{t('appc.noAdmin')}</span>
                <span className="flex gap-2.5">
                  <button type="button" disabled={busy} onClick={() => void aiDecide(false)} className={btnGhost}>{t('common.cancel')}</button>
                  <button type="button" disabled={busy || sig.status === 'invalid'} onClick={() => void aiDecide(true)} className={btnPrimary}>{t('appc.installForMe')}</button>
                </span>
              </div>
            </>
          }}
        </Dialog>
      )}
    </div>
  )
}

function Warn({ text }: { text: string }) {
  return (
    <div className="flex gap-3 rounded-xl border px-3.5 py-3 text-[13px] leading-[1.45]" style={{ background: 'rgba(255,159,90,0.08)', borderColor: 'rgba(255,159,90,0.35)' }}>
      <Svg d="M12 3l10 18H2zM12 10v5M12 18h.01" size={18} stroke="#FFB98A" className="flex-none" /><span>{text}</span>
    </div>
  )
}

function Rows({ rows }: { rows: ([string, string] | [string, string, string])[] }) {
  return (
    <dl className="m-0 overflow-hidden rounded-xl" style={{ background: 'rgba(4,10,26,0.45)' }}>
      {rows.map(([k, v, c]) => (
        <div key={k} className="flex justify-between gap-4 border-t border-[rgba(127,178,255,0.08)] px-3.5 py-[9px] text-[13px] first:border-t-0">
          <dt style={{ color: C.muted }}>{k}</dt><dd className="m-0 min-w-0 truncate text-right font-mono text-xs" style={{ color: c ?? C.ink }}>{v}</dd>
        </div>
      ))}
    </dl>
  )
}

/** G09: one app: open or remove, its permissions with per-permission switches (Flatpak), and what is known about its security. */
function AppDetail({ a, org, launchable, job, onBack, onOpen, onInstall, onRemove, onApprove, onTracked, say }: {
  a: AppView; org: string | null; launchable: boolean; job: boolean; onBack: () => void; onOpen: () => void; onInstall: () => void; onRemove: () => void; onApprove: () => void
  onTracked: (job: string, op: Op) => void; say: (text: string, error?: boolean) => void
}) {
  const flatpak = a.source === 'Flatpak' && a.installed && !!a.catalogId
  const [perms, setPerms] = useState<{ loading: boolean; data?: AppPermissions; off: string[]; error?: string }>({ loading: flatpak, off: [] })
  const load = () => {
    if (!flatpak) return
    setPerms((p) => ({ ...p, loading: true }))
    void Promise.all([os.appPermissions(a.catalogId!), os.appPermsUserOff ? os.appPermsUserOff(a.catalogId!) : Promise.resolve({ ok: true as const, value: [] as string[] })]).then(([r, off]) => {
      setPerms(r.ok ? { loading: false, data: r.value, off: off.ok ? off.value : [] } : { loading: false, off: [], error: packageErrorText(r.error) })
    })
  }
  useEffect(load, [a.key]) // eslint-disable-line react-hooks/exhaustive-deps
  const toggle = async (perm: string, on: boolean) => {
    if (!os.appPermSet) return
    const r = await os.appPermSet(a.catalogId!, perm, on)
    if (!r.ok) say(`${a.name}: ${packageErrorText(r.error)}`, true)
    load()
  }
  const reset = async () => {
    const r = await os.appPermissionsReset(a.catalogId!)
    if (!r.ok) { say(`${a.name}: ${packageErrorText(r.error)}`, true); return }
    onTracked(r.value, 'reset')
  }
  const removeData = async () => {
    if (!window.confirm(t('appc.confirmData', { name: a.name }))) return
    const r = await os.appDataRemove(a.catalogId!)
    say(r.ok ? (r.value ? t('appc.dataRemoved', { name: a.name }) : t('appc.noData', { name: a.name })) : `${a.name}: ${packageErrorText(r.error)}`, !r.ok)
  }
  const sec = detailSecurity(a, org)
  const entries = perms.data ? expandPermissions(perms.data.permissions, perms.data.broad) : []
  const removable = a.installed && !a.builtin && (!!a.catalogId || !!a.appimageId)

  return (
    <div className="flex min-h-0 flex-1 flex-col gap-[18px]">
      <button type="button" onClick={onBack} className="flex cursor-pointer items-center gap-1 self-start text-[13px] text-[#7FB2FF] hover:text-[#B8D4FF]"><Svg d="M15 6l-6 6 6 6" size={14} />{t('common.back')}</button>
      <div className="mr-12 flex items-center gap-5">
        <AppIcon a={a} size={76} radius={18} font={32} />
        <span className="flex min-w-0 flex-1 flex-col gap-1">
          <h2 className="m-0 text-[26px] font-bold">{a.name}</h2>
          <span className="truncate text-[13px]" style={{ color: C.muted }}>{[a.publisher, formatLabel(a.source), a.category].filter(Boolean).join(' · ')}</span>
        </span>
        {removable && <button type="button" disabled={job} onClick={onRemove} className="cursor-pointer rounded-[10px] border px-[18px] py-2.5 text-sm font-medium disabled:opacity-50" style={{ borderColor: 'rgba(255,138,122,0.45)', color: '#FFB4A8' }}>{t('common.remove')}</button>}
        {a.needsApproval ? <button type="button" onClick={onApprove} className={btnPrimary}>{t('appc.allow')}</button>
          : a.installed ? (launchable && <button type="button" onClick={onOpen} className={btnPrimary}>{t('common.open')}</button>)
          : !a.blocked && a.catalogId && <button type="button" disabled={job} onClick={onInstall} className={btnPrimary}>{job ? t('appc.working') : t('common.install')}</button>}
      </div>
      {a.summary && <p className="m-0 text-[13px]" style={{ color: C.soft }}>{a.summary}</p>}
      <div className="grid min-h-0 flex-1 grid-cols-2 gap-4">
        <div className="flex flex-col gap-2.5">
          <div className="flex items-center justify-between"><span className="text-[15px] font-semibold">{t('appc.permissions')}</span>
            {flatpak && <button type="button" onClick={() => void reset()} className="cursor-pointer rounded-lg border border-[rgba(127,178,255,0.25)] px-3 py-1.5 text-xs hover:bg-white/[0.06]">{t('appc.resetDefaults')}</button>}</div>
          <div className={`${card} overflow-hidden`}>
            {!flatpak ? <p className="m-0 px-4 py-3 text-[13px]" style={{ color: C.muted }}>{a.source === 'AppImage' ? t('appc.permsAppImage') : a.source === 'APT' ? t('appc.permsApt') : !a.installed ? t('appc.permsAfterInstall') : t('appc.permsBuiltin')}</p>
              : perms.loading && !perms.data ? <p className="m-0 px-4 py-3 text-[13px]" style={{ color: C.muted }}>{t('common.loading')}</p>
              : perms.error ? <p className="m-0 px-4 py-3 text-[13px]" style={{ color: C.red }}>{perms.error}</p>
              : !entries.length ? <p className="m-0 px-4 py-3 text-[13px]" style={{ color: C.muted }}>{t('appc.noPerms')}</p>
              : entries.map((e) => {
                const d = describePermission(e.perm, e.broad)
                const on = !perms.off.includes(e.perm)
                return (
                  <div key={e.perm} className="flex items-center gap-3 border-t border-[rgba(127,178,255,0.1)] px-4 py-[11px] first:border-t-0">
                    <span className="flex flex-1 flex-col gap-0.5"><span className="text-[13px] font-medium">{d.title}</span><span className="font-mono text-[11px]" style={{ color: e.broad ? C.amber : C.muted }}>{e.broad ? t('appc.broadHint', { perm: e.perm }) : e.perm}</span></span>
                    <Switch small label={d.title} checked={on} onChange={os.appPermSet ? (v) => void toggle(e.perm, v) : undefined} />
                  </div>
                )
              })}
          </div>
          {flatpak && <button type="button" onClick={() => void removeData()} className="cursor-pointer self-start text-xs text-[#FFB4A8] hover:text-[#FFD2CA]">{t('appc.removeData')}</button>}
        </div>
        <div className="flex flex-col gap-2.5">
          <span className="text-[15px] font-semibold">{t('appc.security')}</span>
          <div className={`${card} overflow-hidden`}>
            {sec.map((s) => (
              <div key={s.title} className="flex items-center gap-3 border-t border-[rgba(127,178,255,0.1)] px-4 py-3 first:border-t-0">
                <Svg d={s.icon} size={18} stroke={s.tone === 'ok' ? C.green : s.tone === 'warn' ? C.amber : C.muted} width={2.2} />
                <span className="flex flex-1 flex-col gap-0.5"><span className="text-[13px] font-medium">{s.title}</span><span className="text-[11px]" style={{ color: C.muted }}>{s.detail}</span></span>
              </div>
            ))}
          </div>
          <div className="flex flex-col gap-2 rounded-[14px] border border-[rgba(127,178,255,0.12)] px-4 py-3.5" style={{ background: 'rgba(4,10,26,0.5)' }}>
            <span className="text-[13px] font-semibold">{t('appc.sbom')}</span>
            <span className="text-xs" style={{ color: C.muted }}>{t('appc.sbomNone')}</span>
          </div>
        </div>
      </div>
    </div>
  )
}

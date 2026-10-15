import { useEffect, useState } from 'react'
import type { WindowProps } from './types'
import BWindow from '../components/BWindow'
import BIcon from '../components/BIcon'
import { formatBytes, os, packageErrorText, type AppCatalog, type AppImageRecord, type AppPermissions, type LocalDebPreview, type PackageJobEvent, type PackagePreview } from '../lib/os'
import { buildApps, catalogNotice, categories, filterApps, SOURCES, type AppView, type Section, type Source } from '../lib/appcatalog'

type Level = 'Review' | 'Broad'
interface Perm { title: string; detail: string; level: Level }
const LEVEL: Record<Level, { tag: string; dot: string }> = {
  Review: { tag: 'bg-[#fffbeb] text-[#b45309]', dot: 'bg-[#f59e0b]' },
  Broad: { tag: 'bg-[#fef2f2] text-[#b91c1c]', dot: 'bg-[#ef4444]' },
}

/** Flatpak metadata permission ("key=value") → a line for the review dialog (WSOS-FLP-002). */
function describePermission(p: string, broad: boolean): Perm {
  const [k, v = ''] = p.split('=')
  const vals = v.split(';').filter(Boolean)
  const level: Level = broad ? 'Broad' : 'Review'
  if (k === 'shared' && vals.includes('network')) return { title: 'Use the network', detail: p, level }
  if (k === 'filesystems') return { title: vals.some((x) => /^(home|host)/.test(x)) ? 'Access your home folder or whole computer' : `Access ${vals.join(', ')}`, detail: p, level }
  if (k === 'sockets' && vals.includes('x11')) return { title: 'Run as an X11 app (XWayland)', detail: 'Older apps can read input from other X11 windows', level }
  if (k === 'sockets' && vals.includes('session-bus')) return { title: 'Talk to any app on your session bus', detail: p, level }
  if (k === 'devices') return { title: vals.includes('all') ? 'Access all devices' : `Access devices: ${vals.join(', ')}`, detail: p, level }
  return { title: p, detail: 'Declared by the app', level }
}

const initials = (name: string) => name.split(/[\s.-]+/).filter(Boolean).slice(0, 2).map((w) => w[0]!.toUpperCase()).join('') || '?'
const errText = (e: string) => (e === 'cancelled' ? '' : packageErrorText(e))

export default function AppCenter({ onClose }: WindowProps) {
  const [section, setSection] = useState<Section>('discover')
  const [sources, setSources] = useState(() => new Set<Source>(SOURCES.map((s) => s.id)))
  const [category, setCategory] = useState('All')
  const [query, setQuery] = useState('')
  // WSOS-APP-001: the organization's catalog from the server, through the package service. No built-in apps.
  const [catalog, setCatalog] = useState<AppCatalog | null>(null)
  const [catalogError, setCatalogError] = useState<string | null>(null)
  const [appimages, setAppimages] = useState<AppImageRecord[]>([])
  const loadCatalog = () => {
    setCatalog(null); setCatalogError(null)
    void os.pkgCatalog().then((r) => { if (r.ok) setCatalog(r.value); else setCatalogError(packageErrorText(r.error)) })
    void os.appimageList().then((r) => { if (r.ok) setAppimages(r.value) })
  }
  useEffect(loadCatalog, [])
  const [office, setOffice] = useState(false)
  useEffect(() => { void os.installedApps().then((r) => setOffice(!!r.office)).catch(() => {}) }, [])
  const apps = buildApps(catalog, appimages, office)
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
  const [perms, setPerms] = useState<{ app: AppView; loading: boolean; data?: AppPermissions; error?: string } | null>(null)
  const [jobs, setJobs] = useState<Record<string, { name: string; op: 'install' | 'remove' | 'update' | 'reset' | 'prune' }>>({})
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
        setNotice({ text: j.op === 'install' ? `${j.name} is installed.` : j.op === 'remove' ? `${j.name} was removed.` : j.op === 'reset' ? `${j.name}: permissions reset.` : j.op === 'prune' ? 'Unused runtimes removed.' : 'Updates are installed.' })
        loadCatalog(); if (j.op === 'update') loadUpdates()
      } else setNotice({ text: `${j.name}: ${packageErrorText(e.error ?? 'failed')}`, error: true })
      return rest
    })
  }), [])
  const running = (name: string) => Object.values(jobs).some((j) => j.name === name)
  const track = (job: string, name: string, op: 'install' | 'remove' | 'update' | 'reset' | 'prune') => setJobs((j) => ({ ...j, [job]: { name, op } }))

  // WSOS-APP-002: dependency changes and disk space from the package service before confirming.
  useEffect(() => {
    if (!review?.catalogId) { setPreview({ loading: false }); return }
    let live = true
    setPreview({ loading: true })
    void os.pkgPreview(review.catalogId, 'install').then((r) => { if (live) setPreview(r.ok ? { loading: false, data: r.value } : { loading: false, error: packageErrorText(r.error) }) })
    return () => { live = false }
  }, [review])

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape' && !busy) { setReview(null); setDeb(null) } }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [busy])

  const list = filterApps(apps, { section, sources, category, query, updates })
  const toggleSource = (s: Source) => setSources((prev) => { const n = new Set(prev); if (n.has(s)) n.delete(s); else n.add(s); return n })

  const start = async (a: AppView, op: 'install' | 'remove') => {
    if (!a.catalogId) return
    setBusy(true); setNotice(null)
    const r = op === 'install' ? await os.pkgInstall(a.catalogId) : await os.pkgRemove(a.catalogId)
    setBusy(false)
    if (!r.ok) { say(`${a.name}: ${packageErrorText(r.error)}`, true); return }
    track(r.value, a.name, op); setReview(null)
  }
  const updateAll = async () => {
    setNotice(null)
    const r = await os.pkgApplyUpdate()
    if (!r.ok) { say(`Updates: ${packageErrorText(r.error)}`, true); return }
    track(r.value, 'Updates', 'update')
  }
  const updating = Object.values(jobs).some((j) => j.op === 'update')

  // ---- AppImages (WSOS-AIM-001…004) ----
  const importAppImage = async () => {
    setNotice(null)
    const f = await os.pickFile('appimage')
    if (!f.ok) { say(errText(f.error), true); return }
    const r = await os.appimageImport(f.value.handle)
    if (!r.ok) { say(`${f.value.name}: ${packageErrorText(r.error)}`, true); return }
    say(`${r.value.name} was imported. Review it under Installed and allow it to run.`)
    loadCatalog()
  }
  const appimageAct = async (a: AppView, op: 'approve' | 'remove' | 'update' | 'open') => {
    const id = a.appimageId!
    setNotice(null)
    if (op === 'update') {
      const f = await os.pickFile('appimage')
      if (!f.ok) { say(errText(f.error), true); return }
      const r = await os.appimageUpdate(id, f.value.handle)
      say(r.ok ? `${a.name} was updated.` : `${a.name}: ${packageErrorText(r.error)}`, !r.ok)
    } else {
      const r = op === 'approve' ? await os.appimageApprove(id) : op === 'remove' ? await os.appimageRemove(id) : await os.appimageLaunch(id)
      say(r.ok ? (op === 'approve' ? `${a.name} is allowed to run.` : op === 'remove' ? `${a.name} was removed. Its settings in your home folder were kept.` : '') : `${a.name}: ${packageErrorText(r.error)}`, !r.ok)
    }
    loadCatalog()
  }

  // ---- local .deb (WSOS-APT-005) ----
  const pickDeb = async () => {
    setNotice(null)
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

  // ---- Flatpak permissions (WSOS-FLP-003/004) ----
  const openPerms = async (a: AppView) => {
    if (!a.catalogId) return
    setPerms({ app: a, loading: true })
    const r = await os.appPermissions(a.catalogId)
    setPerms(r.ok ? { app: a, loading: false, data: r.value } : { app: a, loading: false, error: packageErrorText(r.error) })
  }
  const resetPerms = async (a: AppView) => {
    const r = await os.appPermissionsReset(a.catalogId!)
    if (!r.ok) { say(`${a.name}: ${packageErrorText(r.error)}`, true); return }
    track(r.value, a.name, 'reset')
  }
  const removeData = async (a: AppView) => {
    if (!window.confirm(`Remove ${a.name}’s data? Its settings, cache and files it keeps for itself are deleted from your account.`)) return
    const r = await os.appDataRemove(a.catalogId!)
    say(r.ok ? (r.value ? `${a.name}: app data removed.` : `${a.name} has no app data.`) : `${a.name}: ${packageErrorText(r.error)}`, !r.ok)
  }
  const prune = async () => {
    const r = await os.pruneRuntimes()
    if (!r.ok) { say(packageErrorText(r.error), true); return }
    track(r.value, 'Runtimes', 'prune')
  }

  const cta = (a: AppView): { label: string; act?: () => void; disabled?: boolean }[] => {
    if (a.builtin === 'office') return [{ label: 'Open', act: () => void os.launchOffice('start') }]
    if (running(a.name)) return [{ label: 'Working…', disabled: true }]
    if (a.appimageId) {
      if (section === 'installed') return [...(a.needsApproval ? [{ label: 'Allow to run', act: () => void appimageAct(a, 'approve') }] : []), { label: 'Update…', act: () => void appimageAct(a, 'update') }, { label: 'Remove', act: () => void appimageAct(a, 'remove') }]
      return a.needsApproval ? [{ label: 'Allow to run', act: () => void appimageAct(a, 'approve') }] : [{ label: 'Open', act: () => void appimageAct(a, 'open') }]
    }
    if (a.blocked) return [{ label: 'Unavailable', disabled: true }]
    if (section === 'permissions') return [{ label: 'Review', act: () => void openPerms(a) }]
    if (a.catalogId && updates.has(a.catalogId) && section === 'updates') return [updating ? { label: 'Updating…', disabled: true } : { label: 'Update', act: () => void updateAll() }]
    if (a.source === 'AppImage') return [{ label: 'Import file…', act: () => void importAppImage() }]
    if (a.installed) return section === 'installed' ? [{ label: 'Remove', act: () => void start(a, 'remove') }] : [{ label: 'Installed', disabled: true }]
    return [{ label: 'Install', act: () => setReview(a) }]
  }
  const tag = (a: AppView) => a.builtin ? { t: 'Built in', c: 'bg-[#ecfdf5] text-[#047857]' }
    : a.blocked ? { t: a.blocked, c: 'bg-[#fef2f2] text-[#b91c1c]' }
    : a.needsApproval ? { t: 'Needs your approval', c: 'bg-[#fffbeb] text-[#b45309]' }
    : a.installed ? { t: 'Installed', c: 'bg-[#ecfdf5] text-[#047857]' }
    : { t: 'Approved', c: 'bg-[#ecfdf5] text-[#047857]' }

  const navItem = (id: Section, label: string, badge?: number) => (
    <button type="button" aria-current={section === id ? 'page' : undefined} onClick={() => setSection(id)}
      className={`flex h-[38px] items-center justify-between rounded-lg px-3 text-left text-sm ${section === id ? 'bg-[#dbeafe] font-semibold text-[#1e3a8a]' : 'text-[#334155] hover:bg-[#f1f5f9]'}`}>
      {label}{badge ? <span className="rounded-full bg-[#2563eb] px-2 py-px text-[11px] font-normal text-white">{badge}</span> : null}
    </button>
  )
  const secondary = 'h-8 rounded-lg border border-[#cbd5e1] bg-white px-3.5 text-[13px] font-semibold text-[#1d4ed8] hover:bg-[#eff6ff] disabled:cursor-not-allowed disabled:text-[#94a3b8] disabled:hover:bg-white'

  return (
    <BWindow title="App Center" mark="A" markClass="bg-[#2563eb] text-white" label="App Center" bodyClass="bg-[#f1f5f9]" titleClass="bg-white" onClose={onClose}>
      <div className="relative flex min-w-0 grow">
        <nav aria-label="App Center sections" className="flex w-[220px] shrink-0 flex-col gap-1 overflow-auto border-r border-[#e2e8f0] bg-white px-3 py-4">
          {navItem('discover', 'Discover')}
          {navItem('installed', 'Installed')}
          {navItem('updates', 'Updates', pending.length)}
          {navItem('permissions', 'Permissions')}
          <div className="mt-4 px-3 text-[11.5px] font-bold tracking-[0.06em] text-[#475569] uppercase">Sources</div>
          {SOURCES.map((s) => (
            <label key={s.id} className="flex h-[34px] items-center gap-2 px-3 text-[13.5px] text-[#334155]">
              <input type="checkbox" checked={sources.has(s.id)} onChange={() => toggleSource(s.id)} className="accent-[#2563eb]" />{s.label}
            </label>
          ))}
          <div className="mt-4 flex flex-col gap-1.5 px-1">
            <button type="button" onClick={() => void pickDeb()} className={secondary}>Install package file…</button>
            <button type="button" onClick={() => void importAppImage()} className={secondary}>Import AppImage…</button>
          </div>
          {catalog && <div className="mt-auto rounded-[10px] bg-[#eff6ff] p-3 text-xs leading-normal text-[#1e3a8a]">{catalog.state === 'ok' ? 'Apps your organization has approved.' : 'No organization catalog.'} Device: {catalog.arch}.</div>}
        </nav>

        <main className="flex min-w-0 grow flex-col gap-4 overflow-auto px-6 py-5">
          {notice && (
            <div role="status" className={`flex items-center gap-3 rounded-xl px-4 py-2.5 text-[13px] ${notice.error ? 'bg-[#fef2f2] text-[#991b1b]' : 'bg-[#ecfdf5] text-[#065f46]'}`}>
              <span className="grow">{notice.text}</span>
              <button type="button" aria-label="Dismiss" onClick={() => setNotice(null)} className="text-current opacity-70 hover:opacity-100"><BIcon name="close" size={14} /></button>
            </div>
          )}
          {Object.entries(jobs).map(([path, j]) => (
            <div key={path} aria-live="polite" className="flex items-center gap-3 rounded-xl border border-[#e2e8f0] bg-white px-4 py-2.5 text-[13px]">
              <span className="grow">{j.op === 'update' ? 'Installing updates' : j.op === 'prune' ? 'Removing unused runtimes' : j.op === 'reset' ? `Resetting ${j.name}` : `${j.op === 'install' ? 'Installing' : 'Removing'} ${j.name}`}…</span>
              <span className="h-1.5 w-40 overflow-hidden rounded-full bg-[#e2e8f0]" role="progressbar" aria-valuenow={progress[path] ?? 0} aria-valuemin={0} aria-valuemax={100}><span className="block h-full bg-[#2563eb]" style={{ width: `${progress[path] ?? 0}%` }} /></span>
            </div>
          ))}
          {section === 'updates' && (
            <div className="flex flex-col gap-2 rounded-xl border border-[#e2e8f0] bg-white px-4 py-3 text-[13px]">
              <div className="flex items-center gap-3">
                <span className="grow">
                  {updatesError ? updatesError
                    : !available ? 'Checking for updates…'
                    : pending.length === 0 ? 'Everything is up to date.'
                    : `${pending.length} update${pending.length === 1 ? '' : 's'} available. System and app updates are installed together, as your organization’s update ring allows.`}
                  {available?.reboot && ' A restart is needed to finish the last update.'}
                </span>
                {pending.length > 0 && <button type="button" disabled={updating} onClick={() => void updateAll()} className="h-9 rounded-lg bg-[#2563eb] px-4 text-sm font-semibold text-white disabled:opacity-60">{updating ? 'Updating…' : 'Update all'}</button>}
              </div>
              {otherUpdates.length > 0 && (
                <details className="text-[#475569]">
                  <summary className="cursor-pointer">{otherUpdates.length} system package{otherUpdates.length === 1 ? '' : 's'}</summary>
                  <ul className="m-0 mt-2 columns-2 pl-5 font-mono text-[12px] sm:columns-3">{otherUpdates.map((id) => <li key={id}>{id.split(':')[1]}</li>)}</ul>
                </details>
              )}
            </div>
          )}
          {section === 'permissions' && (
            <div className="flex items-center gap-3 rounded-xl border border-[#e2e8f0] bg-white px-4 py-3 text-[13px]">
              <span className="grow">Review what installed Flatpak apps can access, reset them to what they declare, or remove their data. Runtimes no installed app needs can be removed to free space.</span>
              <button type="button" onClick={() => void prune()} disabled={Object.values(jobs).some((j) => j.op === 'prune')} className={secondary}>Remove unused runtimes</button>
            </div>
          )}
          <label className="flex h-11 shrink-0 items-center gap-2.5 rounded-[10px] border border-[#cbd5e1] bg-white px-3.5 text-[#475569]">
            <BIcon name="search" />
            <input type="text" value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Search apps" aria-label="Search apps" className="grow border-0 bg-transparent text-[15px] text-[#0f172a] outline-none" />
            {query && <button type="button" aria-label="Clear search" onClick={() => setQuery('')} className="text-[#475569] hover:text-[#0f172a]"><BIcon name="close" size={14} /></button>}
          </label>
          <div role="group" aria-label="Category" className="flex flex-wrap gap-1.5">
            {categories(apps).map((c) => (
              <button key={c} type="button" aria-pressed={category === c} onClick={() => setCategory(c)}
                className={`h-8 rounded-full px-3.5 text-[13px] ${category === c ? 'bg-[#2563eb] font-semibold text-white' : 'border border-[#e2e8f0] bg-white text-[#334155] hover:bg-[#f8fafc]'}`}>{c}</button>
            ))}
          </div>
          {notice0 && !apps.length && (
            <div role="status" className="flex items-center gap-3 rounded-xl border border-dashed border-[#cbd5e1] bg-white px-4 py-6 text-sm text-[#475569]">
              <span className="grow">{notice0.text}</span>
              {notice0.retry && <button type="button" onClick={loadCatalog} className={secondary}>Try again</button>}
            </div>
          )}
          {list.length ? (
            <div className="grid grid-cols-[repeat(auto-fill,minmax(260px,1fr))] gap-3">
              {list.map((a) => {
                const t = tag(a)
                return (
                  <div key={a.key} className="flex flex-col gap-2.5 rounded-xl border border-[#e2e8f0] bg-white p-4">
                    <div className="flex items-center gap-3">
                      <span className="flex size-11 shrink-0 items-center justify-center rounded-[10px] bg-[#e0e7ff] font-bold text-[#4338ca]">{initials(a.name)}</span>
                      <span className="flex min-w-0 flex-col gap-0.5"><span className="truncate text-[15px] font-semibold">{a.name}</span><span className="truncate text-xs text-[#475569]">{a.publisher}</span></span>
                    </div>
                    {a.summary && <div className="text-[13px] leading-[1.45] text-[#334155]">{a.summary}</div>}
                    {a.trust && <div className="text-[12px] leading-[1.4] text-[#475569]">{a.trust}</div>}
                    <div className="mt-auto flex flex-wrap items-center gap-1.5">
                      <span className="rounded-full bg-[#f1f5f9] px-2 py-0.5 text-[11px] text-[#334155]">{a.source}</span>
                      <span className={`rounded-full px-2 py-0.5 text-[11px] ${t.c}`}>{t.t}</span>
                      <span className="ml-auto flex gap-1.5">
                        {cta(a).map((c) => <button key={c.label} type="button" disabled={c.disabled} onClick={c.act} aria-label={`${c.label} ${a.name}`} className={secondary}>{c.label}</button>)}
                      </span>
                    </div>
                  </div>
                )
              })}
            </div>
          ) : !notice0 || apps.length ? <p className="text-sm text-[#475569]">No apps match these filters.</p> : null}
        </main>

        {review && (
          <div className="absolute inset-0 z-10 flex items-start justify-center overflow-auto bg-[rgba(15,23,42,0.45)] p-6 pt-[76px]" onMouseDown={(e) => { if (e.target === e.currentTarget && !busy) setReview(null) }}>
            <div role="dialog" aria-modal="true" aria-label={`Review install of ${review.name}`} className="flex w-[600px] max-w-full flex-col overflow-hidden rounded-2xl bg-white shadow-[0_24px_64px_rgba(2,6,23,0.5)]">
              <div className="flex flex-col gap-0.5 px-6 pt-6 pb-4">
                <div className="text-[19px] font-[650]">Install {review.name}?</div>
                <div className="text-[13px] text-[#475569]">{review.source} · {review.catalogId?.split(':')[1]} · for everyone on this computer</div>
              </div>
              {(preview.data?.permissions.length ?? 0) > 0 && <>
                <div className="px-6 pb-2 text-xs font-bold tracking-[0.06em] text-[#475569] uppercase">This app will be able to</div>
                <ul className="m-0 flex list-none flex-col px-6">
                  {preview.data!.permissions.map((p) => describePermission(p, preview.data!.broad.includes(p))).map((p) => (
                    <li key={p.detail + p.title} className="flex items-center gap-3 border-b border-[#f1f5f9] py-2.5">
                      <span className={`size-2.5 shrink-0 rounded-full ${LEVEL[p.level].dot}`} />
                      <span className="flex grow flex-col gap-0.5"><span className="text-sm font-semibold">{p.title}</span><span className="text-[12.5px] text-[#475569]">{p.detail}</span></span>
                      <span className={`rounded-full px-2 py-0.5 text-[11px] ${LEVEL[p.level].tag}`}>{p.level}</span>
                    </li>
                  ))}
                </ul>
              </>}
              <div className="mx-6 mt-4 grid grid-cols-3 gap-2">
                {[
                  ['Disk needed', preview.loading ? '…' : preview.data ? formatBytes(preview.data.disk_bytes) : '—'],
                  ['Also installs', preview.loading ? '…' : preview.data ? (preview.data.plan.install.length > 1 ? `${preview.data.plan.install.length - 1} packages` : 'Nothing else') : '—'],
                  ['Removes', preview.loading ? '…' : preview.data ? (preview.data.plan.remove.length ? preview.data.plan.remove.map((c) => c.name).join(', ') : 'Nothing') : '—'],
                ].map(([k, v]) => (
                  <div key={k} className="rounded-[10px] border border-[#e2e8f0] bg-[#f8fafc] px-3 py-2.5"><div className="text-xs text-[#475569]">{k}</div><div className="text-[15px] font-semibold">{v}</div></div>
                ))}
              </div>
              <div className="mt-5 flex items-center gap-2.5 border-t border-[#e2e8f0] bg-[#f8fafc] px-6 py-4">
                <span className={`text-[12.5px] ${preview.error ? 'text-[#b91c1c]' : 'text-[#475569]'}`} aria-live="polite">{busy ? 'Waiting for approval…' : preview.error ?? (preview.loading ? 'Checking with the package service…' : 'Allowed by policy · an administrator password may be asked')}</span>
                <button type="button" disabled={busy} onClick={() => setReview(null)} className="ml-auto h-[42px] rounded-[10px] border border-[#cbd5e1] bg-white px-[18px] text-sm text-[#334155] hover:bg-[#f1f5f9] disabled:opacity-60">Cancel</button>
                <button type="button" disabled={busy || preview.loading || !!preview.error} onClick={() => void start(review, 'install')} className="h-[42px] rounded-[10px] bg-[#2563eb] px-5 text-sm font-semibold text-white hover:bg-[#1d4ed8] disabled:opacity-70">{busy ? 'Installing…' : 'Install'}</button>
              </div>
            </div>
          </div>
        )}

        {deb && (
          <div className="absolute inset-0 z-10 flex items-start justify-center overflow-auto bg-[rgba(15,23,42,0.45)] p-6 pt-[76px]">
            <div role="dialog" aria-modal="true" aria-label={`Install package file ${deb.name}`} className="flex w-[600px] max-w-full flex-col overflow-hidden rounded-2xl bg-white shadow-[0_24px_64px_rgba(2,6,23,0.5)]">
              <div className="flex flex-col gap-1 px-6 pt-6 pb-4">
                <div className="text-[19px] font-[650]">Install {deb.data ? `${deb.data.package} ${deb.data.version}` : deb.name}?</div>
                <div className="text-[13px] text-[#475569]">From a package file, not an approved repository. An administrator password is needed.</div>
              </div>
              {deb.data && (
                <dl className="mx-6 grid grid-cols-[140px_1fr] gap-x-3 gap-y-1.5 text-[13px]">
                  <dt className="text-[#475569]">Publisher</dt><dd className="m-0">{deb.data.publisher} <span className="text-[#b45309]">(from the package; not verified)</span></dd>
                  <dt className="text-[#475569]">Architecture</dt><dd className="m-0">{deb.data.architecture}</dd>
                  <dt className="text-[#475569]">Description</dt><dd className="m-0">{deb.data.description || '—'}</dd>
                  <dt className="text-[#475569]">Also installs</dt><dd className="m-0">{deb.data.plan.install.filter((c) => c.name !== deb.data!.package).map((c) => c.name).join(', ') || 'Nothing else'}</dd>
                  <dt className="text-[#475569]">Removes</dt><dd className="m-0">{deb.data.plan.remove.map((c) => c.name).join(', ') || 'Nothing'}</dd>
                  <dt className="text-[#475569]">Disk needed</dt><dd className="m-0">{formatBytes(deb.data.disk_bytes)}</dd>
                  <dt className="text-[#475569]">SHA-256</dt><dd className="m-0 font-mono text-[11.5px] break-all">{deb.data.token}</dd>
                </dl>
              )}
              <div className="mt-5 flex items-center gap-2.5 border-t border-[#e2e8f0] bg-[#f8fafc] px-6 py-4">
                <span className={`text-[12.5px] ${deb.error ? 'text-[#b91c1c]' : 'text-[#475569]'}`} aria-live="polite">{busy ? 'Waiting for approval…' : deb.error ?? (deb.loading ? 'Checking the package with apt…' : 'Checked by apt and your organization’s policy')}</span>
                <button type="button" disabled={busy} onClick={() => setDeb(null)} className="ml-auto h-[42px] rounded-[10px] border border-[#cbd5e1] bg-white px-[18px] text-sm text-[#334155] hover:bg-[#f1f5f9] disabled:opacity-60">Cancel</button>
                <button type="button" disabled={busy || deb.loading || !deb.data} onClick={() => void installDeb()} className="h-[42px] rounded-[10px] bg-[#2563eb] px-5 text-sm font-semibold text-white hover:bg-[#1d4ed8] disabled:opacity-70">Install</button>
              </div>
            </div>
          </div>
        )}

        {perms && (
          <div className="absolute inset-0 z-10 flex items-start justify-center overflow-auto bg-[rgba(15,23,42,0.45)] p-6 pt-[76px]" onMouseDown={(e) => { if (e.target === e.currentTarget) setPerms(null) }}>
            <div role="dialog" aria-modal="true" aria-label={`Permissions of ${perms.app.name}`} className="flex w-[600px] max-w-full flex-col overflow-hidden rounded-2xl bg-white shadow-[0_24px_64px_rgba(2,6,23,0.5)]">
              <div className="px-6 pt-6 pb-3 text-[19px] font-[650]">{perms.app.name}: permissions</div>
              {perms.loading ? <p className="px-6 text-sm text-[#475569]">Loading…</p> : perms.error ? <p className="px-6 text-sm text-[#b91c1c]">{perms.error}</p> : (
                <ul className="m-0 flex list-none flex-col px-6">
                  {perms.data!.permissions.length === 0 && <li className="py-2 text-sm text-[#475569]">This app declares no special permissions.</li>}
                  {perms.data!.permissions.map((p) => describePermission(p, perms.data!.broad.includes(p))).map((p) => (
                    <li key={p.detail + p.title} className="flex items-center gap-3 border-b border-[#f1f5f9] py-2.5">
                      <span className={`size-2.5 shrink-0 rounded-full ${LEVEL[p.level].dot}`} />
                      <span className="flex grow flex-col gap-0.5"><span className="text-sm font-semibold">{p.title}</span><span className="text-[12.5px] text-[#475569]">{p.detail}</span></span>
                    </li>
                  ))}
                  {perms.data!.overrides.length > 0 && <li className="py-2 text-[12.5px] text-[#475569]">Changed on this computer: {perms.data!.overrides.join(' ')}</li>}
                </ul>
              )}
              <div className="mt-5 flex items-center gap-2.5 border-t border-[#e2e8f0] bg-[#f8fafc] px-6 py-4">
                <button type="button" onClick={() => void removeData(perms.app)} className="h-[42px] rounded-[10px] border border-[#fecaca] bg-white px-[18px] text-sm text-[#b91c1c] hover:bg-[#fef2f2]">Remove app data</button>
                <button type="button" onClick={() => setPerms(null)} className="ml-auto h-[42px] rounded-[10px] border border-[#cbd5e1] bg-white px-[18px] text-sm text-[#334155] hover:bg-[#f1f5f9]">Close</button>
                <button type="button" disabled={perms.loading || !!perms.error} onClick={() => { void resetPerms(perms.app); setPerms(null) }} className="h-[42px] rounded-[10px] bg-[#2563eb] px-5 text-sm font-semibold text-white hover:bg-[#1d4ed8] disabled:opacity-70">Reset permissions</button>
              </div>
            </div>
          </div>
        )}
      </div>
    </BWindow>
  )
}

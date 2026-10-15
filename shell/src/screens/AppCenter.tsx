import { useEffect, useState } from 'react'
import type { WindowProps } from './types'
import BWindow from '../components/BWindow'
import BIcon from '../components/BIcon'

type Source = 'WorkSuite' | 'APT' | 'Flatpak' | 'AppImage'
type Policy = 'approved' | 'admin' | 'blocked'
type Level = 'Safe' | 'Review' | 'Broad'
interface Perm { title: string; detail: string; level: Level }
interface App {
  id: string; mark: string; bg: string; fg: string; name: string; pub: string; desc: string
  src: Source; category: string; policy: Policy; installed?: boolean; update?: boolean
  ref: string; download: string; disk: string; deps: string; perms: Perm[]
}

const LEVEL: Record<Level, { tag: string; dot: string }> = {
  Safe: { tag: 'bg-[#ecfdf5] text-[#047857]', dot: 'bg-[#10b981]' },
  Review: { tag: 'bg-[#fffbeb] text-[#b45309]', dot: 'bg-[#f59e0b]' },
  Broad: { tag: 'bg-[#fef2f2] text-[#b91c1c]', dot: 'bg-[#ef4444]' },
}
const SOURCES: { id: Source; label: string; on: boolean }[] = [
  { id: 'WorkSuite', label: 'WorkSuite apps', on: true },
  { id: 'APT', label: 'Debian (APT)', on: true },
  { id: 'Flatpak', label: 'Flathub (approved)', on: true },
  { id: 'AppImage', label: 'AppImage', on: false },
]
const CATEGORIES = ['All', 'Graphics', 'Office', 'Development', 'Internet']
const portal: Perm = { title: 'Read and write files you choose', detail: 'Through the file picker portal only', level: 'Safe' }
const net = (why: string): Perm => ({ title: 'Use the network', detail: why, level: 'Review' })

const APPS: App[] = [
  { id: 'gimp', mark: 'G', bg: '#fef3c7', fg: '#92400e', name: 'GIMP', pub: 'The GIMP Team', desc: 'Raster image editing, retouching and compositing.', src: 'Flatpak', category: 'Graphics', policy: 'approved', ref: 'org.gimp.GIMP · stable', download: '142 MB', disk: '418 MB', deps: 'GNOME 47 runtime',
    perms: [portal, { title: 'Access your Pictures folder', detail: 'filesystem=xdg-pictures', level: 'Review' }, net('Needed for plug-in downloads and help pages'), { title: 'Run as an X11 app (XWayland)', detail: 'Older apps can read input from other X11 windows', level: 'Broad' }] },
  { id: 'krita', mark: 'K', bg: '#e0e7ff', fg: '#4338ca', name: 'Krita', pub: 'KDE', desc: 'Digital painting and illustration.', src: 'Flatpak', category: 'Graphics', policy: 'approved', ref: 'org.kde.krita · stable', download: '188 MB', disk: '562 MB', deps: 'KDE 6.7 runtime',
    perms: [portal, { title: 'Access your Pictures folder', detail: 'filesystem=xdg-pictures', level: 'Review' }, { title: 'Use graphics tablets', detail: 'device=all for pen input', level: 'Broad' }] },
  { id: 'inkscape', mark: 'In', bg: '#fae8ff', fg: '#a21caf', name: 'Inkscape', pub: 'Inkscape Project', desc: 'Vector graphics editor for SVG.', src: 'APT', category: 'Graphics', policy: 'admin', ref: 'inkscape 1.2.2 · bookworm', download: '24 MB', disk: '96 MB', deps: '38 packages', perms: [] },
  { id: 'pdf-studio', mark: 'PS', bg: '#fee2e2', fg: '#b91c1c', name: 'WorkSuite PDF Studio', pub: 'Livezen Technologies', desc: 'Edit, sign and convert PDFs with WorkSuite Drive.', src: 'WorkSuite', category: 'Office', policy: 'approved', installed: true, update: true, ref: 'pdf-studio 3.2', download: '12 MB', disk: '40 MB', deps: 'None', perms: [] },
  { id: 'darktable', mark: 'Dt', bg: '#e0f2fe', fg: '#0369a1', name: 'darktable', pub: 'darktable org', desc: 'RAW photo workflow and development.', src: 'Flatpak', category: 'Graphics', policy: 'approved', ref: 'org.darktable.Darktable · stable', download: '96 MB', disk: '310 MB', deps: 'GNOME 47 runtime',
    perms: [portal, { title: 'Access your Pictures folder', detail: 'filesystem=xdg-pictures', level: 'Review' }] },
  { id: 'pinta', mark: 'Pi', bg: '#f1f5f9', fg: '#334155', name: 'Pinta.AppImage', pub: 'Imported file', desc: 'Unverified publisher — checksum only.', src: 'AppImage', category: 'Graphics', policy: 'blocked', ref: 'Pinta-2.1-x86_64.AppImage', download: '—', disk: '64 MB', deps: 'None', perms: [] },
  { id: 'mail', mark: 'M', bg: '#dbeafe', fg: '#1d4ed8', name: 'WorkSuite Mail', pub: 'Livezen Technologies', desc: 'Mail with offline cache and shared inboxes.', src: 'WorkSuite', category: 'Office', policy: 'approved', installed: true, update: true, ref: 'mail 5.1', download: '18 MB', disk: '62 MB', deps: 'None', perms: [] },
  { id: 'libreoffice', mark: 'LO', bg: '#dcfce7', fg: '#15803d', name: 'LibreOffice', pub: 'The Document Foundation', desc: 'Office suite for legacy document formats.', src: 'APT', category: 'Office', policy: 'approved', installed: true, update: true, ref: 'libreoffice 7.4 · bookworm', download: '210 MB', disk: '640 MB', deps: '112 packages', perms: [] },
  { id: 'vscodium', mark: 'Vs', bg: '#e0f2fe', fg: '#0369a1', name: 'VSCodium', pub: 'VSCodium', desc: 'Code editor without telemetry.', src: 'Flatpak', category: 'Development', policy: 'approved', ref: 'com.vscodium.codium · stable', download: '120 MB', disk: '380 MB', deps: 'Freedesktop 24.08 runtime',
    perms: [portal, { title: 'Full access to your home folder', detail: 'filesystem=home', level: 'Broad' }, net('Extensions and source control')] },
  { id: 'firefox', mark: 'Fx', bg: '#f1f5f9', fg: '#334155', name: 'Firefox ESR', pub: 'Mozilla', desc: 'Web browser, managed by policy.', src: 'APT', category: 'Internet', policy: 'approved', installed: true, update: true, ref: 'firefox-esr 128 · bookworm', download: '72 MB', disk: '250 MB', deps: '6 packages', perms: [] },
]

type Section = 'discover' | 'installed' | 'updates' | 'permissions'

export default function AppCenter({ onClose }: WindowProps) {
  const [section, setSection] = useState<Section>('discover')
  const [sources, setSources] = useState(() => new Set(SOURCES.filter((s) => s.on).map((s) => s.id)))
  const [category, setCategory] = useState('All')
  const [query, setQuery] = useState('image editor')
  const [installed, setInstalled] = useState(() => new Set(APPS.filter((a) => a.installed).map((a) => a.id)))
  const [updates, setUpdates] = useState(() => new Set(APPS.filter((a) => a.update).map((a) => a.id)))
  const [requested, setRequested] = useState<Set<string>>(new Set())
  const [review, setReview] = useState<App | null>(() => APPS[0])
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    if (!review) return
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape' && !busy) setReview(null) }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [review, busy])

  const q = query.trim().toLowerCase()
  const words = q.split(/\s+/).filter(Boolean)
  const matches = (a: App) => !words.length || words.some((w) => `${a.name} ${a.desc} ${a.category} ${a.pub}`.toLowerCase().includes(w.replace(/s$/, '')))
  const list = APPS.filter((a) => {
    if (!sources.has(a.src)) return false
    if (category !== 'All' && a.category !== category) return false
    if (section === 'installed' && !installed.has(a.id)) return false
    if (section === 'updates' && !updates.has(a.id)) return false
    if (section === 'permissions' && !(installed.has(a.id) && a.perms.length)) return false
    return matches(a)
  })

  const toggleSource = (s: Source) => setSources((prev) => { const n = new Set(prev); if (n.has(s)) n.delete(s); else n.add(s); return n })

  const install = (a: App) => {
    setBusy(true)
    setTimeout(() => {
      setInstalled((p) => new Set(p).add(a.id))
      setBusy(false); setReview(null)
    }, 900)
  }

  const cta = (a: App): { label: string; act?: () => void; disabled?: boolean } => {
    if (a.policy === 'blocked') return { label: 'Blocked', disabled: true }
    if (updates.has(a.id) && section === 'updates') return { label: 'Update', act: () => setUpdates((p) => { const n = new Set(p); n.delete(a.id); return n }) }
    if (installed.has(a.id)) return { label: 'Open', act: () => {} }
    if (a.policy === 'admin') return requested.has(a.id) ? { label: 'Requested', disabled: true } : { label: 'Request', act: () => setRequested((p) => new Set(p).add(a.id)) }
    return { label: 'Install', act: () => setReview(a) }
  }
  const tag = (a: App) => installed.has(a.id) ? { t: 'Installed', c: 'bg-[#ecfdf5] text-[#047857]' }
    : a.policy === 'approved' ? { t: 'Approved', c: 'bg-[#ecfdf5] text-[#047857]' }
    : a.policy === 'admin' ? { t: 'Admin approval', c: 'bg-[#fffbeb] text-[#b45309]' }
    : { t: 'Blocked by policy', c: 'bg-[#fef2f2] text-[#b91c1c]' }

  const navItem = (id: Section, label: string, badge?: number) => (
    <button type="button" aria-current={section === id ? 'page' : undefined} onClick={() => setSection(id)}
      className={`flex h-[38px] items-center justify-between rounded-lg px-3 text-left text-sm ${section === id ? 'bg-[#dbeafe] font-semibold text-[#1e3a8a]' : 'text-[#334155] hover:bg-[#f1f5f9]'}`}>
      {label}{badge ? <span className="rounded-full bg-[#2563eb] px-2 py-px text-[11px] font-normal text-white">{badge}</span> : null}
    </button>
  )

  return (
    <BWindow title="App Center" mark="A" markClass="bg-[#2563eb] text-white" label="App Center" bodyClass="bg-[#f1f5f9]" titleClass="bg-white" onClose={onClose}>
      <div className="relative flex min-w-0 grow">
        <nav aria-label="App Center sections" className="flex w-[220px] shrink-0 flex-col gap-1 overflow-auto border-r border-[#e2e8f0] bg-white px-3 py-4">
          {navItem('discover', 'Discover')}
          {navItem('installed', 'Installed')}
          {navItem('updates', 'Updates', updates.size)}
          {navItem('permissions', 'Permissions')}
          <div className="mt-4 px-3 text-[11.5px] font-bold tracking-[0.06em] text-[#475569] uppercase">Sources</div>
          {SOURCES.map((s) => (
            <label key={s.id} className="flex h-[34px] items-center gap-2 px-3 text-[13.5px] text-[#334155]">
              <input type="checkbox" checked={sources.has(s.id)} onChange={() => toggleSource(s.id)} className="accent-[#2563eb]" />{s.label}
            </label>
          ))}
          <div className="mt-auto rounded-[10px] bg-[#eff6ff] p-3 text-xs leading-normal text-[#1e3a8a]">Your organization allows apps from the approved list only. Device: amd64.</div>
        </nav>

        <main className="flex min-w-0 grow flex-col gap-4 overflow-auto px-6 py-5">
          <label className="flex h-11 shrink-0 items-center gap-2.5 rounded-[10px] border border-[#cbd5e1] bg-white px-3.5 text-[#475569]">
            <BIcon name="search" />
            <input type="text" value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Search apps" aria-label="Search apps" className="grow border-0 bg-transparent text-[15px] text-[#0f172a] outline-none" />
            {query && <button type="button" aria-label="Clear search" onClick={() => setQuery('')} className="text-[#475569] hover:text-[#0f172a]"><BIcon name="close" size={14} /></button>}
          </label>
          <div role="group" aria-label="Category" className="flex flex-wrap gap-1.5">
            {CATEGORIES.map((c) => (
              <button key={c} type="button" aria-pressed={category === c} onClick={() => setCategory(c)}
                className={`h-8 rounded-full px-3.5 text-[13px] ${category === c ? 'bg-[#2563eb] font-semibold text-white' : 'border border-[#e2e8f0] bg-white text-[#334155] hover:bg-[#f8fafc]'}`}>{c}</button>
            ))}
          </div>
          {list.length ? (
            <div className="grid grid-cols-[repeat(auto-fill,minmax(260px,1fr))] gap-3">
              {list.map((a) => {
                const c = cta(a), t = tag(a)
                return (
                  <div key={a.id} className="flex flex-col gap-2.5 rounded-xl border border-[#e2e8f0] bg-white p-4">
                    <div className="flex items-center gap-3">
                      <span className="flex size-11 items-center justify-center rounded-[10px] font-bold" style={{ background: a.bg, color: a.fg }}>{a.mark}</span>
                      <span className="flex flex-col gap-0.5"><span className="text-[15px] font-semibold">{a.name}</span><span className="text-xs text-[#475569]">{a.pub}</span></span>
                    </div>
                    <div className="text-[13px] leading-[1.45] text-[#334155]">{a.desc}</div>
                    <div className="mt-auto flex items-center gap-1.5">
                      <span className="rounded-full bg-[#f1f5f9] px-2 py-0.5 text-[11px] text-[#334155]">{a.src}</span>
                      <span className={`rounded-full px-2 py-0.5 text-[11px] ${t.c}`}>{t.t}</span>
                      <button type="button" disabled={c.disabled} onClick={c.act} aria-label={`${c.label} ${a.name}`}
                        className="ml-auto h-8 rounded-lg border border-[#cbd5e1] bg-white px-3.5 text-[13px] font-semibold text-[#1d4ed8] hover:bg-[#eff6ff] disabled:cursor-not-allowed disabled:text-[#94a3b8] disabled:hover:bg-white">{c.label}</button>
                    </div>
                  </div>
                )
              })}
            </div>
          ) : <p className="text-sm text-[#475569]">No apps match these filters.</p>}
        </main>

        {review && (
          <div className="absolute inset-0 z-10 flex items-start justify-center overflow-auto bg-[rgba(15,23,42,0.45)] p-6 pt-[76px]" onMouseDown={(e) => { if (e.target === e.currentTarget && !busy) setReview(null) }}>
            <div role="dialog" aria-modal="true" aria-label={`Review install of ${review.name}`} className="flex w-[600px] max-w-full flex-col overflow-hidden rounded-2xl bg-white shadow-[0_24px_64px_rgba(2,6,23,0.5)]">
              <div className="flex items-center gap-3.5 px-6 pt-6 pb-4">
                <span className="flex size-[52px] items-center justify-center rounded-xl text-lg font-bold" style={{ background: review.bg, color: review.fg === '#92400e' ? '#92400e' : review.fg }}>{review.mark}</span>
                <div className="flex flex-col gap-0.5">
                  <div className="text-[19px] font-[650]">Install {review.name}?</div>
                  <div className="text-[13px] text-[#475569]">{review.src === 'Flatpak' ? 'Flatpak' : review.src} · {review.ref} · {SOURCES.find((s) => s.id === review.src)!.label} · for this user</div>
                </div>
              </div>
              <div className="px-6 pb-2 text-xs font-bold tracking-[0.06em] text-[#475569] uppercase">This app will be able to</div>
              <ul className="m-0 flex list-none flex-col px-6">
                {(review.perms.length ? review.perms : [portal]).map((p) => (
                  <li key={p.title} className="flex items-center gap-3 border-b border-[#f1f5f9] py-2.5">
                    <span className={`size-2.5 shrink-0 rounded-full ${LEVEL[p.level].dot}`} />
                    <span className="flex grow flex-col gap-0.5"><span className="text-sm font-semibold">{p.title}</span><span className="text-[12.5px] text-[#475569]">{p.detail}</span></span>
                    <span className={`rounded-full px-2 py-0.5 text-[11px] ${LEVEL[p.level].tag}`}>{p.level}</span>
                  </li>
                ))}
              </ul>
              <div className="mx-6 mt-4 grid grid-cols-3 gap-2">
                {[['Download', review.download], ['Disk needed', review.disk], ['Also installs', review.deps]].map(([k, v]) => (
                  <div key={k} className="rounded-[10px] border border-[#e2e8f0] bg-[#f8fafc] px-3 py-2.5"><div className="text-xs text-[#475569]">{k}</div><div className="text-[15px] font-semibold">{v}</div></div>
                ))}
              </div>
              <div className="mt-5 flex items-center gap-2.5 border-t border-[#e2e8f0] bg-[#f8fafc] px-6 py-4">
                <span className="text-[12.5px] text-[#475569]" aria-live="polite">{busy ? `Installing ${review.name}…` : 'Allowed by policy · verified publisher'}</span>
                <button type="button" disabled={busy} onClick={() => setReview(null)} className="ml-auto h-[42px] rounded-[10px] border border-[#cbd5e1] bg-white px-[18px] text-sm text-[#334155] hover:bg-[#f1f5f9] disabled:opacity-60">Cancel</button>
                <button type="button" disabled={busy} onClick={() => install(review)} className="h-[42px] rounded-[10px] bg-[#2563eb] px-5 text-sm font-semibold text-white hover:bg-[#1d4ed8] disabled:opacity-70">{busy ? 'Installing…' : 'Install'}</button>
              </div>
            </div>
          </div>
        )}
      </div>
    </BWindow>
  )
}

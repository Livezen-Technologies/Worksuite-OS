// The Desktop folder on the wallpaper and the desktop's right-click menu (#27). Items are the real files in the XDG
// Desktop folder (electron/fileops.ts desktopDir), opened with their default app; the menu creates folders and files
// there, refreshes, sorts, changes the icon size and opens the wallpaper, display and personalization settings.
import { useCallback, useEffect, useRef, useState } from 'react'
import { os, type FileEntry } from '../lib/os'
import { DESK_PX, DESK_SIZES, DESK_SORTS, extOf, sortDesk, uniqueName, type DeskView } from '../lib/desktopIcons'
import { useT, type MessageKey } from '../i18n'

export interface DesktopFolder { rel: string | null; entries: FileEntry[]; error: string | null; reload: () => Promise<void> }

/** The Desktop folder's items; reloaded on `reload`, when the window gets the focus back and every 30 s. */
export function useDesktopFolder(on: boolean): DesktopFolder {
  const [rel, setRel] = useState<string | null>(null)
  const [entries, setEntries] = useState<FileEntry[]>([])
  const [error, setError] = useState<string | null>(null)
  const live = useRef(true)
  const reload = useCallback(async () => {
    if (!os.desktopDir) { setError('unavailable'); return }
    try {
      const d = await os.desktopDir()
      if (!live.current) return
      if (!d.ok) { setError(d.error); setEntries([]); return }
      setRel(d.value)
      const l = await os.filesList('home', d.value)
      if (!live.current) return
      if (l.ok) { setEntries(l.value); setError(null) } else { setEntries([]); setError(l.error) }
    } catch { if (live.current) setError('unavailable') }
  }, [])
  useEffect(() => {
    live.current = true
    if (!on) return () => { live.current = false }
    void reload()
    const id = setInterval(() => void reload(), 30_000)
    const focus = () => void reload()
    window.addEventListener('focus', focus)
    return () => { live.current = false; clearInterval(id); window.removeEventListener('focus', focus) }
  }, [on, reload])
  return { rel, entries, error, reload }
}

const EXT_COLOR: Record<string, string> = { xlsx: '#2E9E6A', ods: '#2E9E6A', csv: '#2E9E6A', docx: '#1F6BFF', odt: '#1F6BFF', doc: '#1F6BFF', txt: '#5E739C', md: '#5E739C', pptx: '#D9572B', odp: '#D9572B', pdf: '#D9452B', png: '#7A4FE0', jpg: '#7A4FE0', jpeg: '#7A4FE0', svg: '#7A4FE0' }

function Glyph({ entry, px }: { entry: FileEntry; px: number }) {
  if (entry.dir) {
    return <svg aria-hidden="true" width={px} height={px} viewBox="0 0 24 24"><path d="M2 6.5A1.5 1.5 0 0 1 3.5 5h5l2 2h10A1.5 1.5 0 0 1 22 8.5v10a1.5 1.5 0 0 1-1.5 1.5h-17A1.5 1.5 0 0 1 2 18.5z" fill="#F5B841" /><path d="M2 9h20v9.5a1.5 1.5 0 0 1-1.5 1.5h-17A1.5 1.5 0 0 1 2 18.5z" fill="#FFD27A" /></svg>
  }
  const ext = extOf(entry.name)
  return (
    <span aria-hidden="true" className="flex items-end justify-center rounded-md pb-1 font-mono font-bold text-white uppercase shadow-[0_4px_10px_rgba(0,0,0,0.3)]"
      style={{ width: px * 0.78, height: px, background: EXT_COLOR[ext] ?? '#3D5280', fontSize: Math.max(8, px / 5) }}>{ext.slice(0, 4)}</span>
  )
}

/** The icons, in columns from the top left (under the clock), like other desktops. */
export function DesktopIcons({ folder, view, selected, onSelect, onOpen }: {
  folder: DesktopFolder; view: DeskView; selected: string | null; onSelect: (name: string | null) => void; onOpen: (e: FileEntry) => void
}) {
  const t = useT()
  if (!view.show || !folder.entries.length) return null
  const px = DESK_PX[view.size]
  const items = sortDesk(folder.entries, view.sort)
  return (
    <ul aria-label={t('desk.icons')} data-desktop-bg className="ws-dark-zone absolute top-[120px] bottom-[64px] left-4 z-[4] m-0 flex list-none flex-col flex-wrap content-start gap-1 p-0"
      onMouseDown={(e) => { if (e.target === e.currentTarget) onSelect(null) }}>
      {items.map((e) => (
        <li key={e.name}>
          <button type="button" data-desk-item={e.name} aria-pressed={selected === e.name} title={e.name}
            onClick={() => onSelect(e.name)} onDoubleClick={() => onOpen(e)} onKeyDown={(k) => { if (k.key === 'Enter') { k.preventDefault(); onOpen(e) } }}
            className={`flex cursor-default flex-col items-center gap-1 rounded-lg border p-1.5 text-[#E8EEFA] ${selected === e.name ? 'border-[rgba(127,178,255,0.6)] bg-[rgba(31,107,255,0.35)]' : 'border-transparent hover:bg-white/10'}`}
            style={{ width: px.tile }}>
            <span className="flex items-center justify-center" style={{ height: px.glyph }}><Glyph entry={e} px={px.glyph} /></span>
            <span className={`w-full text-center text-xs leading-tight break-words [text-shadow:0_1px_3px_rgba(0,0,0,0.8)] ${selected === e.name ? '' : 'line-clamp-2'}`}>{e.name}</span>
          </button>
        </li>
      ))}
    </ul>
  )
}

const SORT_KEY: Record<string, MessageKey> = { name: 'desk.sort.name', modified: 'desk.sort.modified', type: 'desk.sort.type', size: 'desk.sort.size' }
const SIZE_KEY: Record<string, MessageKey> = { large: 'desk.view.large', medium: 'desk.view.medium', small: 'desk.view.small' }

export interface DesktopMenuProps {
  x: number; y: number
  view: DeskView; onView: (v: DeskView) => void
  /** Folder and template names under "New" (null: the Desktop folder is not available). */
  templates: string[]; canCreate: boolean
  onRefresh: () => void; onNewFolder: () => void; onNewFile: (template: string | null) => void
  onWallpaper: () => void; onDisplay: () => void; onPersonalize: () => void
  /** Desktop widgets' entries, when widgets are on. */
  extra?: { label: string; run: () => void }[]
  onClose: () => void
}

/** The desktop's right-click menu: Escape or a click outside closes it; arrows move between entries. */
export function DesktopMenu(p: DesktopMenuProps) {
  const t = useT()
  const ref = useRef<HTMLDivElement>(null)
  const [sub, setSub] = useState<'new' | 'sort' | 'view' | null>(null)
  const close = useRef(p.onClose)
  close.current = p.onClose
  useEffect(() => { ref.current?.querySelector<HTMLElement>('[role^="menuitem"]')?.focus() }, [])
  useEffect(() => {
    const down = (e: MouseEvent) => { if (ref.current && !ref.current.contains(e.target as Node)) close.current() }
    const blur = () => close.current()
    window.addEventListener('mousedown', down)
    window.addEventListener('blur', blur)
    return () => { window.removeEventListener('mousedown', down); window.removeEventListener('blur', blur) }
  }, [])
  const run = (f: () => void) => () => { p.onClose(); f() }
  const onKey = (e: React.KeyboardEvent) => {
    if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); if (sub) setSub(null); else p.onClose(); return }
    if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp') return
    e.preventDefault()
    const items = [...(ref.current?.querySelectorAll<HTMLElement>('[role^="menuitem"]:not([disabled])') ?? [])]
    const i = items.indexOf(document.activeElement as HTMLElement)
    items[(i + (e.key === 'ArrowDown' ? 1 : -1) + items.length) % items.length]?.focus()
  }
  const item = 'flex w-full cursor-pointer items-center gap-2 rounded-lg px-3 py-[7px] text-left hover:bg-white/10 focus-visible:bg-white/10 disabled:cursor-default disabled:opacity-50'
  const subItem = `${item} ps-4`
  const head = (id: 'new' | 'sort' | 'view', label: string, disabled = false) => (
    <button type="button" role="menuitem" aria-haspopup="menu" aria-expanded={sub === id} disabled={disabled} onClick={() => setSub((s) => (s === id ? null : id))}
      onKeyDown={(e) => { if (e.key === 'ArrowRight') { e.preventDefault(); setSub(id) } else if (e.key === 'ArrowLeft') { e.preventDefault(); setSub(null) } }} className={item}>
      <span className="flex-1">{label}</span><span aria-hidden="true" className={`text-[#8FA3C8] transition-transform ${sub === id ? 'rotate-90' : ''}`}>›</span>
    </button>
  )
  const H = 420
  return (
    <div id="ws-wall-menu" ref={ref} role="menu" aria-label={t('desk.menu')} onKeyDown={onKey}
      className="absolute z-50 flex max-h-[calc(100%-70px)] w-[230px] flex-col overflow-auto rounded-xl border border-[rgba(127,178,255,0.2)] bg-[rgba(10,24,56,0.97)] p-1 text-[13px] text-[#E8EEFA] shadow-[0_20px_50px_rgba(0,0,0,0.5)]"
      style={{ left: Math.max(4, Math.min(p.x, window.innerWidth - 236)), top: Math.max(4, Math.min(p.y, window.innerHeight - 60 - H)) }}>
      {head('view', t('desk.view'))}
      {sub === 'view' && <div role="group" aria-label={t('desk.view')}>
        {DESK_SIZES.map((s) => <button key={s} type="button" role="menuitemradio" aria-checked={p.view.size === s} onClick={run(() => p.onView({ ...p.view, size: s, show: true }))} className={subItem}><Mark on={p.view.size === s} />{t(SIZE_KEY[s])}</button>)}
        <button type="button" role="menuitemcheckbox" aria-checked={p.view.show} onClick={run(() => p.onView({ ...p.view, show: !p.view.show }))} className={subItem}><Mark on={p.view.show} check />{t('desk.view.show')}</button>
      </div>}
      {head('sort', t('desk.sortBy'))}
      {sub === 'sort' && <div role="group" aria-label={t('desk.sortBy')}>
        {DESK_SORTS.map((s) => <button key={s} type="button" role="menuitemradio" aria-checked={p.view.sort === s} onClick={run(() => p.onView({ ...p.view, sort: s }))} className={subItem}><Mark on={p.view.sort === s} />{t(SORT_KEY[s])}</button>)}
      </div>}
      <button type="button" role="menuitem" onClick={run(p.onRefresh)} className={item}>{t('desk.refresh')}</button>
      <Sep />
      {head('new', t('desk.new'), !p.canCreate)}
      {sub === 'new' && <div role="group" aria-label={t('desk.new')}>
        <button type="button" role="menuitem" onClick={run(p.onNewFolder)} className={subItem}><Mark on={false} />{t('desk.newFolder')}</button>
        <button type="button" role="menuitem" onClick={run(() => p.onNewFile(null))} className={subItem}><Mark on={false} />{t('desk.newText')}</button>
        {p.templates.map((n) => <button key={n} type="button" role="menuitem" onClick={run(() => p.onNewFile(n))} className={subItem}><Mark on={false} />{n.replace(/\.[^.]+$/, '')}</button>)}
      </div>}
      <Sep />
      {p.extra?.map((x) => <button key={x.label} type="button" role="menuitem" onClick={run(x.run)} className={item}>{x.label}</button>)}
      {p.extra?.length ? <Sep /> : null}
      <button type="button" role="menuitem" onClick={run(p.onWallpaper)} className={item}>{t('desk.wallpaper')}</button>
      <button type="button" role="menuitem" onClick={run(p.onDisplay)} className={item}>{t('desk.display')}</button>
      <button type="button" role="menuitem" onClick={run(p.onPersonalize)} className={item}>{t('desk.personalize')}</button>
    </div>
  )
}

const Sep = () => <div role="separator" className="mx-2 my-1 h-px bg-[rgba(127,178,255,0.12)]" />
/** Leading slot of a sub-entry: a dot for the chosen option, a tick for a switch that is on. */
const Mark = ({ on, check = false }: { on: boolean; check?: boolean }) => (
  <span aria-hidden="true" className="flex w-3 shrink-0 justify-center">
    {on && (check ? <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="#7FB2FF" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round"><path d="M4 12l5 5L20 6" /></svg> : <span className="size-1.5 rounded-full bg-[#7FB2FF]" />)}
  </span>
)

/** Creates "New folder" / "New text document.txt" / a template copy with a free name; returns it or an error. */
export async function createOnDesktop(folder: DesktopFolder, kind: { folder: true } | { template: string | null }, names: { folder: string; text: string }): Promise<{ ok: true; name: string } | { ok: false; name: string; error: string }> {
  const rel = folder.rel
  const taken = folder.entries.map((e) => e.name)
  const name = uniqueName(taken, 'folder' in kind ? names.folder : kind.template ?? `${names.text}.txt`)
  if (rel === null) return { ok: false, name, error: 'unavailable' }
  const r = 'folder' in kind ? await os.filesMkdir('home', rel, name)
    : os.filesNewFile ? await os.filesNewFile('home', rel, name, kind.template) : { ok: false as const, error: 'unavailable' }
  return r.ok ? { ok: true, name } : { ok: false, name, error: r.error }
}

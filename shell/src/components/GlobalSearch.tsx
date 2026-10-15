// Global search (design board docs/design/boot-install/project/GlobalSearch.dc.html; WSOS-LCH, DSK-010).
// Real results only: apps, Settings pages, WorkSuite records and Drive files from the main-process bridge
// (electron/search.ts), and local recent files. Signed out or offline is said in the list and the footer.
import { useEffect, useMemo, useRef, useState } from 'react'
import { os } from '../lib/os'
import type { SearchHit, SourceResult } from '../../electron/search'
import type { LauncherApp } from '../lib/launcher'
import { buildGroups, categories, coverage, flat, GROUP_LABEL, markOf, navigate, visible, type Category, type Item, type NavKey } from '../lib/globalSearch'
import { useT, type MessageKey } from '../i18n'

export interface GlobalSearchProps {
  query: string
  onQuery(q: string): void
  apps: LauncherApp[]
  settings: { label: string; section: string }[]
  onLaunchApp(id: string): void
  onOpenSettings(section: string): void
  onClose(): void
}

const SOURCE_LABEL: Record<string, MessageKey> = { worksuite: 'search.source.worksuite', drive: 'search.source.drive' }
const STATE_LABEL: Record<string, MessageKey> = {
  not_signed_in: 'search.state.not_signed_in', locked: 'search.state.locked', auth_required: 'search.state.auth_required',
  offline: 'search.state.offline', timeout: 'search.state.timeout', error: 'search.state.error',
}

export default function GlobalSearch({ query, onQuery, apps, settings, onLaunchApp, onOpenSettings, onClose }: GlobalSearchProps) {
  const t = useT()
  const input = useRef<HTMLInputElement>(null)
  const [cat, setCat] = useState<Category>('all')
  const [sel, setSel] = useState(0)
  const [hits, setHits] = useState<SearchHit[] | null>(null)
  const [sources, setSources] = useState<SourceResult[] | null>(null)
  const [loading, setLoading] = useState(false)
  const [local, setLocal] = useState<SearchHit[]>([])

  useEffect(() => { const el = input.current; if (el) { el.focus(); el.setSelectionRange(el.value.length, el.value.length) } }, [])
  useEffect(() => { let live = true; void os.recentFiles().then((r) => { if (live) setLocal(r.local) }).catch(() => {}); return () => { live = false } }, [])

  // Each keystroke asks the bridge; it debounces and cancels the previous query, which resolves as cancelled.
  useEffect(() => {
    let live = true
    setLoading(true); setSel(0)
    void os.search(query).then((r) => {
      if (!live || r.cancelled) return
      setHits(r.hits); setSources(r.sources); setLoading(false)
    }).catch(() => { if (live) { setHits([]); setSources(null); setLoading(false) } })
    return () => { live = false }
  }, [query])

  const q = query.trim().toLowerCase()
  const localHits = useMemo(() => local.filter((h) => h.title.toLowerCase().includes(q)), [local, q])
  const signedIn = !!sources?.some((s) => s.state === 'ok')
  const groups = useMemo(() => buildGroups({ apps, settings, local: localHits, hits: loading ? null : hits, query }, signedIn), [apps, settings, localHits, hits, loading, query, signedIn])
  const cats = categories(groups)
  const shown = visible(groups, cats.some((c) => c.id === cat) ? cat : 'all')
  const items = flat(shown)
  const cur = Math.min(sel, Math.max(0, items.length - 1))
  const selected: Item | undefined = items[cur]
  const notes = (sources ?? []).filter((s) => s.state !== 'ok')

  const open = (it: Item | undefined, where: 'open' | 'location' = 'open') => {
    if (!it) return
    if (it.kind === 'app') { onLaunchApp(it.app.id); return }
    if (it.kind === 'setting') { onOpenSettings(it.section); return }
    if (it.kind === 'more') { void os.openSearchResult(`worksuite://search?q=${encodeURIComponent(query.trim())}`); onClose(); return }
    void os.openSearchResult(it.hit.link, where); onClose()
  }

  const onKey = (e: React.KeyboardEvent) => {
    const key: NavKey | null = e.key === 'Tab' ? (e.shiftKey ? 'ShiftTab' : 'Tab') : (['ArrowDown', 'ArrowUp', 'Home', 'End'] as string[]).includes(e.key) ? (e.key as NavKey) : null
    if (key) {
      e.preventDefault()
      const n = navigate({ sel: cur, cat }, key, items.length, cats.map((c) => c.id))
      setSel(n.sel); setCat(n.cat)
    } else if (e.key === 'Enter') { e.preventDefault(); open(selected, e.ctrlKey ? 'location' : 'open') }
    else if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); onClose() }
    else if (e.key === 'c' && e.ctrlKey && selected?.kind === 'hit' && selected.hit.source === 'local' && !window.getSelection()?.toString() && input.current?.selectionStart === input.current?.selectionEnd) {
      e.preventDefault(); void navigator.clipboard?.writeText(decodeURIComponent(new URL(selected.hit.link).pathname)).catch(() => {})
    }
  }

  const actions: [MessageKey, string][] = !selected ? [] : selected.kind === 'hit'
    ? [['search.action.open', 'Enter'], ['search.action.location', 'Ctrl Enter'], ...(selected.hit.source === 'local' ? [['search.action.copyPath', 'Ctrl C'] as [MessageKey, string]] : [])]
    : [['search.action.open', 'Enter']]
  const label = (it: Item) => it.kind === 'app' ? it.app.name : it.kind === 'setting' ? it.label : it.kind === 'more' ? t('search.more', { q: query.trim() }) : it.hit.title
  const detail = (it: Item) => it.kind === 'app' ? t(`launcher.kind.${it.app.kind}` as MessageKey) : it.kind === 'setting' ? t('search.inSettings') : it.kind === 'more' ? t('search.moreHint') : (it.hit.subtitle ?? '')

  let k = 0
  return (
    <div role="dialog" aria-modal="true" aria-label={t('launcher.search')} onKeyDown={onKey} id="ws-launcher"
      className="w-[860px] max-w-full overflow-hidden rounded-[20px] border border-[rgba(127,178,255,0.22)] bg-[rgba(10,24,56,0.98)] font-sans text-[#E8EEFA] shadow-[0_40px_100px_rgba(0,0,0,0.6)]">
      <div className="flex items-center gap-3.5 border-b border-[rgba(127,178,255,0.12)] px-[22px] py-[18px]">
        <svg aria-hidden="true" width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="#7FB2FF" strokeWidth="2" strokeLinecap="round"><circle cx="11" cy="11" r="7" /><path d="m20 20-4-4" /></svg>
        <input ref={input} aria-label={t('search.inputLabel')} value={query} onChange={(e) => onQuery(e.target.value)} placeholder={t('search.placeholder')}
          role="combobox" aria-expanded="true" aria-controls="ws-search-results" aria-activedescendant={selected ? `ws-sr-${cur}` : undefined}
          className="min-w-0 flex-1 border-0 bg-transparent text-[20px] text-white outline-none" />
        <span aria-hidden="true" className="rounded-[5px] border border-[#3D5280] px-[7px] py-[3px] font-mono text-[11px] text-[#8FA3C8]">Esc</span>
      </div>
      <div role="tablist" aria-label={t('search.categories')} className="flex flex-wrap gap-1.5 border-b border-[rgba(127,178,255,0.08)] px-[22px] py-2.5">
        {cats.map((c) => (
          <button key={c.id} type="button" role="tab" aria-selected={c.id === cat} onClick={() => { setCat(c.id); setSel(0); input.current?.focus() }}
            className={`cursor-pointer rounded-full px-[11px] py-[5px] text-xs ${c.id === cat ? 'bg-[#1F6BFF] text-white' : 'bg-white/[0.06] text-[#C9D6EE]'}`}>
            {c.id === 'all' ? t('search.cat.all') : t(GROUP_LABEL[c.id])} <span className="opacity-60">{c.n}</span>
          </button>
        ))}
      </div>
      <div className="flex h-[440px]">
        <div id="ws-search-results" role="listbox" aria-label={t('search.results')} className="flex min-w-0 flex-1 flex-col gap-0.5 overflow-auto px-2.5 py-2">
          {shown.map((g) => (
            <div key={g.id + (g.items[0]?.kind === 'more' ? ':more' : '')} role="group" aria-label={g.items.every((x) => x.kind === 'more') ? t('search.moreGroup') : t(GROUP_LABEL[g.id])} className="flex flex-col gap-0.5">
              {!g.items.every((x) => x.kind === 'more') && <span className="px-3 pt-2 pb-1 text-[11px] tracking-[0.08em] text-[#8FA3C8] uppercase">{t(GROUP_LABEL[g.id])}</span>}
              {g.items.map((it) => {
                const idx = k++
                const m = markOf(it)
                const on = idx === cur
                return (
                  <button key={it.id} id={`ws-sr-${idx}`} type="button" role="option" aria-selected={on} tabIndex={-1}
                    onMouseEnter={() => setSel(idx)} onClick={() => open(it)}
                    className={`flex cursor-pointer items-center gap-3 rounded-[10px] px-3 py-2 text-left ${on ? 'bg-[rgba(31,107,255,0.25)]' : 'bg-transparent'}`}>
                    <span className="flex size-8 flex-none items-center justify-center rounded-lg text-xs font-bold text-white" style={{ background: m.c }}>{m.i}</span>
                    <span className="flex min-w-0 flex-1 flex-col gap-px">
                      <span className="truncate text-sm">{label(it)}</span>
                      <span className="truncate text-[11px] text-[#8FA3C8]">{detail(it)}</span>
                    </span>
                    {on && <span className="font-mono text-[10px] text-[#8FA3C8]">Enter</span>}
                  </button>
                )
              })}
            </div>
          ))}
          {loading && (
            <p role="status" className="m-0 px-3 py-2 text-xs text-[#8FA3C8]">{t('search.loading')}</p>
          )}
          {!loading && notes.map((s) => (
            <p key={s.source} role="status" className="m-0 px-3 py-2 text-xs text-[#8FA3C8]">{t('search.sourceState', { source: t(SOURCE_LABEL[s.source]), state: t(STATE_LABEL[s.state]) })}</p>
          ))}
          {!loading && items.length === 0 && (
            <div className="px-5 py-[60px] text-center text-sm text-[#8FA3C8]">{t('search.empty', { q: query.trim() })}</div>
          )}
        </div>
        <aside aria-label={t('search.preview')} className="flex w-[300px] flex-col gap-3 border-l border-[rgba(127,178,255,0.1)] bg-[rgba(4,10,26,0.35)] p-[18px] max-md:hidden">
          {selected && (
            <>
              <div className="flex h-[140px] items-center justify-center rounded-xl bg-[rgba(14,32,72,0.8)]">
                <span className="flex size-[60px] items-center justify-center rounded-[14px] text-[22px] font-bold text-white" style={{ background: markOf(selected).c }}>{markOf(selected).i}</span>
              </div>
              <span className="text-base font-semibold break-words">{label(selected)}</span>
              <span className="text-xs leading-[1.5] text-[#8FA3C8]">{detail(selected)}</span>
              <div className="mt-auto flex flex-col gap-1.5">
                {actions.map(([a, key], i) => (
                  <span key={a} className={`flex justify-between rounded-lg px-2.5 py-2 text-[13px] ${i === 0 ? 'bg-[rgba(31,107,255,0.2)]' : 'bg-white/[0.04]'}`}>
                    <span>{t(a)}</span><span className="font-mono text-[10px] text-[#8FA3C8]">{key}</span>
                  </span>
                ))}
              </div>
            </>
          )}
        </aside>
      </div>
      <div className="flex flex-wrap gap-5 border-t border-[rgba(127,178,255,0.1)] px-[22px] py-2.5 text-[11px] text-[#8FA3C8]">
        <span>{t('search.hint.navigate')}</span><span>{t('search.hint.open')}</span><span>{t('search.hint.tab')}</span><span>{t('search.hint.location')}</span>
        <span className="ml-auto">{t(coverage(sources, loading))}</span>
      </div>
    </div>
  )
}

export type { SearchHit }

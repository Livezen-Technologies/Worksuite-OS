// Super+V (clipboard history) and Super+. (emoji, symbols), like the Windows 11 panel: recent copies — text, images,
// files — newest first, pin/unpin, delete, Clear all, a search box; choosing an item puts it on the clipboard and
// pastes it into the app that had the focus (electron/desktopHost.ts: focus it again, Ctrl+V through wtype). Emoji and
// symbols are typed into that app. History is off until the person turns it on (here or in Settings › Clipboard);
// the organization can turn it off (policy clipboard_history).
//
// Keyboard: Tab between the tabs, the search box and the list; Up/Down move through items, Enter pastes, Delete
// removes, Ctrl+P pins; Esc closes. Over a capture of the screen when there is one, so it looks like it floats over
// the app (the shell's window is lifted over the apps while it is open).
import { useEffect, useMemo, useRef, useState, type KeyboardEvent } from 'react'
import { createPortal } from 'react-dom'
import { desktopApi, type ClipEntry, type ClipState } from '../lib/desktopApi'
import { EMOJI, SYMBOLS, searchEmoji } from '../lib/emoji'
import { captureApi } from '../lib/captureApi'
import { formatTime, t, useT, type MessageKey } from '../i18n'
import { requestSettingsSection } from '../lib/settingsNav'

export type FlyoutTab = 'emoji' | 'symbols' | 'clipboard'
const TABS: { id: FlyoutTab; icon: string }[] = [
  { id: 'emoji', icon: 'M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18zM8.5 14.5s1.3 2 3.5 2 3.5-2 3.5-2M9 9.5h.01M15 9.5h.01' },
  { id: 'symbols', icon: 'M5 19h4l-2-6a5 5 0 1 1 10 0l-2 6h4' },
  { id: 'clipboard', icon: 'M9 4h6v3H9zM7 5H5v16h14V5h-2' },
]
const PIN = 'M15 4l5 5-3 1-3 3 1 5-2 2-4-4-5 5M9 11l4 4M14 4l-4 6'

export interface ClipboardFlyoutProps {
  tab: FlyoutTab
  /** The app window that had the focus ('' = the shell itself). */
  previous: string
  backdrop?: string | null
  onClose: () => void
  /** For tests and the preview: a state instead of the main process's. */
  initial?: ClipState | null
  onOpenSettings?: () => void
}

export default function ClipboardFlyout({ tab: first, previous, backdrop, onClose, initial, onOpenSettings }: ClipboardFlyoutProps) {
  useT()
  const [tab, setTab] = useState<FlyoutTab>(first)
  const [state, setState] = useState<ClipState | null>(initial ?? null)
  const [q, setQ] = useState('')
  const panel = useRef<HTMLDivElement>(null)
  const search = useRef<HTMLInputElement>(null)
  const returnTo = useRef<HTMLElement | null>(typeof document !== 'undefined' ? (document.activeElement as HTMLElement | null) : null)

  useEffect(() => {
    if (initial !== undefined || !desktopApi) return
    void desktopApi.clipboardState().then(setState).catch(() => {})
    return desktopApi.onClipboard(setState)
  }, [initial])
  useEffect(() => { search.current?.focus() }, [tab])
  useEffect(() => {
    const k = (e: globalThis.KeyboardEvent) => { if (e.key === 'Escape') { e.preventDefault(); onClose() } }
    window.addEventListener('keydown', k)
    return () => window.removeEventListener('keydown', k)
  }, [onClose])

  const entries = useMemo(() => {
    const all = state?.entries ?? []
    const s = q.trim().toLowerCase()
    const list = s ? all.filter((e) => e.text.toLowerCase().includes(s) || (e.files ?? []).some((f) => f.toLowerCase().includes(s))) : all
    return [...list.filter((e) => e.pinned), ...list.filter((e) => !e.pinned)]
  }, [state, q])

  // Inside the shell (no app had the focus): paste into the field that had it, with the shell's own paste.
  const pasteHere = () => { const el = returnTo.current; onClose(); setTimeout(() => { el?.focus?.(); void captureApi?.edit('paste') }, 60) }
  const paste = (e: ClipEntry) => {
    if (!desktopApi) return
    if (!previous) { void desktopApi.clipboardCopy(e.id).then(pasteHere); return }
    onClose()
    void desktopApi.clipboardPaste?.(e.id, previous)
  }
  const typeText = (s: string) => {
    if (!previous) { onClose(); setTimeout(() => { const el = returnTo.current; el?.focus?.(); if (el && 'setRangeText' in el) { (el as HTMLInputElement).setRangeText(s, (el as HTMLInputElement).selectionStart ?? 0, (el as HTMLInputElement).selectionEnd ?? 0, 'end'); el.dispatchEvent(new Event('input', { bubbles: true })) } }, 60); return }
    onClose()
    void desktopApi?.clipboardType?.(s, previous)
  }
  const pin = (e: ClipEntry) => void desktopApi?.clipboardPin?.(e.id, !e.pinned).then(setState)
  const remove = (e: ClipEntry) => void desktopApi?.clipboardRemove(e.id).then(setState)

  const listKeys = (ev: KeyboardEvent<HTMLUListElement>) => {
    const items = [...ev.currentTarget.querySelectorAll<HTMLElement>('[data-clip]')]
    const i = items.indexOf(document.activeElement as HTMLElement)
    if (ev.key === 'ArrowDown' || ev.key === 'ArrowUp') { ev.preventDefault(); items[Math.max(0, Math.min(items.length - 1, i + (ev.key === 'ArrowDown' ? 1 : -1)))]?.focus(); return }
    if (i < 0) return
    const e = entries[i]
    if (ev.key === 'Delete') { ev.preventDefault(); remove(e); items[Math.min(i, items.length - 2)]?.focus() }
    else if (ev.ctrlKey && ev.key.toLowerCase() === 'p') { ev.preventDefault(); pin(e) }
  }
  const gridKeys = (ev: KeyboardEvent<HTMLElement>) => {
    const items = [...ev.currentTarget.querySelectorAll<HTMLElement>('button[data-glyph]')]
    const i = items.indexOf(document.activeElement as HTMLElement)
    const rtl = document.dir === 'rtl' ? -1 : 1
    const step = ({ ArrowRight: rtl, ArrowLeft: -rtl, ArrowDown: 8, ArrowUp: -8 } as Record<string, number>)[ev.key]
    if (step !== undefined && i >= 0) { ev.preventDefault(); items[Math.max(0, Math.min(items.length - 1, i + step))]?.focus() }
  }
  const searchKeys = (ev: KeyboardEvent<HTMLInputElement>) => {
    if (ev.key === 'ArrowDown') { ev.preventDefault(); panel.current?.querySelector<HTMLElement>('[data-clip], button[data-glyph]')?.focus() }
    if (ev.key === 'Enter') {
      ev.preventDefault()
      if (tab === 'clipboard' && entries[0]) paste(entries[0])
      if (tab === 'emoji') { const e = searchEmoji(q)[0]; if (e) typeText(e[0]) }
    }
  }
  const openSettings = () => { onClose(); if (onOpenSettings) onOpenSettings(); else requestSettingsSection('Clipboard') }

  return createPortal(
    <div className="fixed inset-0 z-[85] font-sans" onMouseDown={(e) => { if (e.target === e.currentTarget) onClose() }}>
      {backdrop && <img src={backdrop} alt="" aria-hidden="true" className="pointer-events-none absolute inset-0 h-full w-full" />}
      <div ref={panel} role="dialog" aria-modal="true" aria-label={t(`flyout.tab.${tab}` as MessageKey)} id="ws-clipboard"
        className="ws-rise absolute bottom-[64px] left-1/2 flex h-[min(480px,calc(100%-90px))] w-[min(380px,calc(100%-24px))] -translate-x-1/2 flex-col overflow-hidden rounded-2xl border border-[rgba(127,178,255,0.22)] bg-[rgba(10,24,56,0.97)] text-[#E8EEFA] shadow-[0_30px_80px_rgba(0,0,0,0.6)] backdrop-blur-[24px]">
        <div role="tablist" aria-label={t('flyout.title')} className="flex items-center gap-1 border-b border-[rgba(127,178,255,0.12)] px-2 pt-2">
          {TABS.map((x) => (
            <button key={x.id} type="button" role="tab" aria-selected={tab === x.id} aria-controls="ws-flyout-body" title={t(`flyout.tab.${x.id}` as MessageKey)} onClick={() => { setTab(x.id); setQ('') }}
              className={`flex h-9 cursor-pointer items-center gap-1.5 rounded-t-lg px-3 text-[13px] ${tab === x.id ? 'border-b-2 border-[#18D4F0] text-white' : 'text-[#8FA3C8] hover:bg-white/[0.06]'}`}>
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d={x.icon} /></svg>
              <span>{t(`flyout.tab.${x.id}` as MessageKey)}</span>
            </button>
          ))}
        </div>
        {tab !== 'symbols' && (
          <label className="mx-3 mt-3 flex h-9 shrink-0 items-center gap-2 rounded-lg border border-[rgba(127,178,255,0.2)] bg-[rgba(4,10,26,0.6)] px-3 text-[#8FA3C8] focus-within:border-[#1F6BFF]">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" aria-hidden="true"><path d="M11 4a7 7 0 1 0 0 14 7 7 0 0 0 0-14zM20 20l-4-4" /></svg>
            <input ref={search} type="search" value={q} onChange={(e) => setQ(e.target.value)} onKeyDown={searchKeys} aria-label={t(tab === 'clipboard' ? 'flyout.searchClipboard' : 'flyout.searchEmoji')}
              placeholder={t(tab === 'clipboard' ? 'flyout.searchClipboard' : 'flyout.searchEmoji')} className="grow border-0 bg-transparent text-[13px] text-[#E8EEFA] outline-none placeholder:text-[#8FA3C8]" />
          </label>
        )}
        <div id="ws-flyout-body" role="tabpanel" className="flex min-h-0 flex-1 flex-col">
          {tab === 'clipboard' && (
            !desktopApi && initial === undefined ? <Note text={t('flyout.unavailable')} />
              : state?.blocked ? <Note text={t('flyout.blocked')} />
                : state && !state.enabled ? (
                  <div className="flex flex-col items-start gap-3 p-4">
                    <p className="m-0 text-sm font-semibold">{t('flyout.offTitle')}</p>
                    <p className="m-0 text-[13px] leading-[1.45] text-[#C9D6EE]">{t('flyout.offBody')}</p>
                    <button type="button" onClick={() => void desktopApi?.clipboardSetEnabled(true).then(setState)} className="cursor-pointer rounded-lg bg-[#1F6BFF] px-4 py-2 text-[13px] font-semibold text-white hover:bg-[#3A7DFF]">{t('flyout.turnOn')}</button>
                  </div>
                ) : (
                  <>
                    <div className="flex items-center justify-between px-4 pt-3 pb-1.5">
                      <span className="text-[12px] text-[#8FA3C8]">{t('flyout.clipboardHint')}</span>
                      <button type="button" disabled={!state?.entries.some((e) => !e.pinned)} onClick={() => void desktopApi?.clipboardClear().then(setState)} className="cursor-pointer rounded-md px-2 py-1 text-[12px] text-[#7FB2FF] hover:bg-white/[0.06] disabled:cursor-default disabled:opacity-40">{t('flyout.clearAll')}</button>
                    </div>
                    {entries.length ? (
                      <ul aria-label={t('flyout.tab.clipboard')} className="m-0 flex min-h-0 flex-1 list-none flex-col gap-1.5 overflow-auto px-3 pb-3" onKeyDown={listKeys}>
                        {entries.map((e) => <Item key={e.id} e={e} onPaste={() => paste(e)} onPin={() => pin(e)} onRemove={() => remove(e)} />)}
                      </ul>
                    ) : <Note text={q ? t('flyout.noMatch') : t('flyout.empty')} />}
                  </>
                )
          )}
          {tab === 'emoji' && (
            <div className="min-h-0 flex-1 overflow-auto px-3 pb-3" onKeyDown={gridKeys}>
              {q.trim() ? <Glyphs label={t('flyout.results')} items={searchEmoji(q).map(([e, w]) => [e, w])} onPick={typeText} />
                : EMOJI.map((g) => <Glyphs key={g.id} label={t(`emoji.${g.id}` as MessageKey)} items={g.items} onPick={typeText} />)}
              {q.trim() && !searchEmoji(q).length && <Note text={t('flyout.noMatch')} />}
            </div>
          )}
          {tab === 'symbols' && (
            <div className="min-h-0 flex-1 overflow-auto px-3 pt-2 pb-3" onKeyDown={gridKeys}>
              {SYMBOLS.map((g) => <Glyphs key={g.id} label={t(`symbols.${g.id}` as MessageKey)} items={g.items.map((s) => [s, s])} onPick={typeText} />)}
            </div>
          )}
        </div>
        <div className="flex items-center justify-between border-t border-[rgba(127,178,255,0.12)] px-4 py-2 text-[12px] text-[#8FA3C8]">
          <span>{t('flyout.footer')}</span>
          <button type="button" onClick={openSettings} className="cursor-pointer rounded px-1.5 py-0.5 text-[#7FB2FF] hover:text-[#B8D4FF]">{t('flyout.settings')}</button>
        </div>
      </div>
    </div>,
    document.body,
  )
}

function Note({ text }: { text: string }) {
  return <p className="m-0 px-4 py-6 text-center text-[13px] leading-[1.45] text-[#8FA3C8]">{text}</p>
}

function Item({ e, onPaste, onPin, onRemove }: { e: ClipEntry; onPaste: () => void; onPin: () => void; onRemove: () => void }) {
  const label = e.kind === 'image' ? t('flyout.image') : e.kind === 'files' ? t('flyout.files', { count: e.files?.length ?? 0 }) : e.text.slice(0, 200)
  return (
    <li className="group relative rounded-xl border border-[rgba(127,178,255,0.12)] bg-[rgba(14,32,72,0.6)] hover:border-[rgba(127,178,255,0.3)] focus-within:border-[#1F6BFF]">
      <button type="button" data-clip onClick={onPaste} aria-label={`${label}${e.pinned ? `, ${t('flyout.pinned')}` : ''}`} aria-description={t('flyout.pasteHint')}
        className="block w-full cursor-pointer rounded-xl px-3 py-2.5 pe-[72px] text-start outline-none">
        {e.kind === 'image' ? (
          e.image ? <img src={e.image} alt="" className="max-h-[120px] max-w-full rounded-md" /> : <span className="text-[13px]">{t('flyout.image')}</span>
        ) : e.kind === 'files' ? (
          <span className="flex flex-col gap-0.5">{(e.files ?? []).slice(0, 4).map((f) => (
            <span key={f} className="flex items-center gap-1.5 truncate text-[13px]"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="#7FB2FF" strokeWidth="2" aria-hidden="true"><path d="M6 3h8l4 4v14H6z" /></svg><span className="truncate">{f.split('/').pop()}</span></span>
          ))}{(e.files?.length ?? 0) > 4 && <span className="text-[12px] text-[#8FA3C8]">{t('flyout.more', { count: (e.files?.length ?? 0) - 4 })}</span>}</span>
        ) : <span className="line-clamp-3 text-[13px] leading-[1.4] break-words whitespace-pre-wrap">{e.text}</span>}
        <span className="mt-1 block text-[11px] text-[#8FA3C8]">{formatTime(new Date(e.at))}</span>
      </button>
      <span className="absolute top-1.5 end-1.5 flex gap-0.5">
        <button type="button" aria-pressed={!!e.pinned} aria-label={e.pinned ? t('flyout.unpin') : t('flyout.pin')} title={e.pinned ? t('flyout.unpin') : t('flyout.pin')} onClick={onPin}
          className={`flex h-7 w-7 cursor-pointer items-center justify-center rounded-md hover:bg-white/10 focus-visible:opacity-100 ${e.pinned ? 'text-[#18D4F0]' : 'text-[#8FA3C8] opacity-0 group-hover:opacity-100 group-focus-within:opacity-100'}`}>
          <svg width="14" height="14" viewBox="0 0 24 24" fill={e.pinned ? 'currentColor' : 'none'} stroke="currentColor" strokeWidth="2" strokeLinejoin="round" aria-hidden="true"><path d={PIN} /></svg>
        </button>
        <button type="button" aria-label={t('flyout.delete')} title={t('flyout.delete')} onClick={onRemove}
          className="flex h-7 w-7 cursor-pointer items-center justify-center rounded-md text-[#8FA3C8] opacity-0 group-hover:opacity-100 group-focus-within:opacity-100 hover:bg-white/10 focus-visible:opacity-100">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden="true"><path d="M4 7h16M10 11v6M14 11v6M6 7l1 13h10l1-13M9 7V4h6v3" /></svg>
        </button>
      </span>
    </li>
  )
}

function Glyphs({ label, items, onPick }: { label: string; items: [string, string][]; onPick: (s: string) => void }) {
  return (
    <section aria-label={label} className="pt-2">
      <h3 className="m-0 px-1 pb-1 text-[11px] font-semibold tracking-[0.06em] text-[#8FA3C8] uppercase">{label}</h3>
      <div className="grid grid-cols-8 gap-0.5">
        {items.map(([g, words]) => (
          <button key={g} type="button" data-glyph onClick={() => onPick(g)} aria-label={words.split(' ')[0] || g} title={words.split(' ')[0] || g}
            className="flex h-10 cursor-pointer items-center justify-center rounded-lg text-[20px] hover:bg-white/10 focus-visible:bg-white/10">{g}</button>
        ))}
      </div>
    </section>
  )
}

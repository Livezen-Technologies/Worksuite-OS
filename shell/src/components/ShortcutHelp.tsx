// Keyboard shortcut cheat sheet: Super+/ (rc.xml → Shell1.Open shortcuts) or holding Super for a second while the
// shell has the focus. Every system shortcut by category, with the person's own changes and custom shortcuts
// (lib/shortcuts.ts); "Change shortcuts" opens Settings › Keyboard › Shortcuts. Esc closes.
import { useEffect, useMemo, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { CATEGORIES, SYSTEM_SHORTCUTS, categoryLabel, effectiveKeys, keyCaps, shortcutLabel, type ShortcutPrefs } from '../lib/shortcuts'
import { t, useT } from '../i18n'

export function Keys({ k, small }: { k: string; small?: boolean }) {
  const caps = keyCaps(k)
  return (
    <span className="inline-flex shrink-0 items-center gap-1" aria-label={caps.join(' + ')} role="img">
      {caps.map((c, i) => (
        <kbd key={i} aria-hidden="true" className={`rounded-md border border-[rgba(127,178,255,0.3)] border-b-[3px] bg-[rgba(4,10,26,0.6)] font-sans font-semibold text-[#E8EEFA] ${small ? 'px-1.5 py-0 text-[11px]' : 'px-2 py-0.5 text-[12px]'}`}>{c}</kbd>
      ))}
    </span>
  )
}

export default function ShortcutHelp({ prefs, backdrop, onClose, onSettings }: { prefs?: ShortcutPrefs; backdrop?: string | null; onClose: () => void; onSettings: () => void }) {
  useT()
  const [q, setQ] = useState('')
  const box = useRef<HTMLDivElement>(null)
  const input = useRef<HTMLInputElement>(null)
  useEffect(() => {
    const prev = document.activeElement as HTMLElement | null
    input.current?.focus()
    const k = (e: KeyboardEvent) => { if (e.key === 'Escape') { e.preventDefault(); onClose() } }
    window.addEventListener('keydown', k)
    return () => { window.removeEventListener('keydown', k); prev?.focus?.() }
  }, [onClose])
  const groups = useMemo(() => {
    const s = q.trim().toLowerCase()
    return CATEGORIES.map((c) => {
      const rows = SYSTEM_SHORTCUTS.filter((x) => x.category === c).map((x) => ({ id: x.id, label: t(shortcutLabel(x.id)), keys: x.display ? [x.display] : effectiveKeys(x, prefs) }))
      const custom = c === 'apps' ? (prefs?.custom ?? []).map((x) => ({ id: x.id, label: x.name || x.app || x.command || '', keys: [x.key] })) : []
      return { c, rows: [...rows, ...custom].filter((r) => r.keys.length && (!s || r.label.toLowerCase().includes(s) || r.keys.some((k) => keyCaps(k).join('+').toLowerCase().includes(s)))) }
    }).filter((g) => g.rows.length)
  }, [q, prefs])

  return createPortal(
    <div className="fixed inset-0 z-[85] flex items-center justify-center p-4 font-sans" style={{ background: backdrop ? undefined : 'rgba(2,6,16,0.55)' }} onMouseDown={(e) => { if (e.target === e.currentTarget) onClose() }}>
      {backdrop && <img src={backdrop} alt="" aria-hidden="true" className="pointer-events-none absolute inset-0 h-full w-full" />}
      {backdrop && <div aria-hidden="true" className="pointer-events-none absolute inset-0 bg-[rgba(2,6,16,0.45)]" />}
      <div ref={box} role="dialog" aria-modal="true" aria-labelledby="ws-sc-title" className="ws-rise relative flex max-h-full w-[min(980px,100%)] flex-col overflow-hidden rounded-2xl border border-[rgba(127,178,255,0.22)] bg-[rgba(10,24,56,0.97)] text-[#E8EEFA] shadow-[0_30px_80px_rgba(0,0,0,0.6)]">
        <div className="flex flex-wrap items-center gap-3 border-b border-[rgba(127,178,255,0.12)] px-6 py-4">
          <h2 id="ws-sc-title" className="m-0 text-lg font-semibold">{t('sc.title')}</h2>
          <input ref={input} type="search" value={q} onChange={(e) => setQ(e.target.value)} aria-label={t('sc.search')} placeholder={t('sc.search')}
            className="h-9 w-56 rounded-lg border border-[rgba(127,178,255,0.25)] bg-[rgba(4,10,26,0.5)] px-3 text-[13px] text-[#E8EEFA] outline-none focus:border-[#1F6BFF]" />
          <span className="flex-1" />
          <button type="button" onClick={onSettings} className="cursor-pointer rounded-lg px-3 py-1.5 text-[13px] text-[#7FB2FF] hover:bg-white/[0.06]">{t('sc.change')}</button>
          <button type="button" aria-label={t('common.close')} onClick={onClose} className="flex h-9 w-9 cursor-pointer items-center justify-center rounded-lg text-[#8FA3C8] hover:bg-white/10 hover:text-white">
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" aria-hidden="true"><path d="M6 6l12 12M18 6L6 18" /></svg>
          </button>
        </div>
        <div className="min-h-0 flex-1 overflow-auto px-6 py-4 [column-gap:28px] [columns:300px]">
          {groups.map((g) => (
            <section key={g.c} aria-labelledby={`ws-sc-${g.c}`} className="mb-5 break-inside-avoid">
              <h3 id={`ws-sc-${g.c}`} className="m-0 mb-2 text-[12px] font-semibold tracking-[0.08em] text-[#18D4F0] uppercase">{t(categoryLabel(g.c))}</h3>
              <dl className="m-0 flex flex-col gap-1.5">
                {g.rows.map((r) => (
                  <div key={r.id} className="flex items-center justify-between gap-3">
                    <dt className="text-[13px] text-[#C9D6EE]">{r.label}</dt>
                    <dd className="m-0 flex flex-wrap justify-end gap-1.5">{r.keys.map((k) => <Keys key={k} k={k} small />)}</dd>
                  </div>
                ))}
              </dl>
            </section>
          ))}
          {!groups.length && <p className="m-0 text-[13px] text-[#8FA3C8]">{t('sc.noMatch')}</p>}
        </div>
        <p className="m-0 border-t border-[rgba(127,178,255,0.12)] px-6 py-2.5 text-[12px] text-[#8FA3C8]">{t('sc.helpFooter')}</p>
      </div>
    </div>,
    document.body,
  )
}

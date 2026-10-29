import { useEffect, useRef } from 'react'
import { motionReduced, setA11y, systemReducedMotion, TEXT_SCALES, useA11y } from '../lib/a11y'
import { rowLine, Switch } from './Dk'
import { LOCALES, REVIEW, setLocale, useT, getLocale, type Locale } from '../i18n'

// Accessibility quick panel (WSOS-ACC-001…006): high contrast, reduced motion, text size and language.
// Opened from the greeter's and the desktop's Accessibility buttons; Escape closes it and focus returns to the opener.
export default function A11yPanel({ onClose, className = '' }: { onClose: () => void; className?: string }) {
  const t = useT()
  const prefs = useA11y()
  const ref = useRef<HTMLDivElement>(null)
  const sysMotion = systemReducedMotion()

  useEffect(() => {
    const opener = document.activeElement as HTMLElement | null
    ref.current?.querySelector<HTMLElement>('[role=switch], input, select')?.focus()
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') { e.stopPropagation(); onClose() } }
    window.addEventListener('keydown', onKey, true)
    return () => { window.removeEventListener('keydown', onKey, true); opener?.focus?.() }
  }, [onClose])

  // #70: one design-system look (Dk tokens, --ws-g-* theme variables): grouped rows on a card, the Settings switch with
  // its On/Off word, a segmented control for text size, the language picker full width under its label. Sizes are in
  // rem; the width follows --ws-text-scale (20rem at 100%, 26rem at 200%) because text size scales the text, not rem.
  const group = 'flex flex-col overflow-hidden rounded-[0.75rem] border border-[var(--ws-g-line)] bg-[var(--ws-g-card)]'
  // The label takes the free width and wraps; the switch keeps its place at the end of the row at every text size.
  const row = 'flex min-h-[2.75rem] items-center justify-between gap-3 px-[0.875rem] py-2 text-sm'
  const heading = 'm-0 px-1 text-xs font-medium uppercase tracking-[0.08em] text-[var(--ws-g-muted)]'
  const pick = (dir: 1 | -1) => {
    const i = Math.max(0, TEXT_SCALES.indexOf(prefs.textScale))
    const next = TEXT_SCALES[(i + dir + TEXT_SCALES.length) % TEXT_SCALES.length]
    setA11y({ textScale: next })
    ref.current?.querySelector<HTMLElement>(`[data-scale="${next}"]`)?.focus()
  }
  return (
    <div ref={ref} role="dialog" aria-modal="false" aria-labelledby="ws-a11y-title" data-testid="a11y-panel"
      className={`absolute z-50 flex w-[calc(14rem+6rem*var(--ws-text-scale,1))] max-w-[calc(100vw-2rem)] max-h-[calc(100vh-5rem)] flex-col gap-3 overflow-y-auto rounded-2xl border border-[rgba(127,178,255,0.25)] bg-[var(--ws-g-dialog)] p-4 text-[var(--ws-g-ink)] shadow-[0_24px_60px_rgba(0,0,0,0.5)] ${className}`}>
      <div className="flex items-center justify-between gap-2">
        <h2 id="ws-a11y-title" className="m-0 text-base font-semibold">{t('a11y.title')}</h2>
        <button type="button" aria-label={t('a11y.close')} onClick={onClose} className="flex size-[2.75rem] -mr-2 cursor-pointer items-center justify-center rounded-lg text-lg text-[var(--ws-g-soft)] hover:bg-white/10">×</button>
      </div>
      <section aria-labelledby="ws-a11y-display" className="flex flex-col gap-1.5">
        <h3 id="ws-a11y-display" className={heading}>{t('a11y.group.display')}</h3>
        <div className={group}>
          <div className={row}>
            <span className="min-w-0 flex-1">{t('a11y.highContrast')}</span>
            <span className="shrink-0"><Switch label={t('a11y.highContrast')} checked={prefs.highContrast} onChange={(v) => setA11y({ highContrast: v })} small /></span>
          </div>
          <div className={`${row} ${rowLine}`}>
            <span className="flex min-w-0 flex-1 flex-col">
              <span>{t('a11y.reducedMotion')}</span>
              {sysMotion && <span className="text-xs text-[var(--ws-g-soft)]">{t('a11y.reducedMotionSystem')}</span>}
            </span>
            <span className="shrink-0"><Switch label={t('a11y.reducedMotion')} checked={motionReduced(prefs)} disabled={sysMotion} onChange={(v) => setA11y({ reducedMotion: v })} small /></span>
          </div>
          <div className={`flex flex-col gap-2 px-[0.875rem] py-2.5 text-sm ${rowLine}`}>
            <span id="ws-a11y-size">{t('a11y.textSize')}</span>
            <div role="radiogroup" aria-labelledby="ws-a11y-size" data-testid="a11y-text-size"
              onKeyDown={(e) => { if (e.key === 'ArrowRight' || e.key === 'ArrowDown') { e.preventDefault(); pick(1) } else if (e.key === 'ArrowLeft' || e.key === 'ArrowUp') { e.preventDefault(); pick(-1) } }}
              className="grid gap-0.5 rounded-[0.625rem] border border-[var(--ws-g-line)] bg-[var(--ws-g-field)] p-0.5" style={{ gridTemplateColumns: `repeat(${TEXT_SCALES.length}, minmax(0, 1fr))` }}>
              {TEXT_SCALES.map((s) => {
                const on = prefs.textScale === s
                return (
                  <button key={s} type="button" role="radio" aria-checked={on} tabIndex={on ? 0 : -1} data-scale={s} onClick={() => setA11y({ textScale: s })}
                    className={`min-h-[2.25rem] cursor-pointer whitespace-nowrap rounded-lg px-1 text-sm tabular-nums transition-colors ${on ? 'bg-[#1F6BFF] font-semibold text-white shadow-[0_1px_3px_rgba(0,0,0,0.35)]' : 'text-[var(--ws-g-soft)] hover:bg-white/10'}`}>{Math.round(s * 100)}%</button>
                )
              })}
            </div>
          </div>
        </div>
      </section>
      <section aria-labelledby="ws-a11y-lang-h" className="flex flex-col gap-1.5">
        <h3 id="ws-a11y-lang-h" className={heading}>{t('a11y.language')}</h3>
        <div className={`${group} px-[0.875rem] py-2.5`}>
          <select aria-labelledby="ws-a11y-lang-h" value={getLocale()} onChange={(e) => setLocale(e.target.value as Locale)}
            className="min-h-[2.5rem] w-full cursor-pointer rounded-[0.5625rem] border border-[rgba(127,178,255,0.25)] bg-[var(--ws-g-field)] px-3 text-sm text-[var(--ws-g-ink)] outline-none focus:border-[#1F6BFF]">
            {LOCALES.map((l) => <option key={l.id} value={l.id} lang={l.id}>{l.id !== 'en' && !REVIEW[l.id].reviewed ? t('a11y.languageDraft', { name: l.name }) : l.name}</option>)}
          </select>
        </div>
      </section>
    </div>
  )
}

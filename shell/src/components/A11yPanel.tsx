import { useEffect, useRef } from 'react'
import { motionReduced, setA11y, systemReducedMotion, TEXT_SCALES, useA11y } from '../lib/a11y'
import { LOCALES, setLocale, useT, getLocale, type Locale } from '../i18n'

// Accessibility quick panel (WSOS-ACC-001…006): high contrast, reduced motion, text size and language.
// Opened from the greeter's and the desktop's Accessibility buttons; Escape closes it and focus returns to the opener.
export default function A11yPanel({ onClose, className = '' }: { onClose: () => void; className?: string }) {
  const t = useT()
  const prefs = useA11y()
  const ref = useRef<HTMLDivElement>(null)
  const sysMotion = systemReducedMotion()

  useEffect(() => {
    const opener = document.activeElement as HTMLElement | null
    ref.current?.querySelector<HTMLElement>('input, button, select')?.focus()
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') { e.stopPropagation(); onClose() } }
    window.addEventListener('keydown', onKey, true)
    return () => { window.removeEventListener('keydown', onKey, true); opener?.focus?.() }
  }, [onClose])

  const row = 'flex min-h-11 items-center justify-between gap-4 rounded-lg px-1 text-sm'
  return (
    <div ref={ref} role="dialog" aria-modal="false" aria-labelledby="ws-a11y-title"
      className={`absolute z-50 flex w-[320px] max-w-[calc(100vw-32px)] flex-col gap-2 rounded-2xl border border-[rgba(127,178,255,0.25)] bg-[#0A1838] p-4 text-[#E8EEFA] shadow-[0_24px_60px_rgba(0,0,0,0.5)] ${className}`}>
      <div className="flex items-center justify-between">
        <h2 id="ws-a11y-title" className="m-0 text-base font-semibold">{t('a11y.title')}</h2>
        <button type="button" aria-label={t('a11y.close')} onClick={onClose} className="flex size-8 cursor-pointer items-center justify-center rounded-md text-[#C9D6EE] hover:bg-white/10">×</button>
      </div>
      <label className={row}>
        <span>{t('a11y.highContrast')}</span>
        <input type="checkbox" role="switch" checked={prefs.highContrast} onChange={(e) => setA11y({ highContrast: e.target.checked })} className="size-5 accent-[#1F6BFF]" />
      </label>
      <label className={row}>
        <span className="flex flex-col">
          <span>{t('a11y.reducedMotion')}</span>
          {sysMotion && <span className="text-xs text-[#C9D6EE]">{t('a11y.reducedMotionSystem')}</span>}
        </span>
        <input type="checkbox" role="switch" checked={motionReduced(prefs)} disabled={sysMotion} onChange={(e) => setA11y({ reducedMotion: e.target.checked })} className="size-5 accent-[#1F6BFF]" />
      </label>
      <fieldset className="m-0 flex flex-col gap-1.5 border-0 p-0 px-1">
        <legend className="mb-1.5 p-0 text-sm">{t('a11y.textSize')}</legend>
        <div className="flex gap-1.5">
          {TEXT_SCALES.map((s) => (
            <button key={s} type="button" aria-pressed={prefs.textScale === s} onClick={() => setA11y({ textScale: s })}
              className={`h-9 flex-1 cursor-pointer rounded-lg text-sm ${prefs.textScale === s ? 'bg-[#1F6BFF] font-semibold text-white' : 'bg-white/[0.08] hover:bg-white/15'}`}>{s * 100}%</button>
          ))}
        </div>
      </fieldset>
      <label className={row}>
        <span>{t('a11y.language')}</span>
        <select value={getLocale()} onChange={(e) => setLocale(e.target.value as Locale)} className="h-9 rounded-lg border border-white/20 bg-[#0A1838] px-2 text-sm text-[#E8EEFA]">
          {LOCALES.map((l) => <option key={l.id} value={l.id} lang={l.id}>{l.name}</option>)}
        </select>
      </label>
    </div>
  )
}

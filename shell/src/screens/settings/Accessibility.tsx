// Settings › Accessibility: GNOME's accessibility settings (electron/a11y.ts). The panel re-reads after each change.
import { useEffect, useState, type ReactNode } from 'react'
import { Switch, card, sectionLabel } from '../../components/Dk'
import { Empty } from '../Hardware'
import { os, type A11yResult, type A11ySettings } from '../../lib/os'
import { formatNumber, t } from '../../i18n'
import { H1, Note, Unavail } from './ui'

const Row = ({ label, children }: { label: string; children: ReactNode }) => (
  <div className="flex items-center justify-between gap-4"><span className="text-[14px] text-[#E8EEFA]">{label}</span>{children}</div>
)

function Choice({ label, value, options, onChange, disabled }: { label: string; value: number; options: { v: number; label: string }[]; onChange: (v: number) => void; disabled: boolean }) {
  return (
    <div className="flex flex-wrap items-center justify-between gap-3">
      <span className="text-[14px] text-[#E8EEFA]">{label}</span>
      <div role="radiogroup" aria-label={label} className="flex rounded-xl border border-[rgba(127,178,255,0.18)] bg-[rgba(4,10,26,0.45)] p-1">
        {options.map((o) => (
          <button key={o.v} type="button" role="radio" aria-checked={Math.abs(value - o.v) < 0.01} disabled={disabled} onClick={() => onChange(o.v)}
            className={`h-9 min-w-[64px] rounded-[9px] px-3 text-[13px] font-semibold disabled:opacity-50 ${Math.abs(value - o.v) < 0.01 ? 'bg-[#1F6BFF] text-white' : 'text-[#C9D6EE] hover:bg-[rgba(255,255,255,0.08)]'}`}>{o.label}</button>
        ))}
      </div>
    </div>
  )
}

export function AccessibilityPanel() {
  const [s, setS] = useState<A11yResult | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState(false)
  useEffect(() => { void os.a11y().then(setS) }, [])
  const set = async (c: Partial<A11ySettings>) => {
    setBusy(true); setError(false)
    const r = await os.setA11y(c)
    if (r.available) setS(r); else { setError(true); void os.a11y().then(setS) }
    setBusy(false)
    return r.available
  }
  const title = <H1>{t('settings.nav.Accessibility')}</H1>
  if (!s) return <>{title}<Empty title={t('settings.a11y.reading')} /></>
  if (!s.available) return <>{title}<Unavail what={t('settings.nav.Accessibility')} reason={s.reason} /></>
  const v = s.value
  const pct = (x: number) => `${formatNumber(Math.round(x * 100))}%`
  return <>
    {title}
    {error && <p role="alert" className="m-0 text-[13px] text-[#FFB4A6]">{t('settings.a11y.failed')}</p>}
    <div className={sectionLabel}>{t('settings.a11y.vision')}</div>
    <div className={`${card} flex flex-col gap-4 px-5 py-[18px]`}>
      <Choice label={t('settings.a11y.textSize')} value={v.textSize} disabled={busy} options={[1, 1.15, 1.3, 1.5].map((x) => ({ v: x, label: pct(x) }))} onChange={(x) => void set({ textSize: x })} />
      <Choice label={t('settings.a11y.cursor')} value={v.cursorSize} disabled={busy} options={[{ v: 24, label: t('settings.look.small') }, { v: 32, label: t('settings.look.medium') }, { v: 48, label: t('settings.look.large') }]} onChange={(x) => void set({ cursorSize: x })} />
      <Row label={t('settings.a11y.contrast')}><Switch label={t('settings.a11y.contrast')} checked={v.highContrast} disabled={busy} onChange={(x) => set({ highContrast: x })} /></Row>
      <Row label={t('settings.a11y.motion')}><Switch label={t('settings.a11y.motion')} checked={v.reduceMotion} disabled={busy} onChange={(x) => set({ reduceMotion: x })} /></Row>
      <Row label={t('settings.a11y.reader')}><Switch label={t('settings.a11y.reader')} checked={v.screenReader} disabled={busy} onChange={(x) => set({ screenReader: x })} /></Row>
    </div>
    <div className={sectionLabel}>{t('settings.a11y.typing')}</div>
    <div className={`${card} flex flex-col gap-4 px-5 py-[18px]`}>
      <Row label={t('settings.a11y.osk')}><Switch label={t('settings.a11y.osk')} checked={v.screenKeyboard} disabled={busy} onChange={(x) => set({ screenKeyboard: x })} /></Row>
      <Row label={t('settings.a11y.sticky')}><Switch label={t('settings.a11y.sticky')} checked={v.stickyKeys} disabled={busy} onChange={(x) => set({ stickyKeys: x })} /></Row>
      <Row label={t('settings.a11y.slow')}><Switch label={t('settings.a11y.slow')} checked={v.slowKeys} disabled={busy} onChange={(x) => set({ slowKeys: x })} /></Row>
    </div>
    <Note>{t('settings.a11y.note')}</Note>
  </>
}

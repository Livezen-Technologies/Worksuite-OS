// Settings › Personalization: the desktop's look and taskbar (electron/desktopLook.ts → GNOME Shell and its packaged
// extensions). Every control re-reads the desktop after it applies, so the panel shows what the desktop has.
// Glass effects is the switch the design calls Personalization › Visual effects › Glass effects; off means no blur
// work at all and opaque surfaces.
import { useEffect, useState, type ReactNode } from 'react'
import { Switch, card, sectionLabel } from '../../components/Dk'
import { Empty } from '../Hardware'
import { os, type DesktopLook, type DesktopLookChange, type LookAnimations } from '../../lib/os'
import { t, type MessageKey } from '../../i18n'
import { H1, Note, Unavail } from './ui'

function Segmented<T extends string | number>({ label, value, options, onChange, disabled }: { label: string; value: T; options: { v: T; label: string }[]; onChange: (v: T) => void; disabled?: boolean }) {
  return (
    <div className="flex flex-wrap items-center justify-between gap-3">
      <span className="text-[14px] text-[#E8EEFA]">{label}</span>
      <div role="radiogroup" aria-label={label} className="flex rounded-xl border border-[rgba(127,178,255,0.18)] bg-[rgba(4,10,26,0.45)] p-1">
        {options.map((o) => (
          <button key={String(o.v)} type="button" role="radio" aria-checked={value === o.v} disabled={disabled}
            onClick={() => value !== o.v && onChange(o.v)}
            className={`h-9 min-w-[76px] rounded-[9px] px-3 text-[13px] font-semibold transition-colors disabled:opacity-50 ${value === o.v ? 'bg-[#1F6BFF] text-white' : 'text-[#C9D6EE] hover:bg-[rgba(255,255,255,0.08)]'}`}>
            {o.label}
          </button>
        ))}
      </div>
    </div>
  )
}
const Section = ({ title, children }: { title: string; children: ReactNode }) => (
  <><div className={sectionLabel}>{title}</div><div className={`${card} flex flex-col gap-4 px-5 py-[18px]`}>{children}</div></>
)

export function PersonalizationPanel() {
  const [look, setLook] = useState<{ available: true; value: DesktopLook } | { available: false; reason: string } | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  useEffect(() => { void os.desktopLook().then(setLook) }, [])
  const change = async (c: DesktopLookChange) => {
    setBusy(true); setError(null)
    const r = await os.setDesktopLook(c)
    if (r.available) setLook(r); else { setError(t('settings.look.failed')); void os.desktopLook().then(setLook) }
    setBusy(false)
    return r.available
  }
  const title = <H1>{t('settings.nav.Personalization')}</H1>
  if (!look) return <>{title}<Empty title={t('settings.look.reading')} /></>
  if (!look.available) return <>{title}<Unavail what={t('settings.nav.Personalization')} reason={look.reason} /></>
  const l = look.value
  const anim: { v: LookAnimations; label: string }[] = (['off', 'reduced', 'standard'] as const).map((v) => ({ v, label: t(`settings.look.anim.${v}` as MessageKey) }))
  return <>
    {title}
    {error && <p role="alert" className="m-0 text-[13px] text-[#FFB4A6]">{error}</p>}
    <Section title={t('settings.look.effects')}>
      <Switch label={t('settings.look.glass')} checked={l.glass} disabled={busy} onChange={(v) => change({ glass: v })} />
      <Note>{t('settings.look.glassNote')}</Note>
      <Switch label={t('settings.look.transparency')} checked={l.glass || l.transparency} disabled={busy || l.glass} onChange={(v) => change({ transparency: v })} />
      <Segmented label={t('settings.look.animations')} value={l.animations} options={anim} disabled={busy} onChange={(v) => void change({ animations: v })} />
      <div className="flex flex-wrap items-center justify-between gap-3">
        <span className="text-[13px] text-[#8FA3C8]">{t('settings.look.lightestNote')}</span>
        <button type="button" disabled={busy || (!l.glass && !l.transparency && l.animations === 'off')} onClick={() => void change({ lightest: true })}
          className="h-10 rounded-xl border border-[rgba(127,178,255,0.25)] px-4 text-[13px] font-semibold text-[#E8EEFA] hover:bg-[rgba(255,255,255,0.08)] disabled:opacity-50">{t('settings.look.lightest')}</button>
      </div>
    </Section>
    <Section title={t('settings.look.taskbar')}>
      <Segmented label={t('settings.look.align')} value={l.taskbar.align} disabled={busy}
        options={[{ v: 'center', label: t('settings.look.center') }, { v: 'left', label: t('settings.look.left') }]} onChange={(v) => void change({ taskbar: { align: v } })} />
      <Segmented label={t('settings.look.size')} value={l.taskbar.size} disabled={busy}
        options={[{ v: 40, label: t('settings.look.small') }, { v: 48, label: t('settings.look.medium') }, { v: 56, label: t('settings.look.large') }]} onChange={(v) => void change({ taskbar: { size: v } })} />
      <Segmented label={t('settings.look.position')} value={l.taskbar.position} disabled={busy}
        options={[{ v: 'BOTTOM', label: t('settings.look.bottom') }, { v: 'TOP', label: t('settings.look.top') }]} onChange={(v) => void change({ taskbar: { position: v } })} />
      <Switch label={t('settings.look.autohide')} checked={l.taskbar.autohide} disabled={busy} onChange={(v) => change({ taskbar: { autohide: v } })} />
    </Section>
    <Note>{t('settings.look.note')}</Note>
  </>
}

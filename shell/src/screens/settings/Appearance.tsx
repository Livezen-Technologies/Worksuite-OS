// Settings › Appearance (theme, accent, taskbar alignment) (from Settings.tsx).
import { useEffect, useState } from 'react'
import { localTaskbarAlign, saveTaskbarAlign, shellPrefsFrom, type TaskbarAlign } from '../../lib/shellPrefs'
import { os } from '../../lib/os'
import { ACCENTS, KEYS, THEMES, accentColor, applyAppearance, loadAppearance, writeJson, type Appearance } from '../../lib/setup'
import { t, type MessageKey } from '../../i18n'
import { H1, Rows } from './common'

const THEME_ART: Record<string, { bg: string; win: string; bar: string }> = {
  Light: { bg: 'linear-gradient(135deg,#EAF1FF,#C9DAFF)', win: '#FFFFFF', bar: 'rgba(255,255,255,0.8)' },
  Dark: { bg: 'linear-gradient(135deg,#0E2357,#060E22)', win: '#13264F', bar: 'rgba(255,255,255,0.08)' },
  Auto: { bg: 'linear-gradient(135deg,#EAF1FF 0%,#EAF1FF 50%,#0E2357 50%,#060E22 100%)', win: '#8FA3C8', bar: 'rgba(127,178,255,0.25)' },
}
export function AppearancePanel() {
  const [a, setA] = useState<Appearance>(() => loadAppearance())
  const save = (n: Appearance) => { setA(n); writeJson(KEYS.appearance, n); applyAppearance(n) }
  const accent = accentColor(a.accent)
  const reduce = typeof matchMedia !== 'undefined' && matchMedia('(prefers-reduced-motion: reduce)').matches
  return <>
    <H1>{t('settings.nav.Appearance')}</H1>
    <fieldset className="m-0 flex flex-col gap-2.5 border-0 p-0">
      <legend className="mb-2.5 p-0 text-sm font-semibold">{t('settings.app.theme')}</legend>
      <div className="grid grid-cols-3 gap-3.5">
        {THEMES.map((th) => (
          <button key={th} type="button" aria-pressed={a.theme === th} onClick={() => save({ ...a, theme: th })}
            className="flex cursor-pointer flex-col gap-2.5 rounded-[14px] border-2 bg-[rgba(14,32,72,0.5)] p-2.5 text-left" style={{ borderColor: a.theme === th ? accent : 'transparent' }}>
            <span className="relative block h-[110px] overflow-hidden rounded-[9px]" style={{ background: THEME_ART[th].bg }} aria-hidden="true">
              <span className="absolute top-3.5 left-3.5 h-16 w-[100px] rounded-[7px]" style={{ background: THEME_ART[th].win }} />
              <span className="absolute top-6 left-[22px] h-[7px] w-[50px] rounded" style={{ background: accent }} />
              <span className="absolute inset-x-2 bottom-2 h-4 rounded-[5px]" style={{ background: THEME_ART[th].bar }} />
            </span>
            <span className="px-1 text-sm font-semibold">{t(`settings.theme.${th}` as MessageKey)}</span>
          </button>
        ))}
      </div>
    </fieldset>
    <fieldset className="m-0 flex flex-col gap-2.5 border-0 p-0">
      <legend className="mb-2.5 p-0 text-sm font-semibold">{t('settings.app.accent')}</legend>
      <div className="flex gap-3.5">
        {ACCENTS.map((x) => (
          <button key={x.name} type="button" aria-label={t(`settings.accent.${x.name}` as MessageKey)} aria-pressed={a.accent === x.name} onClick={() => save({ ...a, accent: x.name })}
            className="h-8 w-8 cursor-pointer rounded-full" style={{ background: x.color, boxShadow: a.accent === x.name ? '0 0 0 3px #0A1A3D, 0 0 0 5px #FFFFFF' : 'none' }} />
        ))}
      </div>
    </fieldset>
    <TaskbarAlignChoice accent={accent} />
    <Rows rows={[
      { k: t('settings.app.wallpaper'), v: t('settings.app.wallpaperDefault') },
      { k: t('settings.app.font'), v: 'IBM Plex Sans' },
      { k: t('a11y.reducedMotion'), v: reduce ? t('settings.app.onSystem') : t('settings.app.offSystem') },
    ]} />
  </>
}

/** Taskbar alignment (Centre / Left), stored in the synced shell preferences. */
function TaskbarAlignChoice({ accent }: { accent: string }) {
  const [align, setAlign] = useState<TaskbarAlign>(() => localTaskbarAlign() ?? 'center')
  useEffect(() => {
    let live = true
    void os.shellPrefs().then((r) => { if (live && r.ok) { const p = shellPrefsFrom(r.value); if (p.taskbarAlign) setAlign(p.taskbarAlign) } }).catch(() => undefined)
    return () => { live = false }
  }, [])
  const pick = (a: TaskbarAlign) => { setAlign(a); void saveTaskbarAlign(a, os) }
  return (
    <fieldset className="m-0 flex flex-col gap-2.5 border-0 p-0">
      <legend className="mb-2.5 p-0 text-sm font-semibold">{t('settings.app.taskbar')}</legend>
      <div className="flex gap-3.5">
        {(['center', 'left'] as const).map((a) => (
          <button key={a} type="button" aria-pressed={align === a} onClick={() => pick(a)}
            className="flex w-[180px] cursor-pointer flex-col gap-2 rounded-[14px] border-2 bg-[rgba(14,32,72,0.5)] p-2.5 text-left" style={{ borderColor: align === a ? accent : 'transparent' }}>
            <span aria-hidden="true" className={`flex h-6 items-center gap-1 rounded-md bg-[rgba(6,14,34,0.88)] px-1.5 ${a === 'center' ? 'justify-center' : 'justify-start'}`}>
              <span className="size-3 rounded-[3px]" style={{ background: accent }} />{[0, 1, 2].map((i) => <span key={i} className="size-3 rounded-[3px] bg-[#8FA3C8]" />)}
            </span>
            <span className="px-1 text-sm font-semibold">{t(a === 'center' ? 'settings.app.taskbarCenter' : 'settings.app.taskbarLeft')}</span>
          </button>
        ))}
      </div>
    </fieldset>
  )
}

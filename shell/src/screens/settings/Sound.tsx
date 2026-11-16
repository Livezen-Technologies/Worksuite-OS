// Settings › Sound (from Settings.tsx).
import { useState } from 'react'
import { os } from '../../lib/os'
import { C, Svg, card } from '../../components/Dk'
import { Empty } from '../Hardware'
import { formatNumber, t } from '../../i18n'
import { useAvail, H1, Value, Unavail, Note } from './common'

export function SoundPanel() {
  const { r, reload } = useAvail(os.sysSound)
  const [vol, setVol] = useState<number | null>(null)
  if (r.state !== 'ok') return <><H1>{t('settings.nav.Sound')}</H1>{r.state === 'loading' ? <Empty title={t('settings.snd.reading')} /> : <Unavail what={t('settings.nav.Sound')} reason={r.reason} />}</>
  const s = r.value
  const out = s.outputs.find((o) => o.is_default)
  const input = s.inputs.find((o) => o.is_default)
  const select = 'box-border min-w-[260px] rounded-[9px] border border-[rgba(127,178,255,0.25)] bg-[rgba(4,10,26,0.5)] px-3 py-[9px] text-[13px] text-[#E8EEFA]'
  const v = vol ?? s.volume
  return <>
    <H1>{t('settings.nav.Sound')}</H1>
    <section aria-label={t('settings.snd.output')} className={`${card} flex flex-col gap-2.5 px-5 py-[18px]`}>
      <div className="flex items-center justify-between gap-3"><h2 className="m-0 text-[15px] font-semibold">{t('settings.snd.output')}</h2>
        {s.outputs.length > 1
          ? <select aria-label={t('settings.snd.outputDevice')} value={out?.id ?? ''} onChange={(e) => void os.sysSetDefaultAudio(+e.target.value).then(reload)} className={select}>{s.outputs.map((o) => <option key={o.id} value={o.id}>{o.name}</option>)}</select>
          : <Value min={260}>{out?.name ?? null}</Value>}
      </div>
      <div className="flex items-center gap-3.5">
        <button type="button" aria-pressed={s.muted} aria-label={t('settings.snd.mute')} onClick={() => void os.sysSetMute(!s.muted).then(reload)} className="flex h-8 w-8 cursor-pointer items-center justify-center rounded-lg hover:bg-white/10">
          <Svg d={s.muted ? 'M4 9v6h4l5 4V5L8 9zM17 9l4 6M21 9l-4 6' : 'M4 9v6h4l5 4V5L8 9zM16.5 8.5a5 5 0 0 1 0 7'} size={20} stroke={C.soft} />
        </button>
        <input type="range" aria-label={t('settings.snd.volume')} min={0} max={100} value={v} onChange={(e) => { setVol(+e.target.value); void os.sysSetVolume(+e.target.value) }} onPointerUp={() => void reload().then(() => setVol(null))} onKeyUp={() => void reload().then(() => setVol(null))} className="flex-1 accent-[#1F6BFF]" />
        <span className="w-[56px] text-right font-mono text-[13px]">{s.muted ? t('settings.snd.muted') : `${formatNumber(v)}%`}</span>
      </div>
    </section>
    <section aria-label={t('settings.snd.input')} className={`${card} flex items-center justify-between gap-3 px-5 py-[18px]`}>
      <h2 className="m-0 text-[15px] font-semibold">{t('settings.snd.input')}</h2><Value min={260}>{input?.name ?? null}</Value>
    </section>
    <Note>{t('settings.snd.note')}</Note>
  </>
}

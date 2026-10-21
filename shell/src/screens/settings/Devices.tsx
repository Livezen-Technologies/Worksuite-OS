// Settings › Power (UPower via os.sysBattery). Settings › Printers is Printers.tsx.
import { AnimatedProgress, CountUp } from '../../components/AnimatedProgress'
import { formatDuration, os, type BatteryState } from '../../lib/os'
import { useSystem } from '../../lib/useSystem'
import { Svg, card } from '../../components/Dk'
import { Empty } from '../Hardware'
import { t } from '../../i18n'
import { H1, Note, Unavail } from './ui'

const BOLT = 'M13 2L4 14h7l-1 8 9-12h-7z'

export function PowerPanel() {
  const { state } = useSystem(os.sysBattery, 30_000, 'battery')
  const b: BatteryState | null = state?.available ? state.value : null
  const pct = b?.percentage ?? null
  const charging = b?.state === 'charging'
  const status = !b ? null : charging ? t('settings.bat.charging') : b.on_battery ? t('settings.bat.onBattery') : b.state === 'fully-charged' ? t('settings.bat.full') : t('settings.bat.plugged')
  const eta = !b ? null : charging ? formatDuration(b.time_to_full_s) : b.on_battery ? formatDuration(b.time_to_empty_s) : null
  return <>
    <H1>{t('settings.nav.Power')}</H1>
    {!state ? <Empty title={t('settings.power.reading')} /> : !state.available ? <Unavail what={t('settings.about.battery')} reason={state.reason} /> : !b?.present ? (
      <div className={`${card} flex items-center gap-4 px-5 py-[18px]`}>
        <span className="flex h-12 w-12 items-center justify-center rounded-xl bg-[rgba(183,121,31,0.25)]"><Svg d={BOLT} size={24} stroke="#FFB98A" /></span>
        <span className="flex flex-col gap-0.5"><span className="text-base font-semibold">{t('settings.power.mains')}</span><span className="text-[13px] text-[#8FA3C8]">{t('settings.about.noBattery')}</span></span>
      </div>
    ) : (
      <div className="flex items-center gap-5 rounded-[18px] border border-[rgba(127,178,255,0.18)] bg-[rgba(14,32,72,0.7)] px-6 py-[22px]">
        <span className="flex h-[60px] w-[60px] shrink-0 items-center justify-center rounded-2xl" style={{ background: charging ? '#B7791F' : 'rgba(127,178,255,0.18)' }}><Svg d={BOLT} size={30} stroke="#FFFFFF" /></span>
        <span className="flex min-w-0 flex-1 flex-col gap-2">
          <span className="text-xl font-bold">{pct == null ? '—' : <CountUp value={pct} />} · {status}</span>
          <AnimatedProgress decorative value={pct ?? 0} height={8} trackColor="rgba(255,255,255,0.15)" shimmer={charging} tone={pct != null && pct <= 15 && b?.on_battery ? 'error' : charging ? 'default' : 'success'} />
          <span className="text-[13px] text-[#C9D6EE]">{eta ? (charging ? t('settings.bat.toFull', { eta }) : t('settings.bat.left', { eta })) : t('settings.power.noEstimate')}</span>
        </span>
      </div>
    )}
    <Note>{t('settings.power.note')}</Note>
  </>
}

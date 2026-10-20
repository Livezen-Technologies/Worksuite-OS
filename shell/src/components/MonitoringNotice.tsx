// Employee monitoring (#22) in the taskbar: a persistent indicator while the organization's policy has monitoring on,
// and the first-run disclosure (once per disclosure version) telling the employee what is and is not collected.
import { Dialog, Svg, btnGhost, btnPrimary } from './Dk'
import { EYE, useActivity } from '../screens/settings/Monitoring'
import { os, type ActivityStatus } from '../lib/os'
import { formatNumber, t } from '../i18n'

export function MonitoringIndicator({ onOpen, initial }: { onOpen: () => void; initial?: ActivityStatus | null }) {
  const [s, setS] = useActivity(initial)
  if (!s?.enabled) return null
  const org = s.org_name ?? t('settings.about.yourOrg')
  return <>
    <button type="button" onClick={onOpen} aria-label={t('mon.indicatorOpen')} title={t('mon.indicator')}
      className="flex h-8 cursor-pointer items-center gap-1 rounded-lg px-2 text-[#FFD08A] hover:bg-white/[0.06]">
      <Svg d={EYE} size={16} stroke="currentColor" />
    </button>
    {s.disclosure_needed && (
      <Dialog width={480} onClose={() => {}}>{(titleId) => <>
        <div className="flex flex-col gap-3 px-6 pt-6 pb-2 text-[13px] leading-relaxed text-[#C9D6EE]">
          <h2 id={titleId} className="m-0 flex items-center gap-2 text-lg font-bold text-[#E8EEFA]"><Svg d={EYE} size={20} stroke="#FFD08A" />{t('mon.disclosureTitle', { org })}</h2>
          <p className="m-0">{t('mon.disclosureBody')}</p>
          <div><div className="font-semibold text-[#E8EEFA]">{t('mon.collected')}</div>
            <ul className="m-0 pl-4"><li>{t('mon.c.time')}</li><li>{t('mon.c.apps')}</li><li>{t('mon.c.events')}</li></ul></div>
          <div><div className="font-semibold text-[#E8EEFA]">{t('mon.notCollected')}</div><p className="m-0">{t('mon.n.list')}</p></div>
          <p className="m-0 text-[#8FA3C8]">{t('mon.retention', { days: formatNumber(s.retention_days), minutes: formatNumber(Math.round(s.idle_threshold_s / 60)) })} {t('mon.disclosureSee')}</p>
        </div>
        <div className="flex justify-end gap-2 px-6 pb-6 pt-2">
          <button type="button" className={btnGhost} onClick={() => void os.activityAck().then((v) => { setS(v); onOpen() })}>{t('mon.disclosureDetails')}</button>
          <button type="button" className={btnPrimary} onClick={() => void os.activityAck().then(setS)}>{t('mon.disclosureOk')}</button>
        </div>
      </>}</Dialog>
    )}
  </>
}

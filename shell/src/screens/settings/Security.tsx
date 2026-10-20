// Settings › Privacy & security › WorkSuite Security (#20): overall state, firewall, virus & threat protection with
// Scan now, protection history and organization policies. Data: the device agent's security.json; scans through
// lk.worksuite.DeviceAgent1.StartSecurityScan.
import { useEffect, useState } from 'react'
import { C, Svg, btnGhost, card, chip, rowLine } from '../../components/Dk'
import { os, type DeviceInfo, type SecurityStatus } from '../../lib/os'
import { fmtWhen } from '../../lib/updates'
import { formatNumber, t } from '../../i18n'

const SHIELD = 'M12 3l8 3v6c0 5-3.5 8-8 9-4.5-1-8-4-8-9V6z'
const BUG = 'M8 9h8v8a4 4 0 0 1-8 0zM9 9V7a3 3 0 0 1 6 0v2M4 13h4M16 13h4M5 8l3 2M19 8l-3 2M5 19l3-2M19 19l-3-2'

export function overallLabel(s: SecurityStatus | null): { text: string; tone: string } {
  if (!s || s.overall === 'unavailable') return { text: t('sec.unavailable'), tone: C.muted }
  if (s.overall === 'protected') return { text: t('sec.protected'), tone: C.green }
  if (s.overall === 'attention') return { text: t('sec.attention'), tone: C.amber }
  return { text: t('sec.atRisk'), tone: '#FF8A7A' }
}

const ACTION: Record<string, Parameters<typeof t>[0]> = { quarantined: 'sec.actionQuarantined', detected: 'sec.actionDetected', restored: 'sec.actionRestored', deleted: 'sec.actionDeleted' }

export function SecuritySection({ info, initial }: { info: DeviceInfo | null; initial?: SecurityStatus | null }) {
  const [s, setS] = useState<SecurityStatus | null>(initial ?? null)
  const [msg, setMsg] = useState<string | null>(null)
  useEffect(() => {
    if (initial !== undefined) return
    void os.securityStatus().then(setS).catch(() => {})
    return os.onSecurityChanged(setS)
  }, [initial])
  const scan = (kind: 'quick' | 'full') => void os.securityScan(kind).then((r) => setMsg(r.ok ? t('sec.scanStarted') : t('sec.scanError')))
  const head = overallLabel(s)
  const av = s?.antivirus
  const last = av?.last_scan
  return (
    <section aria-labelledby="sec-title" className="flex flex-col gap-2">
      <h2 id="sec-title" className="m-0 flex items-center gap-2 text-sm font-semibold"><Svg d={SHIELD} size={16} stroke={head.tone} />{t('sec.title')}<span className={chip} style={{ color: head.tone }}>{head.text}</span></h2>
      {s?.isolation && <p role="status" className="m-0 rounded-xl border border-[rgba(255,159,90,0.35)] bg-[rgba(255,159,90,0.12)] px-4 py-3 text-[13px] text-[#FFD2A8]">{t('sec.isolated', { when: fmtWhen(s.isolation.until) })}</p>}
      {!s ? <div className={`${card} px-4 py-3 text-xs text-[#8FA3C8]`}>{t('sec.unavailableHint')}</div> : (
        <div className={`${card} overflow-hidden`}>
          <div className={`flex items-center gap-3 px-4 py-[11px] ${rowLine}`}>
            <Svg d={SHIELD} size={18} stroke={s.firewall.active ? C.green : '#FF8A7A'} />
            <span className="flex flex-1 flex-col gap-0.5"><span className="text-[13px] font-medium">{t('sec.firewall')}</span>
              <span className="text-[11px] text-[#8FA3C8]">{s.firewall.active ? t('sec.firewallOn') : t('sec.firewallOff')}{s.firewall.policy_rules ? ` · ${t('sec.firewallRules', { count: formatNumber(s.firewall.policy_rules) })}` : ''}</span></span>
          </div>
          <div className={`flex items-center gap-3 px-4 py-[11px] ${rowLine}`}>
            <Svg d={BUG} size={18} stroke={!av?.enabled || !av.installed ? C.muted : s.threats.active ? '#FF8A7A' : C.green} />
            <span className="flex flex-1 flex-col gap-0.5"><span className="text-[13px] font-medium">{t('sec.virus')}</span>
              <span className="text-[11px] text-[#8FA3C8]">{!av?.enabled ? t('sec.virusOff') : !av.installed ? t('sec.virusMissing')
                : [av.engine && t('sec.engine', { version: av.engine }), `${t('sec.definitions')}: ${av.signatures_age_days === null ? t('common.unknown') : av.signatures_age_days <= 1 ? t('sec.definitionsToday') : t('sec.definitionsAge', { days: formatNumber(av.signatures_age_days) })}`,
                  av.updates !== 'active' ? t('sec.updatesStopped') : null].filter(Boolean).join(' · ')}</span>
              <span className="text-[11px] text-[#8FA3C8]">{t('sec.lastScan')}: {s.scanning ? t('sec.scanning') : !last ? t('sec.never') : last.error ? t('sec.scanFailed')
                : t('sec.scanSummary', { kind: last.kind === 'full' ? t('sec.full') : t('sec.quick'), files: formatNumber(last.files), found: formatNumber(last.detections), when: fmtWhen(last.finished) })}</span>
              <span className="text-[11px]" style={{ color: s.threats.active ? '#FF8A7A' : '#8FA3C8' }}>{t('sec.threats')}: {t('sec.threatCounts', { active: formatNumber(s.threats.active), quarantined: formatNumber(s.threats.quarantined) })}</span></span>
            {av?.enabled && av.installed && <span className="flex gap-2">
              <button type="button" className={btnGhost} disabled={!!s.scanning} onClick={() => scan('quick')}>{t('sec.quickScan')}</button>
              <button type="button" className={btnGhost} disabled={!!s.scanning} onClick={() => scan('full')}>{t('sec.fullScan')}</button>
            </span>}
          </div>
          {msg && <p role="status" className="m-0 px-4 py-2 text-[11px] text-[#C9D6EE]">{msg}</p>}
        </div>
      )}
      {s && <div className={`${card} overflow-hidden`} role="table" aria-label={t('sec.history')}>
        <div role="row" className="px-4 py-[9px] text-[11px] text-[#8FA3C8]"><span role="columnheader">{t('sec.history')}</span></div>
        {!s.history.length ? <div role="row" className={`px-4 py-2.5 text-xs text-[#8FA3C8] ${rowLine}`}><span role="cell">{t('sec.noHistory')}</span></div>
          : s.history.slice(0, 8).map((h) => (
            <div role="row" key={h.id} className={`flex items-center gap-3 px-4 py-2 text-xs ${rowLine}`}>
              <span role="cell" className="flex min-w-0 flex-1 flex-col"><span className="truncate">{h.signature}</span><span className="truncate text-[11px] text-[#8FA3C8]">{h.path}</span></span>
              <span role="cell" className="text-[11px]" style={{ color: h.action === 'detected' ? '#FF8A7A' : '#C9D6EE' }}>{ACTION[h.action] ? t(ACTION[h.action]) : h.action}</span>
              <span role="cell" className="w-24 text-right text-[11px] text-[#8FA3C8]">{fmtWhen(h.at)}</span>
            </div>
          ))}
      </div>}
      <div className={`${card} px-4 py-3 text-xs leading-relaxed text-[#C9D6EE]`}>
        <span className="font-semibold">{t('sec.policies')}. </span>
        {info?.managed ? t('sec.policiesManaged', { org: info.org_name ?? info.server ?? t('settings.about.yourOrg'), days: formatNumber(s?.retention_days ?? 90) }) : t('sec.policiesLocal')} {t('sec.note')}
      </div>
    </section>
  )
}

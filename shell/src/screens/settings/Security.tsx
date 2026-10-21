// Settings › Privacy & security › WorkSuite Security (#20): overall state, firewall, virus & threat protection with
// Scan now, protection history and organization policies. Data: the device agent's security.json; scans through
// lk.worksuite.DeviceAgent1.StartSecurityScan. #38 adds real-time protection, ransomware protection, web & app
// protection, suspended programs and quarantine restore/delete (an administrator, through polkit).
import { useEffect, useState } from 'react'
import { C, Svg, btnGhost, card, chip, rowLine } from '../../components/Dk'
import { os, type DeviceInfo, type SecurityStatus } from '../../lib/os'
import { fmtWhen } from '../../lib/updates'
import { formatNumber, t } from '../../i18n'

const SHIELD = 'M12 3l8 3v6c0 5-3.5 8-8 9-4.5-1-8-4-8-9V6z'
const BUG = 'M8 9h8v8a4 4 0 0 1-8 0zM9 9V7a3 3 0 0 1 6 0v2M4 13h4M16 13h4M5 8l3 2M19 8l-3 2M5 19l3-2M19 19l-3-2'
const BOLT = 'M13 2L4 14h7l-1 8 9-12h-7z'
const FOLDER = 'M3 6a1 1 0 0 1 1-1h5l2 2h9a1 1 0 0 1 1 1v10a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1zM12 11v4M10 13h4'
const GLOBE = 'M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18zM3 12h18M12 3c3 3 3 15 0 18M12 3c-3 3-3 15 0 18'

const EVENT: Record<string, Parameters<typeof t>[0]> = {
  onaccess_blocked: 'sec.ev.onaccess_blocked', onaccess_detected: 'sec.ev.onaccess_detected', write_blocked: 'sec.ev.write_blocked',
  exec_blocked: 'sec.ev.exec_blocked', ransomware_suspended: 'sec.ev.ransomware_suspended', download_threat: 'sec.ev.download_threat',
}
const ACTION_ERROR: Record<string, Parameters<typeof t>[0]> = { still_detected: 'sec.stillDetected', path_exists: 'sec.pathExists', auth_cancelled: 'sec.authCancelled' }
/** #64: why a scan (or cancel, or a definitions update) did not start, in words. */
const SCAN_ERROR: Record<string, Parameters<typeof t>[0]> = {
  no_signatures: 'sec.err.no_signatures', missing: 'sec.err.missing', unavailable: 'sec.err.unavailable', agent_unavailable: 'sec.err.agent_unavailable',
  not_scanning: 'sec.err.not_scanning', update_failed: 'sec.err.update_failed', auth_cancelled: 'sec.authCancelled',
}
/** 0:42, 12:05, 1:02:09 */
export function fmtElapsed(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000)), h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), x = s % 60
  const two = (n: number) => String(n).padStart(2, '0')
  return h ? `${h}:${two(m)}:${two(x)}` : `${m}:${two(x)}`
}
type Scan = NonNullable<SecurityStatus['antivirus']['last_scan']>
/** The last scan in one line: what it covered and found, or why it did not finish. */
export function lastScanText(last: Scan | null): string {
  if (!last) return t('sec.never')
  if (last.error === 'CANCELLED') return t('sec.scanCancelled')
  if (last.error === 'NO_SIGNATURES') return t('sec.scanNoSignatures')
  if (last.error) return t('sec.scanFailed')
  return t('sec.scanSummary', { kind: last.kind === 'full' ? t('sec.full') : t('sec.quick'), files: formatNumber(last.files), found: formatNumber(last.detections), when: fmtWhen(last.finished) })
}
const baseName = (p: string) => p.split('/').pop() || p

/** Settings rows for the #38 layers; null fields (older agents) leave them out. */
export function protectionRows(s: SecurityStatus): { key: string; icon: string; tone: string; title: string; detail: string }[] {
  const rows = []
  if (s.realtime) {
    const on = s.realtime.enabled, running = s.realtime.state === 'active'
    rows.push({ key: 'rt', icon: BOLT, tone: !on ? C.muted : running ? C.green : '#FF8A7A', title: t('sec.realtime'),
      detail: [!on ? t('sec.realtimeOff') : !running ? t('sec.realtimeStopped') : s.realtime.prevention ? t('sec.realtimeBlock') : t('sec.realtimeReport'), s.realtime.downloads ? t('sec.downloads') : null].filter(Boolean).join(' · ') })
  }
  if (s.protected_folders) {
    const f = s.protected_folders, names = f.folders.map((x) => x.replace(/^~\//, '')).join(', ')
    rows.push({ key: 'pf', icon: FOLDER, tone: !f.folders.length ? C.muted : f.state === 'active' ? C.green : C.amber, title: t('sec.folders'),
      detail: !f.folders.length ? t('sec.foldersOff') : f.mode === 'audit' ? t('sec.foldersAudit', { folders: names }) : t('sec.foldersOn', { folders: names }) })
  }
  if (s.web) {
    const parts = [s.web.dns_blocked + s.web.dns_feed_entries ? t('sec.webDomains', { count: formatNumber(s.web.dns_blocked + s.web.dns_feed_entries) }) : null,
      s.threat_intel?.entries ? t('sec.webFeeds', { count: formatNumber(s.threat_intel.entries) }) : null,
      s.app_control?.denied ? t('sec.appControl', { count: formatNumber(s.app_control.denied) }) : null].filter(Boolean)
    rows.push({ key: 'web', icon: GLOBE, tone: parts.length ? C.green : C.muted, title: t('sec.web'), detail: parts.length ? parts.join(' · ') : t('sec.webNone') })
  }
  return rows
}

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
  const [cancelling, setCancelling] = useState(false)
  const reload = async () => { const next = await os.securityStatus().catch(() => null); if (next) setS(next) }
  const scan = (kind: 'quick' | 'full') => void os.securityScan(kind).then(async (r) => {
    setMsg(r.ok ? t('sec.scanStarted') : t(SCAN_ERROR[r.error] ?? 'sec.scanError'))
    await reload()
  })
  const cancel = () => { setCancelling(true); void os.securityAction('CancelSecurityScan').then(async (r) => { setCancelling(false); if (!r.ok) setMsg(t(SCAN_ERROR[r.error] ?? 'sec.actionFailed')); else setMsg(null); await reload() }) }
  const updateDefs = () => void os.securityAction('UpdateSecurityDefinitions').then((r) => setMsg(r.ok ? t('sec.updateStarted') : t(SCAN_ERROR[r.error] ?? 'sec.actionFailed')))
  const [actMsg, setActMsg] = useState<string | null>(null)
  const act = (method: 'RestoreQuarantined' | 'DeleteQuarantined' | 'ResolveSuspendedProcess', done: Parameters<typeof t>[0], ...args: string[]) =>
    void os.securityAction(method, ...args).then(async (r) => {
      setActMsg(r.ok ? t(done) : t(ACTION_ERROR[r.error] ?? 'sec.actionFailed'))
      const next = await os.securityStatus().catch(() => null)
      if (next) setS(next)
    })
  const head = overallLabel(s)
  const av = s?.antivirus
  const last = av?.last_scan
  const prog = av?.progress
  // #64: installed but no signatures yet (older agents: no "ready", signatures null means the same).
  const noDefs = !!av?.enabled && !!av.installed && (av.ready === false || (av.ready === undefined && av.signatures === null))
  const scans = av?.scans ?? []
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
              {s.scanning && prog ? <>
                <span className="text-[11px] text-[#C9D6EE]" role="status" aria-live="polite">{t('sec.scanProgress', { kind: prog.kind === 'full' ? t('sec.full') : t('sec.quick'), files: formatNumber(prog.files), found: formatNumber(prog.detections), elapsed: fmtElapsed(Math.max(prog.elapsed_ms, Date.now() - prog.started)) })}</span>
                {prog.current && <span className="max-w-[420px] truncate text-[11px] text-[#8FA3C8]" title={prog.current}>{t('sec.scanCurrent', { path: prog.current })}</span>}
              </> : <span className="text-[11px] text-[#8FA3C8]">{t('sec.lastScan')}: {s.scanning ? t('sec.scanning') : lastScanText(last ?? null)}</span>}
              {noDefs && <span className="text-[11px] text-[#FFD2A8]">{t('sec.noSignatures')}</span>}
              <span className="text-[11px]" style={{ color: s.threats.active ? '#FF8A7A' : '#8FA3C8' }}>{t('sec.threats')}: {t('sec.threatCounts', { active: formatNumber(s.threats.active), quarantined: formatNumber(s.threats.quarantined) })}</span></span>
            {av?.enabled && av.installed && <span className="flex flex-wrap justify-end gap-2">
              {s.scanning ? <button type="button" className={btnGhost} disabled={cancelling} onClick={cancel}>{cancelling ? t('sec.scanCancelling') : t('sec.cancelScan')}</button> : <>
                {noDefs && <button type="button" className={btnGhost} onClick={updateDefs}>{t('sec.updateDefinitions')}</button>}
                <button type="button" className={btnGhost} disabled={noDefs} onClick={() => scan('quick')}>{t('sec.quickScan')}</button>
                <button type="button" className={btnGhost} disabled={noDefs} onClick={() => scan('full')}>{t('sec.fullScan')}</button>
              </>}
            </span>}
          </div>
          {msg && <p role="status" className="m-0 px-4 py-2 text-[11px] text-[#C9D6EE]">{msg}</p>}
          {protectionRows(s).map((r) => (
            <div key={r.key} className={`flex items-center gap-3 px-4 py-[11px] ${rowLine}`}>
              <Svg d={r.icon} size={18} stroke={r.tone} />
              <span className="flex flex-1 flex-col gap-0.5"><span className="text-[13px] font-medium">{r.title}</span><span className="text-[11px] text-[#8FA3C8]">{r.detail}</span></span>
            </div>
          ))}
        </div>
      )}
      {!!s?.suspended?.length && <div className={`${card} overflow-hidden border-[rgba(255,138,122,0.4)]`} role="region" aria-label={t('sec.suspended')}>
        <div className="px-4 pt-3 text-[13px] font-medium text-[#FF8A7A]">{t('sec.suspended')}</div>
        <p className="m-0 px-4 pb-2 text-[11px] text-[#8FA3C8]">{t('sec.suspendedHint')}</p>
        {s.suspended.map((p) => (
          <div key={p.id} className={`flex items-center gap-3 px-4 py-2 text-xs ${rowLine}`}>
            <span className="flex min-w-0 flex-1 flex-col"><span className="truncate">{baseName(p.exe ?? '')}</span><span className="truncate text-[11px] text-[#8FA3C8]">{p.path}</span></span>
            <button type="button" className={btnGhost} onClick={() => act('ResolveSuspendedProcess', 'sec.resolved', p.id, 'resume')}>{t('sec.resume')}</button>
            <button type="button" className={btnGhost} onClick={() => act('ResolveSuspendedProcess', 'sec.resolved', p.id, 'terminate')}>{t('sec.terminate')}</button>
          </div>
        ))}
      </div>}
      {s?.quarantine && <div className={`${card} overflow-hidden`} role="table" aria-label={t('sec.quarantine')}>
        <div role="row" className="px-4 py-[9px] text-[11px] text-[#8FA3C8]"><span role="columnheader">{t('sec.quarantine')}</span></div>
        {!s.quarantine.length ? <div role="row" className={`px-4 py-2.5 text-xs text-[#8FA3C8] ${rowLine}`}><span role="cell">{t('sec.quarantineEmpty')}</span></div>
          : s.quarantine.slice(0, 20).map((q) => (
            <div role="row" key={q.id} className={`flex items-center gap-3 px-4 py-2 text-xs ${rowLine}`}>
              <span role="cell" className="flex min-w-0 flex-1 flex-col"><span className="truncate">{baseName(q.path)}</span><span className="truncate text-[11px] text-[#8FA3C8]">{q.signature} · {q.path}</span></span>
              <span role="cell" className="flex gap-2">
                <button type="button" className={btnGhost} onClick={() => act('RestoreQuarantined', 'sec.restored', q.id)}>{t('sec.restore')}</button>
                <button type="button" className={btnGhost} onClick={() => act('DeleteQuarantined', 'sec.deleted', q.id)}>{t('sec.delete')}</button>
              </span>
            </div>
          ))}
        {actMsg && <p role="status" className="m-0 px-4 py-2 text-[11px] text-[#C9D6EE]">{actMsg}</p>}
      </div>}
      {!!s?.events?.length && <div className={`${card} overflow-hidden`} role="table" aria-label={t('sec.events')}>
        <div role="row" className="px-4 py-[9px] text-[11px] text-[#8FA3C8]"><span role="columnheader">{t('sec.events')}</span></div>
        {s.events.slice(0, 8).map((e) => (
          <div role="row" key={e.id} className={`flex items-center gap-3 px-4 py-2 text-xs ${rowLine}`}>
            <span role="cell" className="flex min-w-0 flex-1 flex-col"><span className="truncate">{EVENT[e.kind] ? t(EVENT[e.kind]) : e.kind}</span><span className="truncate text-[11px] text-[#8FA3C8]">{e.path}</span></span>
            <span role="cell" className="w-24 text-right text-[11px] text-[#8FA3C8]">{fmtWhen(e.at)}</span>
          </div>
        ))}
      </div>}
      {!!scans.length && <div className={`${card} overflow-hidden`} role="table" aria-label={t('sec.scans')}>
        <div role="row" className="px-4 py-[9px] text-[11px] text-[#8FA3C8]"><span role="columnheader">{t('sec.scans')}</span></div>
        {scans.slice(0, 5).map((r) => (
          <div role="row" key={r.id ?? r.started} className={`flex items-center gap-3 px-4 py-2 text-xs ${rowLine}`}>
            <span role="cell" className="flex-1">{t('sec.scanRow', { kind: r.kind === 'full' ? t('sec.full') : t('sec.quick'), files: formatNumber(r.files), found: formatNumber(r.detections) })}</span>
            <span role="cell" className="text-[11px]" style={{ color: r.error && r.error !== 'CANCELLED' ? '#FF8A7A' : '#C9D6EE' }}>{!r.error ? t('sec.scanOk') : r.error === 'CANCELLED' ? t('sec.scanCancelledShort') : r.error === 'NO_SIGNATURES' ? t('sec.scanNoSignatures') : t('sec.scanErr')}</span>
            <span role="cell" className="w-24 text-right text-[11px] text-[#8FA3C8]">{fmtWhen(r.finished)}</span>
          </div>
        ))}
      </div>}
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
        {info?.managed && s?.auto_patch ? ` ${t(s.auto_patch === 'immediate' ? 'sec.patchImmediate' : s.auto_patch === 'off' ? 'sec.patchOff' : 'sec.patchWindow')}` : ''}
      </div>
    </section>
  )
}

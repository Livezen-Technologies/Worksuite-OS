// Settings › About and Managed, and device enrollment (from Settings.tsx).
import { AnimatedProgress } from '../../components/AnimatedProgress'
import { useEffect, useState } from 'react'
import { cloudErrorText, formatBytes, formatDuration, os, policyLines, serverUrlFor, type BatteryState, type DeviceInfo, type SecurityStatus } from '../../lib/os'
import { needsAttention, fmtWhen } from '../../lib/updates'
import { updates, useOsUpdate } from '../../lib/useOsUpdate'
import { ReportProblem } from './ReportProblem'
import { Diagnostics } from './Diagnostics'
import { KioskPanel } from './Kiosk'
import { C, Svg, btnGhost, btnPrimary, card, field, linkBtn } from '../../components/Dk'
import { Mark } from '../../components/Ws'
import { Empty } from '../Hardware'
import { formatDate, formatNumber, t } from '../../i18n'
import { useAvail, H1 } from './common'

function batteryText(b: BatteryState): string {
  const eta = b.state === 'charging' ? formatDuration(b.time_to_full_s) : b.on_battery ? formatDuration(b.time_to_empty_s) : null
  const what = b.state === 'charging' ? t('settings.bat.charging') : b.on_battery ? t('settings.bat.onBattery') : b.state === 'fully-charged' ? t('settings.bat.full') : t('settings.bat.plugged')
  return `${b.percentage == null ? '—' : `${formatNumber(b.percentage)}%`} · ${what}${eta ? ` · ${b.state === 'charging' ? t('settings.bat.toFull', { eta }) : t('settings.bat.left', { eta })}` : ''}`
}

/** SetAbout board. Processor and memory come from the main process (DeviceInfo.specs). */
export function AboutPanel() {
  const { r: disks } = useAvail(os.sysDisks)
  const { r: battery } = useAvail(os.sysBattery, 60_000, 'battery')
  const { r: displays } = useAvail(os.sysDisplays)
  const { status } = useOsUpdate()
  const [info, setInfo] = useState<DeviceInfo | null>(null)
  const [gpus, setGpus] = useState<string[] | null>(null)
  const [fw, setFw] = useState<SecurityStatus | null>(null)
  useEffect(() => { void os.securityStatus().then(setFw).catch(() => {}) }, [])
  const [free, setFree] = useState<number | null>(null)
  const [disk, setDisk] = useState<{ used: number; total: number } | null>(null)
  const [copied, setCopied] = useState(false)
  const [checking, setChecking] = useState(false)
  useEffect(() => {
    void os.deviceInfo().then(setInfo).catch(() => {})
    void os.hwDevices().then((r) => setGpus(r.ok ? r.value.filter((x) => x.kind === 'graphics').map((x) => x.name) : [])).catch(() => setGpus([]))
    void os.filesStatus('home').then((r) => setFree(r.free_bytes)).catch(() => {})
    void os.filesPlaces().then((r) => setDisk(r.disk)).catch(() => {})
  }, [])
  if (!info) return <><H1>{t('settings.nav.About')}</H1><Empty title={t('settings.about.loading')} /></>
  const d = info.device
  const arch = d?.arch === 'arm64' ? 'ARM64 (arm64)' : d?.arch === 'amd64' ? 'x86-64 (amd64)' : t('common.unknown')
  const screen = displays.state === 'ok' ? displays.value.find((x) => x.enabled) ?? null : null
  const na = t('common.unavailable')
  const specs: { k: string; v: string; d: string; icon: string }[] = [
    { k: t('settings.about.cpu'), v: info.specs?.cpu_model ?? na, d: info.specs?.cpu_cores ? t('settings.about.cores', { count: formatNumber(info.specs.cpu_cores) }) : info.specs ? '' : t('settings.about.noSource'), icon: 'M7 7h10v10H7zM9 2v3M15 2v3M9 19v3M15 19v3M2 9h3M2 15h3M19 9h3M19 15h3' },
    { k: t('settings.about.memory'), v: info.specs?.memory_bytes ? formatBytes(info.specs.memory_bytes) : na, d: info.specs ? '' : t('settings.about.noSource'), icon: 'M3 7h18v10H3zM7 11v2M11 11v2M15 11v2' },
    { k: t('settings.about.graphics'), v: gpus === null ? '…' : gpus[0] ?? na, d: gpus && gpus.length > 1 ? `+ ${gpus.slice(1).join(', ')}` : '', icon: 'M3 6h18v12H3zM7 10h4v4H7z' },
    { k: t('settings.nav.Display'), v: screen?.width && screen.height ? `${formatNumber(screen.width)} × ${formatNumber(screen.height)}` : displays.state === 'loading' ? '…' : na, d: screen ? [screen.refresh ? `${formatNumber(Math.round(screen.refresh))} Hz` : null, screen.scale ? `${formatNumber(Math.round(screen.scale * 100))}%` : null].filter(Boolean).join(' · ') || screen.description : '', icon: 'M3 4h18v12H3zM8 20h8M12 16v4' },
    { k: t('settings.about.desktop'), v: t('settings.about.shell'), d: t('settings.about.wayland'), icon: 'M4 4h7v7H4zM13 4h7v7h-7zM4 13h7v7H4zM13 13h7v7h-7z' },
    { k: t('settings.about.kernel'), v: d?.kernel_version ?? t('common.unknown'), d: arch, icon: 'M4 5h16v14H4zM7 9l3 3-3 3M12 15h5' },
  ]
  const sec = [
    { k: t('settings.priv.encryption'), v: d?.encrypted == null ? t('common.unknown') : d.encrypted ? t('settings.about.encrypted') : t('settings.about.notEncrypted'), c: d?.encrypted ? C.green : d?.encrypted === false ? C.amber : '#5E739C' },
    { k: t('settings.about.secureBoot'), v: na, c: '#5E739C' },
    { k: t('settings.priv.firewall'), v: !fw ? na : fw.firewall.active ? t('sec.firewallOn') : t('sec.firewallOff'), c: !fw ? '#5E739C' : fw.firewall.active ? C.green : C.amber },
    { k: t('settings.about.managedBy'), v: info.managed ? info.org_name ?? info.server ?? t('settings.about.yourOrg') : t('settings.about.notManaged'), c: info.managed ? '#B9A0FF' : '#5E739C' },
  ]
  const upToDate = status?.state === 'up_to_date'
  const copy = () => {
    const text = [`WorkSuite OS ${d?.os_version ?? ''}`.trim(), `${t('settings.about.name')}: ${d?.hostname ?? '—'}`, `${t('settings.about.kernel')}: ${d?.kernel_version ?? '—'} (${d?.arch ?? '—'})`,
      ...specs.slice(0, 4).map((s) => `${s.k}: ${s.v}${s.d ? ` (${s.d})` : ''}`), `${t('settings.about.battery')}: ${battery.state === 'ok' ? batteryText(battery.value) : t('settings.about.noBattery')}`,
      ...sec.map((s) => `${s.k}: ${s.v}`)].join('\n')
    void navigator.clipboard?.writeText(text).then(() => setCopied(true)).catch(() => {})
  }
  const drives = disks.state === 'ok' ? disks.value : []
  return <>
    <h1 className="sr-only">{t('settings.nav.About')}</h1>
    <div className="flex items-center gap-[22px] rounded-[18px] border border-[rgba(127,178,255,0.2)] px-6 py-[22px]" style={{ background: 'radial-gradient(circle at 88% 15%, rgba(24,212,240,0.32), transparent 45%), linear-gradient(120deg, #173F94, #0D2353)' }}>
      <Mark size={76} />
      <span className="flex min-w-0 flex-1 flex-col gap-1.5">
        <span className="text-[28px] font-bold tracking-[-0.02em]">{d?.os_version ?? 'WorkSuite OS'}</span>
        <span className="font-mono text-xs text-[#C9D6EE]">{[info.policies?.update_ring, d?.hostname, d?.arch].filter(Boolean).join(' · ') || t('settings.about.versionUnknown')}</span>
        {status && <span className="flex items-center gap-1.5 text-[13px]" style={{ color: upToDate ? C.green : needsAttention(status) ? C.amber : '#C9D6EE' }}>
          {upToDate && <Svg d="M5 12.5l4.5 4.5L19 7.5" size={14} stroke={C.green} width={2.6} />}
          {upToDate ? t('settings.priv.checked', { when: status.last_check ? fmtWhen(status.last_check) : '—' }) : needsAttention(status) ? t('settings.priv.updateWaiting') : t('settings.priv.seeUpdates')}
        </span>}
      </span>
      <span className="flex flex-col gap-2">
        <button type="button" disabled={checking} onClick={() => { setChecking(true); void updates.check().finally(() => setChecking(false)) }} className="cursor-pointer rounded-[9px] bg-white/[0.14] px-4 py-[9px] text-center text-[13px] font-semibold hover:bg-white/20 disabled:opacity-60">{checking ? t('settings.about.checking') : t('settings.about.checkUpdates')}</button>
        <button type="button" onClick={copy} className="cursor-pointer rounded-[9px] border border-white/25 px-4 py-[9px] text-center text-[13px] hover:bg-white/[0.06]">{copied ? t('settings.about.copied') : t('settings.about.copyInfo')}</button>
      </span>
    </div>
    <div className={`${card} flex items-center gap-3.5 px-[18px] py-3`}>
      <Svg d="M4 5h16v11H4zM2 20h20" size={18} stroke="#7FB2FF" />
      <span className="text-[13px] text-[#8FA3C8]">{t('settings.about.name')}</span>
      <span className="font-mono text-sm">{d?.hostname ?? t('common.unknown')}</span>
    </div>
    <div className="grid grid-cols-3 gap-2.5">
      {specs.map((s) => (
        <div key={s.k} className={`${card} flex gap-3 px-3.5 py-[13px]`}>
          <span className="flex h-[34px] w-[34px] shrink-0 items-center justify-center rounded-[9px] bg-[rgba(31,107,255,0.16)]"><Svg d={s.icon} size={17} stroke="#7FB2FF" /></span>
          <span className="flex min-w-0 flex-col gap-0.5">
            <span className="text-[11px] tracking-[0.06em] text-[#8FA3C8] uppercase">{s.k}</span>
            <span className="truncate text-[13px] font-medium" style={{ color: s.v === na ? C.muted : undefined }}>{s.v}</span>
            {s.d && <span className="truncate text-[11px] text-[#8FA3C8]">{s.d}</span>}
          </span>
        </div>
      ))}
    </div>
    <div className="grid gap-3" style={{ gridTemplateColumns: 'minmax(0,1.2fr) minmax(0,1fr)' }}>
      <div className={`${card} flex flex-col gap-2.5 px-4 py-3.5`}>
        <div className="flex justify-between gap-3 text-[13px]"><span className="font-semibold">{t('settings.about.storage')}{drives[0] ? ` · ${drives[0].device}` : ''}</span><span className="text-[#8FA3C8]">{free != null ? t('settings.about.freeHome', { size: formatBytes(free) }) : na}</span></div>
        {disk && disk.total > 0 && <AnimatedProgress value={(disk.used / disk.total) * 100} label={t('settings.about.storageUsed', { used: formatBytes(disk.used), total: formatBytes(disk.total) })} valueText={t('settings.about.storageUsed', { used: formatBytes(disk.used), total: formatBytes(disk.total) })} height={8} shimmer={false} />}
        <div className="flex flex-col gap-1">
          {disks.state === 'loading' ? <span className="text-xs text-[#8FA3C8]">…</span> : drives.length === 0 ? <span className="text-xs text-[#8FA3C8]">{disks.state === 'ok' ? t('common.noneFound') : na}</span>
            : drives.map((x) => <span key={x.device} className="flex items-center gap-1.5 text-[11px] text-[#C9D6EE]"><span className="h-2 w-2 rounded-sm bg-[#1F6BFF]" />{x.model || x.device} <span className="font-mono text-[#8FA3C8]">{x.device}</span></span>)}
        </div>
        {battery.state === 'ok' && battery.value.present && battery.value.percentage != null && <AnimatedProgress value={battery.value.percentage} label={t('settings.about.battery')} height={6} shimmer={battery.value.state === 'charging'} tone={battery.value.percentage <= 15 && battery.value.on_battery ? 'error' : battery.value.state === 'fully-charged' ? 'success' : 'default'} />}
        <span className="text-[11px] text-[#8FA3C8]">{battery.state === 'ok' && battery.value.present ? `${t('settings.about.battery')}: ${batteryText(battery.value)}` : t('settings.about.usageNote')}</span>
      </div>
      <div className={`${card} py-1.5`}>
        {sec.map((s) => (
          <div key={s.k} className="flex items-center gap-2.5 px-4 py-1.5 text-xs"><span className="h-[7px] w-[7px] rounded-full" style={{ background: s.c }} /><span className="flex-1 text-[#C9D6EE]">{s.k}</span><span className="font-mono text-[11px]" style={{ color: s.v === na ? C.muted : undefined }}>{s.v}</span></div>
        ))}
      </div>
    </div>
    <Diagnostics />
    <ReportProblem />
  </>
}

/** Settings › Managed: WSOS-MDM-007 management disclosure from the device agent, or enrollment when unmanaged. */
export function ManagedPanel() {
  const [showWipe, setShowWipe] = useState(false)
  const [kioskOpen, setKioskOpen] = useState(false)
  const [info, setInfo] = useState<DeviceInfo | null>(null)
  useEffect(() => { void os.deviceInfo().then(setInfo).catch(() => {}) }, [])
  if (!info) return <><H1>{t('settings.nav.Managed')}</H1><Empty title={t('settings.about.loading')} /></>
  const d = info.device
  const lines = policyLines(info.policies)
  const checked = info.last_check_in ? formatDate(info.last_check_in) : t('settings.about.notYet')
  const org = info.org_name ?? info.server ?? t('settings.about.yourOrg')
  if (kioskOpen && info.managed) return <KioskPanel kiosk={info.kiosk ?? null} org={org} onBack={() => setKioskOpen(false)} />
  return <>
    <H1>{t('settings.nav.Managed')}</H1>
    {info.managed ? (
      <section aria-label={t('settings.about.mgmt')} className="flex flex-col gap-2.5 rounded-[14px] border border-[rgba(31,107,255,0.35)] bg-[rgba(31,107,255,0.1)] px-5 py-[18px]">
        <span className="flex items-center gap-2 text-sm font-semibold"><Svg d="M12 3l8 3v6c0 5-3.5 8-8 9-4.5-1-8-4-8-9V6z" size={18} stroke="#7FB2FF" />{t('panel.managedBy', { org: info.org_name ?? info.server ?? t('settings.about.yourOrg') })}</span>
        <ul className="m-0 list-disc pl-[18px] text-[13px] leading-relaxed text-[#C9D6EE]">
          {lines.map((l) => <li key={l}>{l}</li>)}
          <li>{d?.encrypted ? t('settings.about.canWipeAll') : t('settings.about.canWipe')}</li>
        </ul>
        <span className="text-xs text-[#8FA3C8]">{info.server ? `${info.server} · ` : ''}{t('settings.about.lastCheck', { when: checked })}</span>
        {/* WSOS-WIPE-007: explain wipe scope */}
        <button type="button" aria-expanded={showWipe} onClick={() => setShowWipe((v) => !v)} className={`${linkBtn} self-start`}>{showWipe ? t('common.hide') : t('settings.about.wipeWhat')}</button>
        {showWipe && (
          <div className="rounded-[10px] border border-[rgba(127,178,255,0.16)] bg-[rgba(4,10,26,0.4)] p-3 text-[12.5px] leading-relaxed text-[#C9D6EE]">
            <p className="m-0"><strong>{t('settings.about.dataWipe')}</strong> {t('settings.about.dataWipeBody')}</p>
            <p className="mb-0 mt-2"><strong>{t('settings.about.fullWipe')}</strong> {d?.encrypted ? t('settings.about.fullWipeBody') : t('settings.about.fullWipeNo')}</p>
            <p className="mb-0 mt-2">{t('settings.about.wipeApproval')}</p>
          </div>
        )}
      </section>
    ) : null}
    {info.managed && (
      <button type="button" onClick={() => setKioskOpen(true)} className="flex min-h-14 cursor-pointer items-center gap-4 rounded-[14px] border border-[rgba(127,178,255,0.12)] bg-[rgba(14,32,72,0.6)] px-5 py-3 text-left hover:bg-[rgba(14,32,72,0.85)]">
        <span className="flex min-w-0 flex-1 flex-col gap-0.5"><span className="text-sm font-semibold">{t('kiosk.title')}</span><span className="text-xs text-[#8FA3C8]">{info.kiosk ? t('kiosk.rowOn', { user: info.kiosk.user }) : t('kiosk.rowOff')}</span></span>
        <span className={`rounded-full px-2.5 py-0.5 text-[11px] font-medium ${info.kiosk ? 'bg-[rgba(95,211,154,0.16)] text-[#5FD39A]' : 'bg-white/10 text-[#C9D6EE]'}`}>{info.kiosk ? t('common.on') : t('common.off')}</span>
        <Svg d="M9 6l6 6-6 6" size={16} stroke="#8FA3C8" />
      </button>
    )}
    {info.managed ? null : info.agent ? <EnrollCard onEnrolled={() => void os.deviceInfo().then(setInfo)} />
      : <Empty title={t('settings.about.mgmtUnavailable')}>{t('settings.about.agentDown')}</Empty>}
  </>
}

/** Enroll an unmanaged device with an organization (§9.3); same path as first-run: device agent via pkexec. */
function EnrollCard({ onEnrolled }: { onEnrolled: () => void }) {
  const [open, setOpen] = useState(false)
  const [server, setServer] = useState('')
  const [code, setCode] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const submit = async (e: React.FormEvent) => {
    e.preventDefault()
    if (!server.trim() || !code.trim()) return setError(t('settings.enroll.missing'))
    setBusy(true); setError(null)
    const r = await os.enrollDevice(serverUrlFor('enterprise', server), code)
    setBusy(false)
    if (!r.ok) return setError(cloudErrorText(r.error))
    onEnrolled()
  }
  return (
    <div className={`${card} flex flex-col gap-3 px-5 py-[18px] text-[13px]`}>
      <span className="text-[#8FA3C8]">{t('settings.enroll.unmanaged')}</span>
      {!open ? <button type="button" onClick={() => setOpen(true)} className={`${btnGhost} self-start`}>{t('settings.enroll.open')}</button> : (
        <form onSubmit={submit} className="flex flex-col gap-3" aria-label={t('settings.enroll.submit')}>
          <p className="m-0 text-[#8FA3C8]">{t('settings.enroll.explain')}</p>
          <label className="flex flex-col gap-1 font-semibold">{t('settings.enroll.server')}
            <input value={server} onChange={(e) => { setServer(e.target.value); setError(null) }} placeholder="work.example.com" spellCheck={false} className={`${field} font-normal`} />
          </label>
          <label className="flex flex-col gap-1 font-semibold">{t('settings.enroll.code')}
            <input value={code} onChange={(e) => { setCode(e.target.value.toUpperCase()); setError(null) }} autoComplete="off" spellCheck={false} className={`${field} w-[260px] max-w-full font-mono font-normal tracking-[1px]`} />
          </label>
          {error && <p role="alert" className="m-0 text-[#FF8A7A]">{error}</p>}
          <div className="flex gap-2">
            <button type="submit" disabled={busy} className={btnPrimary}>{busy ? t('settings.enroll.busy') : t('settings.enroll.submit')}</button>
            <button type="button" disabled={busy} onClick={() => { setOpen(false); setError(null) }} className={btnGhost}>{t('common.cancel')}</button>
          </div>
        </form>
      )}
    </div>
  )
}

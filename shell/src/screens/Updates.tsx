// OS update screens (boards U1–U7, UpdSettings) on the package service's update coordinator (WSOS-AUP-011).
// Everything shown comes from the coordinator status and the update job's progress events; the manifest
// carries no release notes, download size or update history, so those places say so instead.
import { useEffect, useState } from 'react'
import { createPortal } from 'react-dom'
import { formatBytes, os, packageErrorText, type BundleInfo, type DeviceInfo } from '../lib/os'
import { useOsUpdate, updates } from '../lib/useOsUpdate'
import { REMIND_KEY, SEEN_KEY, UPDATE_PHASES, fmtWhen, heroView, needsAttention, canDefer, restartOptions, whatsNew, type Action, type RestartChoice, type Tone } from '../lib/updates'
import { C, Dialog, OptionCard, Progress, Svg, btnGhost, btnPrimary, card, chip, dialogFooter, heroCard, linkBtn, rowLine } from '../components/Dk'
import { Mark } from '../components/Ws'
import { OfflineUpdates, showsOffline, useUsbBundles } from './UpdatesOffline'
import { formatNumber, messages, t } from '../i18n'

export const ICON = {
  download: 'M12 4v11M7 10l5 5 5-5M4 20h16',
  restart: 'M4 12a8 8 0 1 0 2.3-5.7M4 4v4h4',
  check: 'M5 12.5l4.5 4.5L19 7.5',
  alert: 'M12 8v5M12 16.5v.5M10.3 3.9L1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0z',
  rollback: 'M3 12a9 9 0 1 0 2.6-6.4M3 4v5h5',
}
const TONE: Record<Tone, { icon: string; color: string; bg: string }> = {
  download: { icon: ICON.download, color: '#7FB2FF', bg: 'rgba(31,107,255,0.18)' },
  busy: { icon: ICON.download, color: C.cyan, bg: 'rgba(24,212,240,0.14)' },
  ready: { icon: ICON.restart, color: C.green, bg: 'rgba(95,211,154,0.14)' },
  ok: { icon: ICON.check, color: C.green, bg: 'rgba(95,211,154,0.14)' },
  warn: { icon: ICON.alert, color: C.amber, bg: 'rgba(255,159,90,0.14)' },
}
/** SetUpdates board hero colours per state. */
const HERO: Record<Tone, { icon: string; bg: string; border: string }> = {
  ok: { icon: '#2E9E6A', bg: 'linear-gradient(120deg, rgba(46,158,106,0.25), rgba(14,32,72,0.7))', border: 'rgba(95,211,154,0.35)' },
  download: { icon: '#1F6BFF', bg: 'linear-gradient(120deg, rgba(31,107,255,0.3), rgba(14,32,72,0.7))', border: 'rgba(127,178,255,0.35)' },
  busy: { icon: '#0E8FA8', bg: 'linear-gradient(120deg, rgba(14,143,168,0.25), rgba(14,32,72,0.7))', border: 'rgba(24,212,240,0.35)' },
  ready: { icon: '#B7791F', bg: 'linear-gradient(120deg, rgba(183,121,31,0.25), rgba(14,32,72,0.7))', border: 'rgba(255,185,138,0.4)' },
  warn: { icon: '#D9572B', bg: 'linear-gradient(120deg, rgba(217,87,43,0.22), rgba(14,32,72,0.7))', border: 'rgba(255,159,90,0.4)' },
}
const ACTION_LABEL: Record<Action, string> = messages({ check: 'upd.action.check', later: 'upd.action.later', install: 'upd.action.install', schedule: 'upd.action.schedule', restart: 'upd.action.restart' })
const RING: Record<string, string> = messages({ development: 'upd.ring.development', pilot: 'upd.ring.pilot', stable: 'upd.ring.stable' })
const MODE: Record<string, string> = messages({ automatic: 'upd.mode.automatic', notify: 'upd.mode.notify', manual: 'upd.mode.manual' })

const ls = { get(k: string) { try { return localStorage.getItem(k) } catch { return null } }, set(k: string, v: string) { try { localStorage.setItem(k, v) } catch { /* ignore */ } } }
export const snoozed = () => Number(ls.get(REMIND_KEY) ?? 0) > Date.now()

async function run(a: Action, openSchedule: () => void) {
  if (a === 'check') await updates.check()
  else if (a === 'later') await updates.defer()
  else if (a === 'install') await updates.installNow()
  else if (a === 'schedule') openSchedule()
  else if (a === 'restart') await os.power('restart')
}

/** Settings › Updates (UpdSettings board). */
export function UpdatesPanel() {
  const { status: st, job, error } = useOsUpdate()
  const [busy, setBusy] = useState(false)
  const [schedule, setSchedule] = useState(false)
  const [policy, setPolicy] = useState<DeviceInfo['policies']>(null)
  const [orgName, setOrgName] = useState<string | null>(null)
  const bundles = useUsbBundles()
  const [, tick] = useState(0)
  useEffect(() => {
    void os.deviceInfo().then((d) => { setPolicy(d.policies); setOrgName(d.org_name) }).catch(() => {})
    const t = setInterval(() => tick((n) => n + 1), 15_000)
    return () => clearInterval(t)
  }, [])

  if (!st) {
    return <div className={`${heroCard} p-5 text-sm text-[#8FA3C8]`} role="status">{error ? t('upd.statusUnavailable', { error }) : t('upd.loading')}</div>
  }
  // G14: emergency release, resumed download or a bundle on a USB drive.
  if (showsOffline(st, bundles)) return <OfflineUpdates st={st} job={job} policy={policy} orgName={orgName} bundles={bundles} />
  const v = heroView(st, job)
  const tone = TONE[v.tone]
  const act = async (a: Action) => { setBusy(true); await run(a, () => setSchedule(true)); setBusy(false) }
  const pct = v.progress && v.progress !== 'indeterminate' ? v.progress.percent : null
  const offered = st.version && st.version !== st.installed ? st.version : null

  const hero = HERO[v.tone]
  const opts: [string, string, string][] = [
    [t('upd.modeLabel'), policy ? t('upd.setByOrg') : t('upd.onThisComputer'), MODE[policy?.update_mode ?? 'automatic']],
    [t('upd.installs'), t('upd.installsHint'), policy?.maintenance_window ? t('upd.inWindow', { window: policy.maintenance_window }) : t('upd.whenIdle')],
    [t('upd.metered'), t('upd.meteredHint'), t('upd.meteredWait')],
    [t('upd.ringLabel'), policy ? t('upd.setByOrg') : t('upd.onThisComputer'), RING[policy?.update_ring ?? 'stable']],
  ]
  return (
    <div className="flex min-h-0 flex-1 flex-col gap-3.5">
      {/* SetUpdates board hero: tinted by state */}
      <div className="flex items-center gap-5 rounded-[18px] border px-6 py-[22px]" style={{ background: hero.bg, borderColor: hero.border }} aria-live="polite">
        <span className="flex h-[60px] w-[60px] shrink-0 items-center justify-center rounded-2xl" style={{ background: hero.icon }}>
          <span className={v.tone === 'busy' && !pct ? 'ws-spin inline-flex' : 'inline-flex'}><Svg d={v.tone === 'busy' && st.state === 'checking' ? ICON.restart : tone.icon} size={30} stroke="#FFFFFF" /></span>
        </span>
        <div className="flex min-w-0 flex-1 flex-col gap-[5px]">
          <span className="text-xl font-bold">{v.title}</span>
          <span className="text-[13px] text-[#C9D6EE]">{v.sub}</span>
          {v.progress && st.state === 'installing' && (
            <div className="mt-1 flex flex-col gap-1.5">
              <Progress value={pct} label={t('upd.progress')} height={6} shine />
              <span className="font-mono text-xs text-[#8FA3C8]">{pct == null ? t('upd.starting') : `${UPDATE_PHASES[v.progress === 'indeterminate' ? '' : v.progress.phase] ?? ''} · ${formatNumber(pct)}%`}</span>
            </div>
          )}
          {error && <span role="alert" className="text-[13px] text-[#FF8A7A]">{error}</span>}
        </div>
        <div className="flex shrink-0 gap-2">
          {v.secondary && <button type="button" disabled={busy} onClick={() => void act(v.secondary!)} className="cursor-pointer rounded-[10px] border border-white/25 px-4 py-2.5 text-sm hover:bg-white/[0.06] disabled:opacity-50">{ACTION_LABEL[v.secondary]}</button>}
          {v.primary && <button type="button" disabled={busy} onClick={() => void act(v.primary!)} className="cursor-pointer rounded-[10px] px-[18px] py-2.5 text-sm font-semibold text-white disabled:opacity-50" style={{ background: v.primary === 'check' ? 'rgba(255,255,255,0.14)' : '#1F6BFF' }}>{ACTION_LABEL[v.primary]}</button>}
        </div>
      </div>

      <div className="grid min-h-0 flex-1 grid-cols-[minmax(0,1.2fr)_minmax(0,1fr)] gap-3">
        <section aria-labelledby="upd-hist" className="flex flex-col gap-2">
          <h2 id="upd-hist" className="m-0 text-sm font-semibold">{t('upd.history')}</h2>
          <div className={`${card} overflow-hidden`}>
            {offered && (
              <div className={`flex items-center gap-3 px-4 py-[11px] ${rowLine}`}>
                <span className="h-2 w-2 rounded-full" style={{ background: C.cyan }} />
                <span className="flex flex-1 flex-col gap-0.5"><span className="text-[13px] font-medium">WorkSuite OS {offered}</span><span className="text-[11px] text-[#8FA3C8]">{t('upd.notesMissing')}</span></span>
                <span className="text-[11px]" style={{ color: C.cyan }}>{t('upd.hist.offered')}</span>
              </div>
            )}
            <div className={`flex items-center gap-3 px-4 py-[11px] ${rowLine}`}>
              <span className="h-2 w-2 rounded-full" style={{ background: C.green }} />
              <span className="flex flex-1 flex-col gap-0.5"><span className="text-[13px] font-medium">WorkSuite OS {st.installed}</span><span className="text-[11px] text-[#8FA3C8]">{t('upd.lastChecked', { when: st.last_check ? fmtWhen(st.last_check) : t('settings.about.notYet') })}</span></span>
              <span className="text-[11px]" style={{ color: C.green }}>{t('upd.hist.installed')}</span>
            </div>
            <div className={`px-4 py-[11px] text-[11px] text-[#8FA3C8] ${rowLine}`}>{t('upd.hist.none')}</div>
          </div>
        </section>
        <div className="flex flex-col gap-2">
          <div className="flex items-center justify-between"><h2 id="upd-opts" className="m-0 text-sm font-semibold">{t('upd.options')}</h2>{policy && <span className={chip}>{t('settings.lock.policy')}</span>}</div>
          <div className={`${card} overflow-hidden`} aria-labelledby="upd-opts" role="group">
            {opts.map(([k, d, val]) => (
              <div key={k} className={`flex items-center gap-3 px-4 py-[11px] ${rowLine}`}>
                <span className="flex flex-1 flex-col gap-0.5"><span className="text-[13px]">{k}</span><span className="text-[11px] text-[#8FA3C8]">{d}</span></span>
                <span className="text-xs text-[#C9D6EE]">{val}</span>
              </div>
            ))}
          </div>
          <OfflineBundle />
        </div>
      </div>
      {schedule && <RestartDialog onClose={() => setSchedule(false)} />}
    </div>
  )
}

/** U4: "When should we restart?" — only choices that really happen. */
/** WSOS-AUP-010: signed .wsupdate bundle from a USB drive, for sites without internet access. */
function OfflineBundle() {
  const [picked, setPicked] = useState<{ handle: string; name: string } | null>(null)
  const [info, setInfo] = useState<BundleInfo | null>(null)
  const [msg, setMsg] = useState<{ text: string; error?: boolean } | null>(null)
  const [job, setJob] = useState<string | null>(null)
  useEffect(() => os.onPkgJob((e) => {
    if (e.kind !== 'finished' || e.job !== job) return
    setJob(null)
    setMsg(e.result === 'success' ? { text: t('upd.usb.installed') } : { text: packageErrorText(e.error ?? 'failed'), error: true })
  }), [job])
  const choose = async () => {
    setMsg(null); setInfo(null)
    const f = await os.pickFile('wsupdate')
    if (!f.ok) { if (f.error !== 'cancelled') setMsg({ text: packageErrorText(f.error), error: true }); return }
    setPicked(f.value)
    const r = await os.bundleInspect(f.value.handle)
    if (r.ok) setInfo(r.value); else setMsg({ text: packageErrorText(r.error), error: true })
  }
  const install = async () => {
    if (!picked) return
    const r = await os.bundleInstall(picked.handle)
    if (r.ok) { setJob(r.value); setMsg({ text: t('upd.usb.installing') }) } else setMsg({ text: packageErrorText(r.error), error: true })
  }
  return (
    <section aria-labelledby="upd-usb" className={`${card} flex flex-col gap-2 px-[18px] py-4 text-[13px]`}>
      <h2 id="upd-usb" className="m-0 text-sm font-semibold">{t('upd.usb.title')}</h2>
      <span className="text-[#8FA3C8]">{info ? t('upd.usb.info', { file: picked?.name ?? '', version: info.version, count: formatNumber(info.packages), size: formatBytes(info.bytes) }) : t('upd.usb.hint')}</span>
      {msg && <span role={msg.error ? 'alert' : 'status'} className={msg.error ? 'text-[#FF8A7A]' : 'text-[#C9D6EE]'}>{msg.text}</span>}
      <div className="flex gap-2">
        <button type="button" disabled={!!job} onClick={() => void choose()} className={btnGhost}>{t('upd.usb.choose')}</button>
        {info && <button type="button" disabled={!!job} onClick={() => void install()} className={btnPrimary}>{t('common.install')}</button>}
      </div>
    </section>
  )
}

export function RestartDialog({ onClose }: { onClose: () => void }) {
  const opts = restartOptions()
  const [pick, setPick] = useState<RestartChoice>('now')
  const cur = opts.find((o) => o.id === pick)!
  const go = async () => {
    if (pick === 'now') { await os.power('restart'); return }
    if (pick === 'remind') ls.set(REMIND_KEY, String(Date.now() + 86_400_000))
    onClose()
  }
  return (
    <Dialog onClose={onClose}>
      {(tid) => <>
        <div className="flex flex-col gap-1.5 px-6 pt-6 pb-4">
          <h2 id={tid} className="m-0 text-[19px] font-bold">{t('upd.restart.title')}</h2>
          <p className="m-0 text-sm text-[#C9D6EE]">{t('upd.restart.body')}</p>
        </div>
        <div role="radiogroup" aria-labelledby={tid} className="flex flex-col gap-1.5 px-4 pb-4">
          {opts.map((o) => <OptionCard key={o.id} name="when" checked={pick === o.id} disabled={o.disabled} onPick={() => setPick(o.id)} title={o.label} desc={o.desc} />)}
        </div>
        <div className={dialogFooter}>
          <button type="button" onClick={onClose} className={btnGhost}>{t('common.cancel')}</button>
          <button type="button" data-autofocus onClick={() => void go()} className={btnPrimary}>{cur.cta}</button>
        </div>
      </>}
    </Dialog>
  )
}

/** U5: full screen while a required update installs after the restart warning; the coordinator restarts afterwards. */
export function UpdatingScreen({ from, to, percent, phase }: { from: string; to: string | null; percent: number | null; phase: string | null }) {
  return (
    <div role="dialog" aria-modal="true" aria-labelledby="updating-t" className="fixed inset-0 z-[80] flex flex-col items-center justify-center gap-7 bg-[#040A1A] font-sans text-[#E8EEFA]">
      <div className="relative h-[120px] w-[120px]">
        <svg className="ws-spin absolute inset-0" width="120" height="120" viewBox="0 0 120 120" aria-hidden="true"><circle cx="60" cy="60" r="54" fill="none" stroke="rgba(127,178,255,0.12)" strokeWidth="4" /><path d="M60 6a54 54 0 0 1 54 54" fill="none" stroke="#18D4F0" strokeWidth="4" strokeLinecap="round" /></svg>
        <span className="absolute top-9 left-9"><Mark size={48} hole="#040A1A" /></span>
      </div>
      <div className="flex flex-col items-center gap-2.5">
        <h1 id="updating-t" className="m-0 text-[28px] font-medium">{t('upd.updating')}{percent != null ? ` · ${formatNumber(percent)}%` : ''}</h1>
        <p className="m-0 text-[15px] text-[#8FA3C8]">{t('upd.dontTurnOff')}</p>
      </div>
      <div className="flex w-[420px] max-w-full flex-col gap-2.5">
        <Progress value={percent} label={t('upd.progress')} height={4} />
        <div className="flex justify-between font-mono text-xs text-[#8FA3C8]"><span>{phase ? UPDATE_PHASES[phase] ?? phase : t('upd.startingShort')}</span><span>{from}{to ? ` → ${to}` : ''}</span></div>
      </div>
    </div>
  )
}

/** U7: an install failed while the shell watched. There are no system snapshots, so nothing is claimed as restored. */
export function UpdateFailed({ installed, version, reason, phase, percent, onRetry, onClose }: {
  installed: string; version: string | null; reason: string; phase: string | null; percent: number | null; onRetry: () => void; onClose: () => void
}) {
  const rows: [string, string][] = [
    [t('upd.fail.current'), installed],
    [t('upd.fail.at'), phase ? `${UPDATE_PHASES[phase] ?? phase}${percent != null ? ` · ${formatNumber(percent)}%` : ''}` : t('upd.fail.unknownStep')],
    [t('upd.fail.error'), reason],
  ]
  return (
    <div role="alertdialog" aria-modal="true" aria-labelledby="upd-fail-t" aria-describedby="upd-fail-d"
      className="fixed inset-0 z-[80] flex flex-col items-center justify-center gap-[18px] overflow-auto p-4 font-sans text-[#E8EEFA]"
      style={{ background: 'radial-gradient(ellipse 60% 50% at 50% 35%, #2A1A2E 0%, #071330 60%, #040A1A 100%)' }}>
      <div className="flex h-[88px] w-[88px] items-center justify-center rounded-full bg-[rgba(255,159,90,0.14)] shadow-[0_0_0_10px_rgba(255,159,90,0.05)]"><Svg d={ICON.rollback} size={42} stroke={C.amber} /></div>
      <h1 id="upd-fail-t" className="m-0 mt-2.5 text-[32px] font-bold tracking-[-0.02em]">{t('upd.fail.title')}</h1>
      <p id="upd-fail-d" className="m-0 max-w-[560px] text-center text-base leading-normal text-[#C9D6EE]">
        {t('upd.fail.body', { version: version ?? t('upd.fail.update') })}
      </p>
      <dl className="m-0 mt-2 w-[560px] max-w-full overflow-hidden rounded-[14px] border border-[rgba(127,178,255,0.16)] bg-[rgba(14,32,72,0.7)]">
        {rows.map(([k, v]) => <div key={k} className={`flex justify-between gap-6 px-[18px] py-3 text-[13px] ${rowLine}`}><dt className="text-[#8FA3C8]">{k}</dt><dd className="m-0 text-right font-mono">{v}</dd></div>)}
      </dl>
      <div className="mt-3.5 flex gap-3">
        <button type="button" onClick={onRetry} className={`${btnGhost} px-[22px] py-3 text-[15px]`}>{t('common.tryAgain')}</button>
        <button type="button" data-autofocus autoFocus onClick={onClose} className={`${btnPrimary} px-7 py-3 text-[15px] shadow-[0_8px_24px_rgba(31,107,255,0.35)]`}>{t('upd.fail.continue')}</button>
      </div>
    </div>
  )
}

/** U6: shown once after the installed version goes up. */
export function WhatsNew({ version, onClose }: { version: string; onClose: () => void }) {
  return (
    <Dialog width={640} onClose={onClose} backdrop="rgba(2,6,16,0.45)" className="rounded-[20px]">
      {(tid) => <>
        <div className="flex h-[150px] items-end px-7 py-[22px]" style={{ background: 'radial-gradient(circle at 70% 30%, rgba(24,212,240,0.5), transparent 50%), linear-gradient(135deg, #1F6BFF, #0D2353)' }}>
          <div className="flex flex-col gap-1">
            <span className="font-mono text-xs tracking-[0.08em] text-[#D6F7FF]">{t('upd.new.updatedTo', { version })}</span>
            <h2 id={tid} className="m-0 text-[28px] font-bold text-white">{t('upd.new.title')}</h2>
          </div>
        </div>
        <div className="flex gap-3 px-7 py-[22px]">
          <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-[10px] bg-[rgba(31,107,255,0.18)]"><Svg d={ICON.check} size={18} stroke="#7FB2FF" /></span>
          <span className="flex flex-col gap-[3px]">
            <span className="text-sm font-semibold">{t('upd.new.installed', { version })}</span>
            <span className="text-[13px] leading-[1.4] text-[#8FA3C8]">{t('upd.new.noNotes')}</span>
          </span>
        </div>
        <div className={dialogFooter}>
          <button type="button" data-autofocus onClick={onClose} className={`${btnPrimary} px-[22px]`}>{t('common.gotIt')}</button>
        </div>
      </>}
    </Dialog>
  )
}

/** U1: update toast above the taskbar. */
export function UpdateToast({ onDetails, onSchedule, onDismiss }: { onDetails: () => void; onSchedule: () => void; onDismiss: () => void }) {
  const { status: st } = useOsUpdate()
  const [busy, setBusy] = useState(false)
  if (!st) return null
  const ready = st.state === 'ready_to_restart'
  const title = ready ? t('update.restart') : st.state === 'restart_pending' ? t('upd.toast.forced') : t('upd.toast.ready', { version: st.version ?? '' })
  const body = ready ? t('upd.toast.installed', { version: st.installed })
    : st.state === 'restart_pending' ? t('upd.toast.save')
    : st.mandatory ? (st.deadline ? t('upd.toast.requiredBy', { when: fmtWhen(st.deadline) }) : t('upd.toast.required'))
    : t('upd.toast.keepWorking')
  const act = async (fn: () => Promise<unknown>) => { setBusy(true); await fn(); setBusy(false) }
  return (
    <div role="status" aria-label={t('upd.toast.label')} className="pointer-events-auto w-full overflow-hidden rounded-2xl border border-[rgba(127,178,255,0.22)] bg-[rgba(10,24,56,0.96)] text-[#E8EEFA] shadow-[0_24px_60px_rgba(0,0,0,0.5)]">
      <div className="flex gap-3.5 p-[18px]">
        <span className="flex h-11 w-11 shrink-0 items-center justify-center rounded-xl bg-[rgba(31,107,255,0.2)]"><Svg d={ready ? ICON.restart : ICON.download} size={22} stroke="#7FB2FF" /></span>
        <div className="flex flex-1 flex-col gap-1">
          <div className="flex justify-between gap-2"><span className="text-[15px] font-semibold">{title}</span>
            <button type="button" aria-label={t('common.dismiss')} onClick={onDismiss} className="-mt-1 -mr-1 flex h-6 w-6 cursor-pointer items-center justify-center rounded-md text-base leading-none text-[#8FA3C8] hover:bg-white/10 hover:text-white">×</button></div>
          <span className="text-[13px] leading-[1.45] text-[#C9D6EE]">{body}</span>
        </div>
      </div>
      <div className="flex gap-2 pr-[18px] pb-[18px] pl-[76px]">
        {ready || st.state === 'restart_pending' ? <>
          <button type="button" onClick={() => void os.power('restart')} className="cursor-pointer rounded-[9px] bg-[#1F6BFF] px-3.5 py-[9px] text-[13px] font-semibold text-white hover:bg-[#3A7DFF]">{t('upd.action.restart')}</button>
          {ready && <button type="button" onClick={onSchedule} className="cursor-pointer rounded-[9px] border border-[rgba(127,178,255,0.25)] px-3.5 py-[9px] text-[13px] font-medium hover:bg-white/[0.06]">{t('upd.action.schedule')}</button>}
        </> : <>
          <button type="button" disabled={busy} onClick={() => void act(updates.installNow)} className="cursor-pointer rounded-[9px] bg-[#1F6BFF] px-3.5 py-[9px] text-[13px] font-semibold text-white hover:bg-[#3A7DFF] disabled:opacity-60">{t('upd.installNow')}</button>
          {canDefer(st) && <button type="button" disabled={busy} onClick={() => void act(async () => { await updates.defer(); onDismiss() })} className="cursor-pointer rounded-[9px] border border-[rgba(127,178,255,0.25)] px-3.5 py-[9px] text-[13px] font-medium hover:bg-white/[0.06] disabled:opacity-60">{t('upd.action.later')}</button>}
        </>}
        <button type="button" onClick={onDetails} className={`${linkBtn} px-2.5 py-[9px]`}>{t('common.details')}</button>
      </div>
    </div>
  )
}

/** Taskbar button (U1 board): restart/update glyph with a cyan dot while something waits for the person. */
export function TaskbarUpdateButton({ onOpen }: { onOpen: () => void }) {
  const { status } = useOsUpdate()
  if (!needsAttention(status)) return null
  const ready = status!.state === 'ready_to_restart'
  return (
    <button type="button" onClick={onOpen} aria-label={ready ? t('upd.badgeReady') : t('update.available')}
      className="relative flex h-8 w-8 cursor-pointer items-center justify-center rounded-lg bg-[rgba(31,107,255,0.25)] hover:bg-[rgba(31,107,255,0.4)]">
      <Svg d={ICON.restart} size={18} stroke="#FFFFFF" />
      <span className="absolute top-1 right-1 h-2 w-2 rounded-full bg-[#18D4F0]" />
    </button>
  )
}

/** Desktop-level update UI: toast, restart dialog, forced-install screen, failure screen, what's new. */
export function UpdateOverlays({ onOpenUpdates, quiet }: { onOpenUpdates: () => void; quiet?: boolean }) {
  const { status: st, job, tracking } = useOsUpdate()
  const [dismissed, setDismissed] = useState<string | null>(null)
  const [schedule, setSchedule] = useState(false)
  const [news, setNews] = useState<string | null>(null)

  // U6: compare the installed version with the last one this user saw.
  useEffect(() => {
    if (!st) return
    const seen = ls.get(SEEN_KEY)
    if (whatsNew(seen, st.installed)) setNews(st.installed)
    if (seen !== st.installed) ls.set(SEEN_KEY, st.installed)
  }, [st?.installed]) // eslint-disable-line react-hooks/exhaustive-deps

  if (!st) return null
  const key = `${st.release_id}:${st.state}`
  const showToast = !quiet && needsAttention(st) && !snoozed() && dismissed !== key && !schedule && !tracking.forced && !tracking.failure
  return <>
    {showToast && <UpdateToast onDismiss={() => setDismissed(key)} onSchedule={() => setSchedule(true)} onDetails={() => { setDismissed(key); onOpenUpdates() }} />}
    {schedule && <RestartDialog onClose={() => setSchedule(false)} />}
    {tracking.forced && createPortal(<UpdatingScreen from={st.installed} to={st.version} percent={job?.percent ?? null} phase={job?.phase ?? null} />, document.body)}
    {tracking.failure && createPortal(<UpdateFailed {...tracking.failure} onClose={updates.clearFailure} onRetry={() => { updates.clearFailure(); void updates.installNow() }} />, document.body)}
    {news && !tracking.forced && !tracking.failure && <WhatsNew version={news} onClose={() => setNews(null)} />}
  </>
}

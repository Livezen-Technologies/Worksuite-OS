// Settings › Privacy & security and Lock screen (from Settings.tsx).
import { useEffect, useState } from 'react'
import { lockChoiceLabel, os, type DeviceInfo, type LockSettings, type SecurityStatus } from '../../lib/os'
import { DEFAULT_PRIVACY, KEYS, readJson, writeJson, type Privacy } from '../../lib/setup'
import { needsAttention, fmtWhen } from '../../lib/updates'
import { useOsUpdate } from '../../lib/useOsUpdate'
import { SecuritySection } from './Security'
import { MonitoringSection } from './Monitoring'
import { C, Svg, Switch, btnGhost, card, chip, rowLine } from '../../components/Dk'
import { t } from '../../i18n'
import { ClipboardSection } from '../DesktopSettings'
import { AppPermissionsSection } from './AppPermissions'
import { navLabel } from './nav'
import { H1, Note } from './common'

export function PrivacyPanel() {
  const [p, setP] = useState<Privacy>(() => readJson<Privacy>(KEYS.privacy, DEFAULT_PRIVACY))
  const [info, setInfo] = useState<DeviceInfo | null>(null)
  const { status } = useOsUpdate()
  useEffect(() => { void os.deviceInfo().then(setInfo).catch(() => {}) }, [])
  const set = (k: keyof Privacy) => (v: boolean) => { const n = { ...p, [k]: v }; setP(n); writeJson(KEYS.privacy, n) }
  const [lock, setLock] = useState<LockSettings | null>(null)
  useEffect(() => { void os.lockSettings().then(setLock).catch(() => {}) }, [])
  const [sec, setSec] = useState<SecurityStatus | null>(null)
  useEffect(() => { void os.securityStatus().then(setSec).catch(() => {}); return os.onSecurityChanged(setSec) }, [])
  const enc = info?.device?.encrypted
  type Tile = { t: string; d: string; ok: boolean | null; icon: string }
  const tiles: Tile[] = [
    { t: enc === false ? t('settings.priv.notEncrypted') : t('settings.priv.encryption'), d: enc ? t('settings.priv.luksOn') : enc === false ? t('settings.priv.readable') : t('settings.priv.statusUnavailable'), ok: enc ?? null, icon: 'M5 11h14v10H5zM8 11V7a4 4 0 0 1 8 0v4' },
    { t: t('settings.priv.firewall'), d: !sec ? t('settings.priv.statusUnavailable') : sec.firewall.active ? t('sec.firewallOn') : t('sec.firewallOff'), ok: sec ? sec.firewall.active : null, icon: 'M12 3l8 3v6c0 5-3.5 8-8 9-4.5-1-8-4-8-9V6z' },
    status?.state === 'up_to_date'
      ? { t: t('settings.priv.upToDate'), d: t('settings.priv.checked', { when: status.last_check ? fmtWhen(status.last_check) : '—' }), ok: true, icon: 'M5 12.5l4.5 4.5L19 7.5' }
      : { t: needsAttention(status) ? t('settings.priv.updateWaiting') : t('settings.nav.Updates'), d: needsAttention(status) ? t('settings.priv.openUpdates') : status ? t('settings.priv.seeUpdates') : t('settings.priv.statusUnavailable'), ok: needsAttention(status) ? false : null, icon: 'M4 12a8 8 0 1 0 2.3-5.7M4 4v4h4' },
    { t: t('settings.priv.screenLock'), d: !lock ? t('settings.priv.statusUnavailable') : lock.timeout_s ? t('settings.priv.lockAfter', { time: lockChoiceLabel(lock.timeout_s) }) : t('settings.priv.lockOff'), ok: lock ? lock.timeout_s > 0 : null, icon: 'M7 11V7a5 5 0 0 1 10 0v4M5 11h14v10H5z' },
  ]
  const known = tiles.filter((x) => x.ok !== null)
  const passed = known.filter((x) => x.ok).length
  const failing = tiles.find((x) => x.ok === false)
  const allGood = known.length > 0 && passed === known.length
  const ring = 2 * Math.PI * 30
  const tone = (ok: boolean | null) => ok === true ? C.green : ok === false ? C.amber : C.muted
  const perms: { k: keyof Privacy; t: string; d: string; icon: string }[] = [
    { k: 'location', t: t('settings.priv.location'), d: t('settings.priv.locationHint'), icon: 'M12 21s-7-6.5-7-12a7 7 0 0 1 14 0c0 5.5-7 12-7 12z' },
    { k: 'updates', t: t('settings.priv.autoUpdates'), d: t('settings.priv.autoUpdatesHint'), icon: 'M12 3l8 3v6c0 5-3.5 8-8 9-4.5-1-8-4-8-9V6z' },
    { k: 'crash', t: t('settings.priv.crash'), d: t('settings.priv.crashHint'), icon: 'M12 8v5M12 16.5v.5M10.3 3.9L1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0z' },
    { k: 'usage', t: t('settings.priv.usage'), d: t('settings.priv.usageHint'), icon: 'M4 20V10M10 20V4M16 20v-7M22 20H2' },
  ]
  return <>
    <H1>{navLabel('Privacy & security')}</H1>
    <section aria-label={t('settings.priv.summary')} className="flex items-center gap-[22px] rounded-2xl border px-[22px] py-[18px]"
      style={allGood ? { background: 'linear-gradient(120deg, rgba(46,158,106,0.22), var(--ws-g-card))', borderColor: 'rgba(95,211,154,0.35)' } : { background: 'linear-gradient(120deg, rgba(255,159,90,0.14), var(--ws-g-card))', borderColor: 'rgba(255,159,90,0.3)' }}>
      <div className="relative h-[72px] w-[72px] shrink-0">
        <svg width="72" height="72" viewBox="0 0 72 72" aria-hidden="true">
          <circle cx="36" cy="36" r="30" fill="none" stroke="rgba(127,178,255,0.18)" strokeWidth="7" />
          {known.length > 0 && <circle cx="36" cy="36" r="30" fill="none" stroke={allGood ? C.green : C.amber} strokeWidth="7" strokeLinecap="round" strokeDasharray={`${(passed / tiles.length) * ring} ${ring}`} transform="rotate(-90 36 36)" />}
        </svg>
        <span className="absolute inset-0 flex items-center justify-center text-lg font-bold">{passed}/{tiles.length}</span>
      </div>
      <span className="flex flex-1 flex-col gap-1">
        <span className="text-[17px] font-bold">{allGood ? t('settings.priv.wellProtected') : t('settings.priv.checksPassed', { n: String(passed), total: String(tiles.length) })}</span>
        <span className="text-[13px] text-[#C9D6EE]">{failing ? t('settings.priv.suggestion', { what: `${failing.t} · ${failing.d}` }) : known.length < tiles.length ? t('settings.priv.someUnknown') : t('settings.priv.noSuggestions')}</span>
      </span>
    </section>
    <div className="grid grid-cols-4 gap-2.5">
      {tiles.map((c) => (
        <div key={c.t} className={`${card} flex flex-col gap-1.5 px-3.5 py-[13px]`}>
          <Svg d={c.icon} size={20} stroke={tone(c.ok)} />
          <span className="text-[13px] font-semibold">{c.t}</span>
          <span className="text-[11px]" style={{ color: tone(c.ok) }}>{c.d}</span>
        </div>
      ))}
    </div>
    <div className="grid min-h-0 gap-3" style={{ gridTemplateColumns: 'minmax(0,1.25fr) minmax(0,1fr)' }}>
      <section aria-labelledby="priv-choices" className="flex flex-col gap-2">
        <h2 id="priv-choices" className="m-0 text-sm font-semibold">{t('settings.priv.choices')}</h2>
        <div className={`${card} overflow-hidden`}>
          {perms.map((x) => (
            <div key={x.k} className={`flex items-center gap-3 px-4 py-[11px] ${rowLine}`}>
              <Svg d={x.icon} size={18} stroke="#7FB2FF" />
              <span className="flex flex-1 flex-col gap-0.5"><span className="text-[13px] font-medium">{x.t}</span><span className="text-[11px] text-[#8FA3C8]">{x.d}</span></span>
              <Switch small label={x.t} checked={p[x.k]} onChange={set(x.k)} />
            </div>
          ))}
        </div>
      </section>
      <section aria-labelledby="priv-it" className="flex flex-col gap-2">
        <h2 id="priv-it" className="m-0 text-sm font-semibold">{t('settings.priv.itSees')}</h2>
        <div className={`${card} px-4 py-3 text-xs leading-relaxed text-[#C9D6EE]`}>{t('settings.priv.note')}</div>
      </section>
    </div>
    <AppPermissionsSection />
    <SecuritySection info={info} />
    <MonitoringSection />
    <ClipboardSection />
  </>
}

/** WSOS-LOCK-003: idle lock timeout chosen by the user, within the organization's maximum (worksuite-idle applies it). */
export function LockAfterRow() {
  const [s, setS] = useState<LockSettings | null>(null)
  const [err, setErr] = useState<string | null>(null)
  useEffect(() => { void os.lockSettings().then(setS).catch(() => setErr(t('settings.lock.unavailable'))) }, [])
  const change = async (v: number) => {
    const r = await os.setLockTimeout(v)
    if (r.ok) { setS(r.value); setErr(null) } else setErr(r.error === 'above_policy_maximum' ? t('settings.lock.tooLong') : t('settings.lock.saveFailed'))
  }
  const help = err ?? (!s ? t('common.loading') : s.max_s !== null ? t('settings.lock.allowsUpTo', { time: lockChoiceLabel(s.max_s) }) : t('settings.lock.beforeSleep'))
  return (
    <div className={`flex items-center gap-4 px-[18px] py-3.5 ${rowLine}`}>
      <span className="flex flex-1 flex-col gap-0.5"><span className="text-sm">{t('settings.lock.after')}</span><span className="text-xs text-[#8FA3C8]" role={err ? 'alert' : undefined}>{help}</span></span>
      {s?.max_s != null && <span className={chip}>{t('settings.lock.policy')}</span>}
      {s && <select aria-label={t('settings.lock.after')} value={s.timeout_s} onChange={(e) => void change(Number(e.target.value))}
        className="h-9 rounded-lg border border-[rgba(127,178,255,0.25)] bg-[rgba(4,10,26,0.5)] px-2 text-[13px] text-white">
        {s.choices.map((c) => <option key={c} value={c}>{lockChoiceLabel(c)}</option>)}
      </select>}
    </div>
  )
}

/** Settings › Lock screen: the idle lock from the lock policy (WSOS-LOCK-003) and what the lock screen shows. */
export function LockScreenPanel({ onLock }: { onLock: () => void }) {
  return <>
    <H1 action={<button type="button" onClick={onLock} className={btnGhost}>{t('settings.lockscreen.lockNow')}</button>}>{t('settings.nav.Lock screen')}</H1>
    <div className={`${card} overflow-hidden`}>
      <LockAfterRow />
      <div className={`flex items-center gap-4 px-[18px] py-3.5 ${rowLine}`}>
        <span className="flex flex-1 flex-col gap-0.5"><span className="text-sm">{t('settings.notif.onLock')}</span><span className="text-xs text-[#8FA3C8]">{t('settings.lockscreen.notesHint')}</span></span>
        <span className="text-[13px] text-[#C9D6EE]">{t('settings.notif.titlesOnly')}</span>
      </div>
      <div className={`flex items-center gap-4 px-[18px] py-3.5 ${rowLine}`}>
        <span className="flex flex-1 flex-col gap-0.5"><span className="text-sm">{t('settings.lockscreen.unlock')}</span><span className="text-xs text-[#8FA3C8]">{t('settings.users.method')}</span></span>
        <span className="text-[13px] text-[#C9D6EE]">{t('greeter.password')}</span>
      </div>
    </div>
    <Note>{t('settings.lockscreen.note')}</Note>
  </>
}

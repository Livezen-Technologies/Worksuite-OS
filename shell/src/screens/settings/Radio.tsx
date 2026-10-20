// Settings › Network and Bluetooth: what stops Wi-Fi or Bluetooth from working, in words, with the fix when there is
// one (#31). The facts come from electron/radios.ts (sysfs, rfkill, the services); nothing here is guessed.
import { useCallback, useEffect, useState } from 'react'
import { os } from '../../lib/os'
import { requestSettingsSection } from '../../lib/settingsNav'
import { btnGhost, card, linkBtn, rowLine } from '../../components/Dk'
import { t, type MessageKey } from '../../i18n'
import type { RadioDiagnosis, RadioKind, RadioProblem, RadioProblemCode } from '../../../electron/radios'

const TITLE: Record<RadioProblemCode, MessageKey> = {
  no_hardware: 'radio.p.no_hardware', no_driver: 'radio.p.no_driver', no_interface: 'radio.p.no_interface', hard_blocked: 'radio.p.hard_blocked',
  soft_blocked: 'radio.p.soft_blocked', service_stopped: 'radio.p.service_stopped', service_missing: 'radio.p.service_missing', supplicant_missing: 'radio.p.supplicant_missing',
}
const HINT: Record<RadioProblemCode, MessageKey> = {
  no_hardware: 'radio.h.no_hardware', no_driver: 'radio.h.no_driver', no_interface: 'radio.h.no_interface', hard_blocked: 'radio.h.hard_blocked',
  soft_blocked: 'radio.h.soft_blocked', service_stopped: 'radio.h.service_stopped', service_missing: 'radio.h.service_missing', supplicant_missing: 'radio.h.supplicant_missing',
}

/** The diagnosis of one radio; reload() after a change (switch, fix) so the panel and this agree. */
export function useRadio(kind: RadioKind) {
  const [d, setD] = useState<(RadioDiagnosis & { text: string }) | null>(null)
  const reload = useCallback(async () => { const r = await os.radioDiagnose(kind).catch(() => null); setD(r?.ok ? r.value : null) }, [kind])
  useEffect(() => { void reload() }, [reload])
  return { d, reload }
}

/**
 * Problems of one radio with their fixes, and "Details" (adapters, drivers, services) that can be copied for support.
 * Renders nothing while everything works, unless `always` (then only the details link).
 */
export function RadioProblems({ kind, d, onFixed, always }: { kind: RadioKind; d: (RadioDiagnosis & { text: string }) | null; onFixed: () => void; always?: boolean }) {
  const [busy, setBusy] = useState<string | null>(null)
  const [err, setErr] = useState<string | null>(null)
  const [open, setOpen] = useState(false)
  const [copied, setCopied] = useState(false)
  if (!d || (!d.problems.length && !always)) return null
  const fix = async (p: RadioProblem) => {
    if (p.fix === 'find_driver') { requestSettingsSection('Drivers'); return }
    if (!p.fix) return
    setBusy(p.code); setErr(null)
    const r = await os.radioFix(kind, p.fix)
    setBusy(null)
    if (!r.ok) setErr(r.error === 'not_allowed' ? t('radio.fixNotAllowed') : t('radio.fixFailed'))
    onFixed()
  }
  const fixLabel = (p: RadioProblem) => (p.fix === 'unblock' ? t('radio.fix.unblock') : p.fix === 'restart_service' ? t('radio.fix.restart') : t('radio.fix.driver'))
  return (
    <section aria-label={t(kind === 'wifi' ? 'radio.wifiStatus' : 'radio.btStatus')} className="flex flex-col gap-2">
      {d.problems.length > 0 && (
        <ul className={`${card} m-0 list-none overflow-hidden border-[rgba(255,138,122,0.35)] p-0`}>
          {d.problems.map((p, i) => (
            <li key={`${p.code}-${i}`} role="alert" className={`flex items-center gap-3.5 px-[18px] py-[13px] ${rowLine}`}>
              <span className="flex flex-1 flex-col gap-0.5">
                <span className="text-sm font-medium">{t(TITLE[p.code], { device: p.device ?? '' })}</span>
                <span className="text-xs leading-[1.45] text-[#8FA3C8]">{t(HINT[p.code])}</span>
              </span>
              {p.fix && <button type="button" disabled={busy !== null} onClick={() => void fix(p)} className={`${btnGhost} px-3.5 py-2 text-[13px]`}>{busy === p.code ? t('radio.fixing') : fixLabel(p)}</button>}
            </li>
          ))}
        </ul>
      )}
      {err && <span role="alert" className="text-[13px] text-[#FF8A7A]">{err}</span>}
      <div className="flex items-center gap-4">
        <button type="button" aria-expanded={open} onClick={() => setOpen(!open)} className={linkBtn}>{open ? t('radio.hideDetails') : t('radio.details')}</button>
        {open && <button type="button" onClick={() => { void navigator.clipboard?.writeText(d.text).then(() => setCopied(true), () => {}) }} className={linkBtn}>{copied ? t('radio.copied') : t('radio.copy')}</button>}
      </div>
      {open && (
        <dl className={`${card} m-0 grid grid-cols-[max-content_1fr] gap-x-4 gap-y-1.5 px-[18px] py-3.5 text-[13px]`}>
          <dt className="text-[#8FA3C8]">{t('radio.service')}</dt><dd className="m-0">{t(`radio.svc.${d.service}` as MessageKey)}</dd>
          {d.adapters.map((a) => (
            <div key={a.name} className="contents">
              <dt className="text-[#8FA3C8]">{a.name}</dt>
              <dd className="m-0">{[a.device, t('radio.driver', { driver: a.driver ?? t('radio.none') }), a.hard_blocked ? t('radio.hardBlocked') : a.soft_blocked ? t('radio.softBlocked') : null].filter(Boolean).join(' · ')}</dd>
            </div>
          ))}
          {d.hardware.map((h) => (
            <div key={h.ids + h.name} className="contents">
              <dt className="text-[#8FA3C8]">{h.ids}</dt><dd className="m-0">{h.name} · {t('radio.driver', { driver: h.driver ?? t('radio.none') })}</dd>
            </div>
          ))}
          {!d.adapters.length && !d.hardware.length && <><dt className="text-[#8FA3C8]">{t('radio.adapters')}</dt><dd className="m-0">{t('radio.none')}</dd></>}
        </dl>
      )}
    </section>
  )
}

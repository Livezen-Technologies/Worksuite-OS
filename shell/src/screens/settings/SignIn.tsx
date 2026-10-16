// Settings › Users › Sign-in options (boards AuthMethods, AuthPin, AuthPasskey). The PIN and FIDO2 security keys
// belong to this device: worksuite-signin (services/session/signin) keeps an scrypt verifier for the PIN and the
// pam_u2f mappings for keys. Every change runs that helper through pkexec, so the person types their password; the PIN
// goes to it on stdin. The renderer never stores the PIN: it lives in component state until the dialog closes.
import { useEffect, useState } from 'react'
import { os, type Avail, type SignInMethod, type SignInMethods, type SigninResult } from '../../lib/os'
import { Dialog, Spinner, Svg, btnGhost, btnPrimary, card, chip, dialogFooter, field, rowLine } from '../../components/Dk'
import { formatDate, t, type MessageKey } from '../../i18n'

const ICON = {
  pin: 'M5 10h14v10H5zM8 10V7a4 4 0 0 1 8 0v3M12 14v2',
  key: 'M8 11a3 3 0 1 0 0-6 3 3 0 0 0 0 6zM10.5 9.5L20 19M16 15l2-2M18 17l2-2',
  password: 'M4 12h2M9 12h2M14 12h2M19 12h1',
}
export const METHOD_LABEL: Record<SignInMethod, MessageKey> = { password: 'greeter.password', pin: 'signin.pin', key: 'signin.key' }

/** Same rule as worksuite_signin.core.weak(): repeats and runs are refused. */
export function weakPin(p: string): boolean {
  return /^(\d)\1+$/.test(p) || '01234567890123456789'.includes(p) || '98765432109876543210'.includes(p)
}

export function errorText(code: string, m?: Pick<SignInMethods, 'pin_min_length' | 'pin_max_length'>): string {
  const known = ['too_short', 'too_long', 'too_simple', 'mismatch', 'digits_only', 'pin_disabled', 'auth_cancelled', 'key_timeout', 'key_exists', 'key_failed']
  const key = (known.includes(code) ? `signin.err.${code}` : 'signin.err.failed') as MessageKey
  return t(key, { min: m?.pin_min_length ?? 6, max: m?.pin_max_length ?? 12 })
}

const Status = ({ on, text }: { on: boolean; text: string }) => (
  <span className={`rounded-full px-2 py-0.5 text-[11px] font-medium ${on ? 'bg-[rgba(95,211,154,0.16)] text-[#5FD39A]' : 'bg-[rgba(127,178,255,0.12)] text-[#8FA3C8]'}`}>{text}</span>
)

function Row({ icon, on, name, desc, status, children }: { icon: string; on: boolean; name: string; desc: string; status: string; children?: React.ReactNode }) {
  return (
    <div className={`flex items-center gap-3 px-4 py-3 ${rowLine}`}>
      <span className={`flex h-9 w-9 shrink-0 items-center justify-center rounded-[10px] ${on ? 'bg-[rgba(31,107,255,0.2)]' : 'bg-[rgba(127,178,255,0.08)]'}`}><Svg d={icon} size={18} stroke={on ? '#7FB2FF' : '#8FA3C8'} /></span>
      <span className="flex min-w-0 flex-1 flex-col gap-0.5">
        <span className="flex items-center gap-2 text-[13px] font-medium">{name}<Status on={on} text={status} /></span>
        <span className="text-[11px] text-[#8FA3C8]">{desc}</span>
      </span>
      {children}
    </div>
  )
}

export function SignInOptions() {
  const [m, setM] = useState<Avail<SignInMethods> | null>(null)
  const [dialog, setDialog] = useState<null | 'pin' | 'pinRemove' | 'key'>(null)
  const [msg, setMsg] = useState<string | null>(null)
  const reload = () => os.signinMethods().then(setM, () => setM({ available: false, reason: 'service_unavailable' }))
  useEffect(() => { void reload() }, [])
  if (!m || !m.available) return null
  const v = m.value
  const after = (r: SigninResult) => { setMsg(r.ok ? null : errorText(r.error, v)); void reload() }
  const choices: SignInMethod[] = ['password', ...(v.pin ? ['pin' as const] : []), ...(v.keys.length ? ['key' as const] : [])]

  return (
    <section aria-labelledby="signin-options" className="flex flex-col gap-2">
      <h2 id="signin-options" className="m-0 text-sm font-semibold">{t('signin.title')}</h2>
      <p className="m-0 text-xs text-[#8FA3C8]">{t('signin.intro')}</p>
      <div className={`${card} overflow-hidden`}>
        <Row icon={ICON.pin} on={v.pin} name={t('signin.pin')} status={v.pin ? t('signin.isSetUp') : t('signin.off')}
          desc={v.allow_pin ? t('signin.pinDesc', { min: v.pin_min_length, max: v.pin_max_length }) : t('signin.pinOff')}>
          {v.pin && <button type="button" className={`${btnGhost} px-3 py-1.5 text-[13px]`} onClick={() => setDialog('pinRemove')}>{t('signin.remove')}</button>}
          {v.allow_pin && <button type="button" className={`${v.pin ? btnGhost : btnPrimary} px-3 py-1.5 text-[13px]`} onClick={() => setDialog('pin')}>{v.pin ? t('signin.change') : t('signin.setUp')}</button>}
        </Row>
        <Row icon={ICON.key} on={v.keys.length > 0} name={t('signin.key')} status={v.keys.length ? t('signin.keyCount', { n: v.keys.length }) : t('signin.off')} desc={t('signin.keyDesc')}>
          <button type="button" className={`${v.keys.length ? btnGhost : btnPrimary} px-3 py-1.5 text-[13px]`} onClick={() => setDialog('key')}>{v.keys.length ? t('signin.addKey') : t('signin.setUp')}</button>
        </Row>
        {v.keys.length > 0 && (
          <ul aria-label={t('signin.key')} className="m-0 list-none border-t border-[rgba(127,178,255,0.1)] bg-[rgba(4,10,26,0.25)] p-0 py-1 pl-[60px]">
            {v.keys.map((k) => (
              <li key={k.id} className="flex items-center gap-3 py-1.5 pr-4">
                <span className="flex flex-1 flex-col"><span className="text-[13px]">{k.name || t('signin.key')}</span>
                  {k.added != null && <span className="text-[11px] text-[#8FA3C8]">{t('signin.added', { date: formatDate(new Date(k.added), { day: 'numeric', month: 'short', year: 'numeric' }) })}</span>}</span>
                <button type="button" aria-label={t('signin.removeKey', { name: k.name || t('signin.key') })} className="cursor-pointer rounded text-[12px] text-[#FF8A7A] hover:text-[#FFB4A8]"
                  onClick={() => void os.signinKeyRemove(k.id).then(after)}>{t('signin.remove')}</button>
              </li>
            ))}
          </ul>
        )}
        <Row icon={ICON.password} on name={t('greeter.password')} status={t('signin.alwaysOn')} desc={t('signin.passwordDesc')} />
        <div className={`flex items-center gap-3 px-4 py-3 ${rowLine}`}>
          <span className="flex flex-1 flex-col gap-0.5"><span className="text-[13px] font-medium">{t('signin.default')}</span><span className="text-[11px] text-[#8FA3C8]">{t('signin.defaultHint')}</span></span>
          <div role="radiogroup" aria-label={t('signin.default')} className="flex rounded-[10px] bg-[rgba(4,10,26,0.6)] p-[3px]">
            {choices.map((c) => (
              <button key={c} type="button" role="radio" aria-checked={c === v.default}
                className={`cursor-pointer rounded-lg px-3 py-1.5 text-[12px] ${c === v.default ? 'bg-[#1F6BFF] text-white' : 'text-[#C9D6EE]'}`}
                onClick={() => void os.signinSetDefault(c).then(after)}>{t(METHOD_LABEL[c])}</button>
            ))}
          </div>
        </div>
      </div>
      {msg && <p role="alert" className="m-0 text-xs text-[#FFB4A8]">{msg}</p>}
      <div className="flex items-start gap-2 text-[11px] leading-[1.5] text-[#8FA3C8]">
        <Svg d="M12 3l8 3v6c0 5-3.5 8-8 9-4.5-1-8-4-8-9V6z" size={14} stroke="#5FD39A" />
        <span>{t('signin.note', { n: v.attempt_limit })} {t('signin.keyringNote')}</span>
      </div>
      {dialog === 'pin' && <PinDialog m={v} onClose={(r) => { setDialog(null); if (r) after(r) }} />}
      {dialog === 'key' && <KeyDialog onClose={(r) => { setDialog(null); if (r) after(r) }} m={v} />}
      {dialog === 'pinRemove' && (
        <Dialog width={420} onClose={() => setDialog(null)}>{(id) => <>
          <div className="flex flex-col gap-2 px-6 py-5"><h2 id={id} className="m-0 text-lg font-bold">{t('signin.pinRemoveTitle')}</h2><p className="m-0 text-[13px] text-[#C9D6EE]">{t('signin.pinRemoveBody')}</p></div>
          <div className={dialogFooter}>
            <button type="button" className={btnGhost} onClick={() => setDialog(null)}>{t('common.cancel')}</button>
            <button type="button" className={`${btnPrimary} !bg-[#D9452B]`} onClick={() => { setDialog(null); void os.signinPinRemove().then(after) }}>{t('signin.remove')}</button>
          </div>
        </>}</Dialog>
      )}
    </section>
  )
}

/** Board AuthPin: create, then confirm, with a keypad and the keyboard. */
export function PinDialog({ m, onClose }: { m: SignInMethods; onClose: (r?: SigninResult) => void }) {
  const [stage, setStage] = useState<0 | 1>(0)
  const [first, setFirst] = useState('')
  const [cur, setCur] = useState('')
  const [err, setErr] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const typed = (v: string) => { setCur(v.replace(/\D/g, '').slice(0, m.pin_max_length)); setErr(null) }
  const next = async () => {
    if (busy) return
    if (stage === 0) {
      if (cur.length < m.pin_min_length) return setErr(errorText('too_short', m))
      if (weakPin(cur)) { setCur(''); return setErr(errorText('too_simple', m)) }
      setFirst(cur); setCur(''); setStage(1); return
    }
    if (cur !== first) { setCur(''); setFirst(''); setStage(0); return setErr(errorText('mismatch', m)) }
    setBusy(true)
    const r = await os.signinPinSet(cur)
    setBusy(false)
    if (r.ok) { setCur(''); setFirst(''); onClose(r) } else { setCur(''); setErr(errorText(r.error, m)); if (r.error !== 'auth_cancelled') { setFirst(''); setStage(0) } }
  }
  const keys = ['1', '2', '3', '4', '5', '6', '7', '8', '9', '', '0', '⌫']
  const dots = Math.max(m.pin_min_length, cur.length)
  return (
    <Dialog width={460} onClose={() => onClose()}>{(id) => <>
      <form className="flex flex-col items-center gap-4 px-8 pt-7 pb-5 text-center" onSubmit={(e) => { e.preventDefault(); void next() }}>
        <span className="flex h-12 w-12 items-center justify-center rounded-[14px] bg-[rgba(31,107,255,0.2)]"><Svg d={ICON.pin} size={24} stroke="#7FB2FF" /></span>
        <div className="flex flex-col gap-1">
          <span className="font-mono text-[11px] tracking-[0.08em] text-[#18D4F0] uppercase">{stage === 0 ? t('signin.pinStep1') : t('signin.pinStep2')}</span>
          <h2 id={id} className="m-0 text-[22px] font-bold">{stage === 0 ? t('signin.pinCreate') : t('signin.pinConfirm')}</h2>
          <p className="m-0 text-[13px] text-[#8FA3C8]">{stage === 0 ? t('signin.pinCreateSub', { min: m.pin_min_length }) : t('signin.pinConfirmSub')}</p>
        </div>
        <label className="sr-only" htmlFor="ws-pin-entry">{t('signin.pinField')}</label>
        <input id="ws-pin-entry" data-autofocus type="password" inputMode="numeric" autoComplete="off" value={cur} onChange={(e) => typed(e.target.value)}
          aria-invalid={!!err || undefined} aria-describedby="ws-pin-msg" className="sr-only" />
        <div aria-hidden="true" className="flex h-4 items-center gap-3" onClick={() => document.getElementById('ws-pin-entry')?.focus()}>
          {Array.from({ length: dots }, (_, i) => <span key={i} className={`h-3.5 w-3.5 rounded-full border-2 ${i < cur.length ? 'border-[#1F6BFF] bg-[#1F6BFF]' : err ? 'border-[#FF8A7A]' : 'border-[rgba(127,178,255,0.35)]'}`} />)}
        </div>
        <div id="ws-pin-msg" role={err ? 'alert' : undefined} className={`min-h-[18px] text-[13px] ${err ? 'text-[#FF8A7A]' : 'text-[#8FA3C8]'}`}>{err ?? (stage === 1 ? t('signin.pinAuth') : '')}</div>
        <div className="grid grid-cols-[repeat(3,64px)] gap-2.5">
          {keys.map((k, i) => k ? (
            <button key={i} type="button" aria-label={k === '⌫' ? t('signin.delete') : k} disabled={busy}
              className={`flex h-12 cursor-pointer items-center justify-center rounded-[12px] text-xl font-medium ${k === '⌫' ? '' : 'bg-[rgba(127,178,255,0.1)] hover:bg-[rgba(127,178,255,0.18)]'}`}
              onClick={() => { typed(k === '⌫' ? cur.slice(0, -1) : cur + k); document.getElementById('ws-pin-entry')?.focus() }}>{k}</button>
          ) : <span key={i} />)}
        </div>
        <button type="submit" hidden />
      </form>
      <div className={dialogFooter}>
        <button type="button" className={btnGhost} onClick={() => onClose()}>{t('common.cancel')}</button>
        <button type="button" className={btnPrimary} disabled={busy || cur.length < m.pin_min_length} onClick={() => void next()}>
          {busy && <Spinner />}{stage === 0 ? t('signin.pinNext') : t('signin.pinSave')}
        </button>
      </div>
    </>}</Dialog>
  )
}

/** Board AuthPasskey, security-key path: name it, touch it (pamu2fcfg in the helper), done. */
export function KeyDialog({ m, onClose }: { m: SignInMethods; onClose: (r?: SigninResult) => void }) {
  const [step, setStep] = useState<0 | 1 | 2>(0)
  const [name, setName] = useState(t('signin.keyNameDefault'))
  const [err, setErr] = useState<string | null>(null)
  const [result, setResult] = useState<SigninResult | undefined>()
  const go = async () => {
    setStep(1); setErr(null)
    const r = await os.signinKeyAdd(name)
    if (r.ok) { setResult(r); setStep(2) } else { setErr(errorText(r.error, m)); setStep(0) }
  }
  return (
    <Dialog width={520} onClose={step === 1 ? undefined : () => onClose(result)}>{(id) => <>
      <div className="flex flex-col gap-4 px-7 pt-6 pb-5">
        <div className="flex items-center gap-3">
          <span className="flex h-11 w-11 items-center justify-center rounded-[12px] bg-[rgba(31,107,255,0.2)]"><Svg d={ICON.key} size={22} stroke="#7FB2FF" /></span>
          <h2 id={id} className="m-0 text-xl font-bold">{step === 2 ? t('signin.keyDone') : step === 1 ? t('signin.keyTouch') : t('signin.keyTitle')}</h2>
        </div>
        <div className="flex gap-1.5" aria-hidden="true">{[0, 1, 2].map((i) => <span key={i} className={`h-1 flex-1 rounded ${i <= step ? 'bg-[#1F6BFF]' : 'bg-[rgba(127,178,255,0.15)]'}`} />)}</div>
        {step === 0 && <>
          <label className="flex flex-col gap-1.5 text-[13px] text-[#C9D6EE]">{t('signin.keyName')}
            <input data-autofocus className={field} value={name} maxLength={60} onChange={(e) => setName(e.target.value)} /></label>
          <p className="m-0 text-[13px] text-[#8FA3C8]">{t('signin.keyInsert')}</p>
        </>}
        {step === 1 && (
          <div className="flex items-center gap-5 py-2" role="status">
            <span className="relative flex h-20 w-20 items-center justify-center rounded-full bg-[rgba(24,212,240,0.14)]">
              <span className="absolute inset-0 animate-ping rounded-full border-2 border-[#18D4F0] opacity-60" />
              <Svg d="M9 3h6v8H9zM7 11h10v10H7zM12 15v2" size={34} stroke="#18D4F0" />
            </span>
            <span className="flex flex-col gap-1"><span className="text-[15px] font-semibold">{t('signin.keyTouch')}</span><span className="font-mono text-xs text-[#8FA3C8]">{t('signin.keyWaiting')}</span></span>
          </div>
        )}
        {step === 2 && <div className="flex items-center gap-3 rounded-[12px] border border-[rgba(95,211,154,0.4)] bg-[rgba(95,211,154,0.1)] px-4 py-3 text-sm"><Svg d="M5 12.5l4.5 4.5L19 7.5" size={20} stroke="#5FD39A" /><strong>{name}</strong><span className={chip}>{t('signin.saved')}</span></div>}
        {err && <p role="alert" className="m-0 text-[13px] text-[#FF8A7A]">{err}</p>}
      </div>
      <div className={dialogFooter}>
        {step !== 2 && <button type="button" className={btnGhost} disabled={step === 1} onClick={() => onClose()}>{t('common.cancel')}</button>}
        {step === 0 && <button type="button" className={btnPrimary} onClick={() => void go()}>{t('signin.continue')}</button>}
        {step === 2 && <button type="button" className={btnPrimary} onClick={() => onClose(result)}>{t('signin.done')}</button>}
      </div>
    </>}</Dialog>
  )
}

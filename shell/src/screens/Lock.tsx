import { useEffect, useRef, useState, type FormEvent } from 'react'
import type { LockProps } from './types'
import { os, type SignInMethod } from '../lib/os'
import { METHOD_LABEL } from './settings/SignIn'
import { ageLabel } from '../lib/power'
import { useANow, aTime } from '../components/AClock'
import { Avatar, BG, Icon, P, glassBtn } from '../components/Ws'
import { formatDate, t } from '../i18n'

// Lock board: date, big clock, notification previews (content hidden), "Press any key or click to unlock".
// Any key or click reveals the password field. AuthLockPin board: people who set up a PIN or a security key in
// Settings › Users get a Password / PIN / Security key switcher; the password always works.
export default function Lock({ user, onUnlock, notices = [] }: LockProps) {
  const now = useANow()
  const [asking, setAsking] = useState(false)
  const [password, setPassword] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const ref = useRef<HTMLInputElement>(null)
  const [methods, setMethods] = useState<SignInMethod[]>(['password'])
  const [method, setMethod] = useState<SignInMethod>('password')
  useEffect(() => {
    let live = true
    void os.signinMethods().then((r) => {
      if (!live || !r.available) return
      setMethods(['password', ...(r.value.pin && r.value.allow_pin ? ['pin' as const] : []), ...(r.value.keys.length ? ['key' as const] : [])])
      if (r.value.default !== 'pin' || r.value.allow_pin) setMethod(r.value.default)
    }, () => {})
    return () => { live = false }
  }, [])
  const pick = (m: SignInMethod) => { setMethod(m); setPassword(''); setError(null); if (m !== 'key') setTimeout(() => ref.current?.focus(), 0) }
  const display = user ? user.replace(/^.*\\/, '').replace(/@.*$/, '') : t('lock.user')
  const name = display.charAt(0).toUpperCase() + display.slice(1)
  const day = formatDate(now, { weekday: 'long', day: 'numeric', month: 'long' }).replace(',', '')

  useEffect(() => {
    if (asking) { ref.current?.focus(); return }
    const onKey = (e: KeyboardEvent) => {
      if (['Shift', 'Control', 'Alt', 'Meta', 'Tab'].includes(e.key)) return
      e.preventDefault(); setAsking(true)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [asking])

  useEffect(() => {
    if (!asking) return
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') { setAsking(false); setPassword(''); setError(null) } }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [asking])

  const submit = async (e: FormEvent) => {
    e.preventDefault()
    if (busy) return
    if (method !== 'key' && !password) { setError(t('greeter.enterPassword')); ref.current?.focus(); return }
    setBusy(true); setError(null)
    try {
      const res = await os.authenticate(user, method === 'key' ? '' : password, method)
      if (res.ok) onUnlock()
      else { setError(t(method === 'pin' ? 'signin.wrongPin' : method === 'key' ? 'signin.keyFailed' : 'greeter.wrongPassword')); setPassword(''); ref.current?.focus() }
    } catch {
      setError(t('lock.verifyFailed'))
    } finally { setBusy(false) }
  }

  return (
    <div className="relative h-full w-full overflow-hidden font-sans text-white" style={{ background: BG.lock }}
      onMouseDown={(e) => { if (!asking && e.button === 0) { e.preventDefault(); setAsking(true) } }}>
      <svg aria-hidden="true" className="pointer-events-none absolute inset-0 h-full w-full opacity-[0.18]" viewBox="0 0 1280 800" preserveAspectRatio="xMidYMid slice">
        <rect x="880" y="120" width="160" height="160" rx="10" fill="#1F6BFF" />
        <rect x="800" y="200" width="80" height="80" rx="8" fill="#18D4F0" />
        <rect x="880" y="280" width="80" height="80" rx="8" fill="#18D4F0" />
      </svg>

      <header className="absolute top-7 right-10 left-10 flex items-center justify-between text-sm text-white/85">
        <span className="flex items-center gap-2"><Icon d={['M8 11V7a4 4 0 0 1 8 0v4']} size={18}><rect x="5" y="11" width="14" height="10" rx="2" /></Icon>{t('lock.locked')}</span>
        <span className="flex items-center gap-[18px]" aria-hidden="true">
          <Icon d={P.wifi} size={18} />
          <svg width="22" height="18" viewBox="0 0 26 14" fill="none" stroke="#FFFFFF" strokeWidth="1.6"><rect x="1" y="1" width="21" height="12" rx="3" /><rect x="3" y="3" width="13" height="8" rx="1.5" fill="#FFFFFF" stroke="none" /><path d="M24 5v4" /></svg>
        </span>
      </header>

      <div className={`absolute right-0 left-0 flex flex-col items-center gap-1.5 transition-[top] duration-200 ${asking ? 'top-[90px]' : 'top-[150px]'}`}>
        <div className="text-[22px] text-white/85">{day}</div>
        <time dateTime={now.toISOString()} className={`leading-none font-light tracking-[-0.04em] ${asking ? 'text-[120px]' : 'text-[168px]'}`}>{aTime(now)}</time>
      </div>

      {!asking && notices.length > 0 && (
        <section aria-label={t('lock.notices')} className="absolute top-[420px] left-1/2 flex w-[420px] max-w-[calc(100%-32px)] -translate-x-1/2 flex-col gap-2.5">
          {notices.slice(0, 3).map((n) => (
            <div key={n.id} className="flex items-center gap-3.5 rounded-[14px] border border-white/[0.12] bg-[rgba(8,20,48,0.55)] px-4 py-3.5 backdrop-blur-[16px]">
              <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-[9px] font-bold" style={{ background: n.tone === 'ok' ? '#2E9E6A' : n.tone === 'warn' ? '#B7791F' : '#D9452B' }}><Icon d={n.tone === 'ok' ? P.check : P.alert} size={18} /></span>
              <span className="flex flex-1 flex-col gap-0.5">
                <span className="text-sm font-semibold">{n.app ?? n.title}</span>
                <span className="text-[13px] text-white/70">{t('lock.unlockToRead')}</span>
              </span>
              <span className="text-xs text-white/60">{ageLabel(n.at, now.getTime())}</span>
            </div>
          ))}
        </section>
      )}

      {asking ? (
        <form aria-label={t('lock.unlock')} onSubmit={submit} noValidate className="absolute top-[330px] right-0 left-0 flex flex-col items-center gap-3 px-4">
          <Avatar name={name} size={88} font={32} style={{ boxShadow: '0 0 0 4px rgba(255,255,255,0.14), 0 20px 50px rgba(0,0,0,0.45)' }} />
          <div className="text-[22px] font-semibold">{name}</div>
          {method === 'key' ? (
            <div className="mt-1 flex flex-col items-center gap-2.5">
              <span className="relative flex h-14 w-14 items-center justify-center"><span className="absolute inset-0 animate-ping rounded-full border-2 border-[#18D4F0] opacity-50" />
                <Icon d={['M8 11a3 3 0 1 0 0-6 3 3 0 0 0 0 6zM10.5 9.5L20 19M16 15l2-2M18 17l2-2']} size={26} stroke="#18D4F0" /></span>
              <button type="submit" disabled={busy} className="cursor-pointer rounded-xl bg-[#1F6BFF] px-6 py-2.5 text-sm font-semibold hover:bg-[#3A7DFF] disabled:opacity-70">{t('lock.unlock')}</button>
            </div>
          ) : (
          <div className={`mt-1 flex h-12 w-[340px] max-w-full items-center rounded-xl border bg-[rgba(8,20,48,0.6)] pr-1.5 pl-4 backdrop-blur-[16px] ${error ? 'border-[#FF8A7A]' : 'border-white/[0.18] focus-within:border-[#7FB2FF]'}`}>
            <label htmlFor="ws-lock-pw" className="sr-only">{t(METHOD_LABEL[method])}</label>
            <input id="ws-lock-pw" ref={ref} type="password" placeholder={t(METHOD_LABEL[method])} autoComplete={method === 'pin' ? 'off' : 'current-password'}
              inputMode={method === 'pin' ? 'numeric' : undefined} maxLength={method === 'pin' ? 12 : undefined}
              value={password} onChange={(e) => { setPassword(method === 'pin' ? e.target.value.replace(/\D/g, '') : e.target.value); setError(null) }}
              aria-invalid={!!error || undefined} aria-describedby="ws-lock-hint"
              className="min-w-0 flex-1 border-0 bg-transparent text-[15px] text-white outline-none placeholder:text-white/50" />
            <button type="submit" aria-label={t('lock.unlock')} disabled={busy}
              className="flex h-9 w-9 cursor-pointer items-center justify-center rounded-[9px] bg-[#1F6BFF] hover:bg-[#3A7DFF] disabled:opacity-70">
              <Icon d={P.arrow} size={18} width={2.5} />
            </button>
          </div>
          )}
          <span id="ws-lock-hint" role={error ? 'alert' : undefined} className={`max-w-[420px] text-center text-[13px] ${error ? 'text-[#FFB4A8]' : 'text-white/60'}`}>{error ?? (method === 'key' ? t('signin.lockKeyWait') : t('lock.hint'))}</span>
          {methods.length > 1 && (
            <div className="mt-2 flex flex-col items-center gap-2">
              <span className="text-xs text-white/60">{t('signin.title')}</span>
              <div role="radiogroup" aria-label={t('signin.method')} className="flex gap-2">
                {methods.map((m) => (
                  <button key={m} type="button" role="radio" aria-checked={m === method} onClick={() => pick(m)}
                    className={`cursor-pointer rounded-xl border px-3.5 py-2 text-[13px] backdrop-blur-[16px] ${m === method ? 'border-[#1F6BFF] bg-[rgba(31,107,255,0.35)]' : 'border-white/[0.18] bg-[rgba(8,20,48,0.6)] hover:bg-[rgba(8,20,48,0.8)]'}`}>{t(METHOD_LABEL[m])}</button>
                ))}
              </div>
            </div>
          )}
        </form>
      ) : (
        <button type="button" onClick={() => setAsking(true)} className="absolute bottom-11 left-1/2 flex -translate-x-1/2 cursor-pointer flex-col items-center gap-2.5 rounded-lg px-3 py-1 text-sm text-white/80">
          <Icon d={P.chevronUp} size={22} stroke="rgba(255,255,255,0.8)" />
          {t('lock.pressAny')}
        </button>
      )}

      {asking && (
        <div className="absolute right-10 bottom-8 flex gap-2.5">
          <button type="button" className={`${glassBtn} !w-auto px-4 text-sm`} onClick={() => void os.logout()}>{t('lock.switchUser')}</button>
          <button type="button" aria-label={t('a11y.button')} className={glassBtn}><Icon d={P.a11y}><circle cx="12" cy="4.5" r="1.5" /></Icon></button>
        </div>
      )}
    </div>
  )
}

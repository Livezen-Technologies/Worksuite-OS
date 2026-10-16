import { useEffect, useRef, useState, type FormEvent } from 'react'
import type { GreeterProps } from './types'
import { os } from '../lib/os'
import { useANow, aShortDate, aTime } from '../components/AClock'
import { validateAccountName } from '../components/AAccount'
import { AVATAR_GRADIENTS, Avatar, BG, Icon, P, glassBtn } from '../components/Ws'
import { PowerMenu, ShutdownConfirm } from '../components/Power'
import A11yPanel from '../components/A11yPanel'
import { LOCALES, useT, getLocale } from '../i18n'
import { motionReduced } from '../lib/a11y'

// Login and LoginUsers boards. No automatic sign-in: the person always submits a password.
interface AUser { id: string; name: string; role: string }
// Real accounts from /etc/passwd (os.sysUsers); the session user is preselected. No placeholder names.
const OTHER = '__other__'

const SHAKE: Keyframe[] = [{ transform: 'translateX(0)' }, { transform: 'translateX(-8px)' }, { transform: 'translateX(8px)' }, { transform: 'translateX(-8px)' }, { transform: 'translateX(8px)' }, { transform: 'translateX(0)' }]

export default function Greeter({ onSignIn }: GreeterProps) {
  const t = useT()
  const now = useANow()
  const [a11y, setA11y] = useState(false)
  const [view, setView] = useState<'password' | 'users'>('password')
  const [USERS, setUsers] = useState<AUser[]>([])
  const [selected, setSelected] = useState<string>(OTHER)
  useEffect(() => {
    let live = true
    os.sysUsers().then((r) => {
      if (!live || !r.available) return
      const list = r.value.users.map((u) => ({ id: u.login, name: u.name || u.login, role: t(u.admin ? 'settings.users.admin' : 'settings.users.standard') }))
      setUsers(list)
      const cur = list.find((u) => u.id === r.value.current) ?? list[0]
      if (cur) setSelected((s) => (s === OTHER && !otherRef.current?.value ? cur.id : s))
    }).catch(() => { /* fall back to "Other user" */ })
    return () => { live = false }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])
  const [otherName, setOtherName] = useState('')
  const [password, setPassword] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [wrong, setWrong] = useState(false)
  const [power, setPower] = useState(false)
  const [confirm, setConfirm] = useState(false)
  const pwRef = useRef<HTMLInputElement>(null)
  const otherRef = useRef<HTMLInputElement>(null)
  const formRef = useRef<HTMLFormElement>(null)

  const isOther = selected === OTHER
  const user = USERS.find((u) => u.id === selected)
  const userIndex = USERS.findIndex((u) => u.id === selected)

  const pick = (id: string) => {
    setSelected(id); setPassword(''); setError(null); setWrong(false); setView('password')
    requestAnimationFrame(() => (id === OTHER ? otherRef.current : pwRef.current)?.focus())
  }

  const shake = () => {
    const reduce = motionReduced()
    if (!reduce) formRef.current?.animate?.(SHAKE, { duration: 400, easing: 'ease' })
  }

  const submit = async (e: FormEvent) => {
    e.preventDefault()
    if (busy) return
    const account = isOther ? otherName.trim() : selected
    if (isOther) {
      const err = validateAccountName(account)
      if (err) { setError(err); setWrong(false); otherRef.current?.focus(); return }
    }
    if (!password) { setError(t('greeter.enterPassword')); setWrong(false); pwRef.current?.focus(); return }
    setBusy(true); setError(null)
    try {
      const res = await os.authenticate(account, password)
      if (res.ok) onSignIn(account)
      else { setWrong(true); setError(t('greeter.wrongPassword')); setPassword(''); shake(); pwRef.current?.focus() }
    } catch {
      setWrong(false); setError(t('greeter.unavailable'))
    } finally {
      setBusy(false)
    }
  }

  const bottomRight = (
    <div className="absolute right-10 bottom-8 flex gap-2.5">
      {view === 'password' && <button type="button" aria-label={t('greeter.network')} className={glassBtn}><Icon d={P.wifi} /></button>}
      <button type="button" aria-label={t('a11y.button')} aria-haspopup="dialog" aria-expanded={a11y} onClick={() => { setA11y((v) => !v); setPower(false) }} className={glassBtn}><Icon d={P.a11y}><circle cx="12" cy="4.5" r="1.5" /></Icon></button>
      <button type="button" aria-label={t('greeter.powerOptions')} aria-haspopup="menu" aria-expanded={power} data-power-toggle onClick={() => setPower((v) => !v)} className={glassBtn}><Icon d={P.power} /></button>
      {a11y && <A11yPanel className="right-0 bottom-14" onClose={() => setA11y(false)} />}
      {power && <PowerMenu onClose={() => setPower(false)} onShutdown={() => setConfirm(true)} className="right-0 bottom-14" />}
    </div>
  )

  return (
    <div className="relative h-full w-full overflow-hidden font-sans text-white" style={{ background: BG.greeter }}>
      <header className="absolute top-7 right-10 left-10 flex justify-between text-sm text-white/85">
        <time dateTime={now.toISOString()}>{aShortDate(now)} · {aTime(now)}</time>
        <span>{LOCALES.find((l) => l.id === getLocale())?.name}</span>
      </header>

      {view === 'users' ? (
        <main className="flex h-full flex-col items-center justify-center gap-10 px-4">
          <h1 className="m-0 text-[30px] font-semibold">{t('greeter.whoSignsIn')}</h1>
          <ul aria-label={t('greeter.usersHere')} className="m-0 flex list-none flex-wrap justify-center gap-7 p-0">
            {[...USERS.map((u, i) => ({ id: u.id, name: u.name, note: u.role, bg: AVATAR_GRADIENTS[i % AVATAR_GRADIENTS.length], mark: undefined as string | undefined })),
              { id: OTHER, name: t('greeter.otherUser'), note: t('greeter.enterUsername'), bg: 'rgba(255,255,255,0.08)', mark: '+' }].map((u) => {
              const on = u.id === selected
              return (
                <li key={u.id}>
                  <button type="button" aria-current={on ? 'true' : undefined} onClick={() => pick(u.id)}
                    className="flex w-[168px] cursor-pointer flex-col items-center gap-3.5 rounded-[18px] border px-3 pt-6 pb-5 text-white hover:bg-[rgba(31,107,255,0.14)]"
                    style={{ background: on ? 'rgba(31,107,255,0.2)' : 'rgba(8,20,48,0.45)', borderColor: on ? 'rgba(127,178,255,0.6)' : 'rgba(255,255,255,0.1)' }}>
                    <Avatar name={u.name} size={96} font={34} bg={u.bg}>{u.mark}</Avatar>
                    <span className="text-base font-semibold">{u.name}</span>
                    <span className="text-xs text-white/65">{u.note}</span>
                  </button>
                </li>
              )
            })}
          </ul>
        </main>
      ) : (
        <main className="absolute top-[200px] right-0 left-0 flex flex-col items-center gap-3.5 px-4">
          <Avatar name={isOther ? '' : user!.name} size={128} font={46} bg={isOther ? 'rgba(255,255,255,0.08)' : AVATAR_GRADIENTS[userIndex % AVATAR_GRADIENTS.length]}
            style={{ boxShadow: '0 0 0 4px rgba(255,255,255,0.14), 0 20px 50px rgba(0,0,0,0.45)' }}>{isOther ? '+' : undefined}</Avatar>
          <h1 className="m-0 mt-1.5 text-[26px] font-semibold">{isOther ? t('greeter.otherUser') : user!.name}</h1>
          <form ref={formRef} aria-label={t('greeter.signIn')} onSubmit={submit} noValidate className="mt-2.5 flex flex-col items-center gap-2.5">
            {isOther && (
              <div className="flex h-12 w-[340px] max-w-full items-center rounded-xl border border-white/[0.18] bg-[rgba(8,20,48,0.6)] px-4 backdrop-blur-[16px] focus-within:border-[#7FB2FF]">
                <label htmlFor="ws-user" className="sr-only">{t('greeter.userName')}</label>
                <input id="ws-user" ref={otherRef} type="text" autoComplete="username" autoCapitalize="none" spellCheck={false} placeholder={t('greeter.userName')}
                  value={otherName} onChange={(e) => { setOtherName(e.target.value); setError(null) }}
                  className="min-w-0 flex-1 border-0 bg-transparent text-[15px] text-white outline-none placeholder:text-white/50" />
              </div>
            )}
            <div className={`flex h-12 w-[340px] max-w-full items-center rounded-xl border bg-[rgba(8,20,48,0.6)] pr-1.5 pl-4 backdrop-blur-[16px] ${wrong ? 'border-[#FF8A7A]' : 'border-white/[0.18] focus-within:border-[#7FB2FF]'}`}>
              <label htmlFor="ws-pw" className="sr-only">{t('greeter.password')}</label>
              <input id="ws-pw" ref={pwRef} type="password" placeholder={t('greeter.password')} autoComplete="current-password" autoFocus={!isOther}
                value={password} onChange={(e) => { setPassword(e.target.value); setError(null) }}
                aria-invalid={wrong || undefined} aria-describedby="ws-pw-hint"
                className="min-w-0 flex-1 border-0 bg-transparent text-[15px] text-white outline-none placeholder:text-white/50" />
              <button type="submit" aria-label={t('greeter.signIn')} disabled={busy}
                className="flex h-9 w-9 cursor-pointer items-center justify-center rounded-[9px] bg-[#1F6BFF] hover:bg-[#3A7DFF] disabled:opacity-70">
                <Icon d={P.arrow} size={18} width={2.5} />
              </button>
            </div>
            <span id="ws-pw-hint" role={error ? 'alert' : undefined} className={`text-[13px] ${error ? 'text-[#FFB4A8]' : 'text-white/60'}`}>
              {error ?? (busy ? t('greeter.signingIn') : t('greeter.pressEnter'))}
            </span>
          </form>
          <button type="button" className="cursor-pointer rounded-md p-1.5 text-[13px] text-[#7FB2FF] hover:text-[#B8D4FF]">{t('greeter.forgot')}</button>
        </main>
      )}

      {view === 'password' && (
        <div className="absolute bottom-8 left-10 flex gap-2.5">
          <button type="button" onClick={() => { setView('users'); setError(null); setWrong(false) }}
            className="flex cursor-pointer items-center gap-2.5 rounded-xl border border-white/10 bg-[rgba(8,20,48,0.5)] py-2 pr-3.5 pl-2 text-sm text-white hover:bg-[rgba(8,20,48,0.75)]">
            <span className="flex h-[30px] w-[30px] items-center justify-center rounded-full bg-white/15"><Icon d={P.users} size={16}><circle cx="9" cy="8" r="3.5" /></Icon></span>
            {t('greeter.otherUser')}
          </button>
        </div>
      )}
      {bottomRight}
      {confirm && <ShutdownConfirm onCancel={() => setConfirm(false)} />}
    </div>
  )
}

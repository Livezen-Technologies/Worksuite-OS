import { useRef, useState, type FormEvent } from 'react'
import type { GreeterProps } from './types'
import { os } from '../lib/os'
import { useANow, aShortDate, aTime } from '../components/AClock'
import { validateAccountName } from '../components/AAccount'
import { AVATAR_GRADIENTS, Avatar, BG, Icon, P, glassBtn } from '../components/Ws'
import { PowerMenu, ShutdownConfirm } from '../components/Power'

// Login and LoginUsers boards. No automatic sign-in: the person always submits a password.
interface AUser { id: string; name: string; role: string }
const USERS: AUser[] = [
  { id: 'hasarinda', name: 'Hasarinda', role: 'Administrator' },
  { id: 'nimali', name: 'Nimali', role: 'Standard user' },
]
const OTHER = '__other__'

const SHAKE: Keyframe[] = [{ transform: 'translateX(0)' }, { transform: 'translateX(-8px)' }, { transform: 'translateX(8px)' }, { transform: 'translateX(-8px)' }, { transform: 'translateX(8px)' }, { transform: 'translateX(0)' }]

export default function Greeter({ onSignIn }: GreeterProps) {
  const now = useANow()
  const [view, setView] = useState<'password' | 'users'>('password')
  const [selected, setSelected] = useState<string>(USERS[0].id)
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
    const reduce = typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches
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
    if (!password) { setError('Enter your password.'); setWrong(false); pwRef.current?.focus(); return }
    setBusy(true); setError(null)
    try {
      const res = await os.authenticate(account, password)
      if (res.ok) onSignIn(account)
      else { setWrong(true); setError('Incorrect password. Try again.'); setPassword(''); shake(); pwRef.current?.focus() }
    } catch {
      setWrong(false); setError('Sign-in service is unavailable. Try again.')
    } finally {
      setBusy(false)
    }
  }

  const bottomRight = (
    <div className="absolute right-10 bottom-8 flex gap-2.5">
      {view === 'password' && <button type="button" aria-label="Network" className={glassBtn}><Icon d={P.wifi} /></button>}
      <button type="button" aria-label="Accessibility" className={glassBtn}><Icon d={P.a11y}><circle cx="12" cy="4.5" r="1.5" /></Icon></button>
      <button type="button" aria-label="Power options" aria-haspopup="menu" aria-expanded={power} data-power-toggle onClick={() => setPower((v) => !v)} className={glassBtn}><Icon d={P.power} /></button>
      {power && <PowerMenu onClose={() => setPower(false)} onShutdown={() => setConfirm(true)} className="right-0 bottom-14" />}
    </div>
  )

  return (
    <div className="relative h-full w-full overflow-hidden font-sans text-white" style={{ background: BG.greeter }}>
      <header className="absolute top-7 right-10 left-10 flex justify-between text-sm text-white/85">
        <time dateTime={now.toISOString()}>{aShortDate(now)} · {aTime(now)}</time>
        <span>English (US)</span>
      </header>

      {view === 'users' ? (
        <main className="flex h-full flex-col items-center justify-center gap-10 px-4">
          <h1 className="m-0 text-[30px] font-semibold">Who's signing in?</h1>
          <ul aria-label="Users on this computer" className="m-0 flex list-none flex-wrap justify-center gap-7 p-0">
            {[...USERS.map((u, i) => ({ id: u.id, name: u.name, note: u.role, bg: AVATAR_GRADIENTS[i % AVATAR_GRADIENTS.length], mark: undefined as string | undefined })),
              { id: OTHER, name: 'Other user', note: 'Enter username', bg: 'rgba(255,255,255,0.08)', mark: '+' }].map((u) => {
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
          <h1 className="m-0 mt-1.5 text-[26px] font-semibold">{isOther ? 'Other user' : user!.name}</h1>
          <form ref={formRef} aria-label="Sign in" onSubmit={submit} noValidate className="mt-2.5 flex flex-col items-center gap-2.5">
            {isOther && (
              <div className="flex h-12 w-[340px] max-w-full items-center rounded-xl border border-white/[0.18] bg-[rgba(8,20,48,0.6)] px-4 backdrop-blur-[16px] focus-within:border-[#7FB2FF]">
                <label htmlFor="ws-user" className="sr-only">User name</label>
                <input id="ws-user" ref={otherRef} type="text" autoComplete="username" autoCapitalize="none" spellCheck={false} placeholder="User name"
                  value={otherName} onChange={(e) => { setOtherName(e.target.value); setError(null) }}
                  className="min-w-0 flex-1 border-0 bg-transparent text-[15px] text-white outline-none placeholder:text-white/50" />
              </div>
            )}
            <div className={`flex h-12 w-[340px] max-w-full items-center rounded-xl border bg-[rgba(8,20,48,0.6)] pr-1.5 pl-4 backdrop-blur-[16px] ${wrong ? 'border-[#FF8A7A]' : 'border-white/[0.18] focus-within:border-[#7FB2FF]'}`}>
              <label htmlFor="ws-pw" className="sr-only">Password</label>
              <input id="ws-pw" ref={pwRef} type="password" placeholder="Password" autoComplete="current-password" autoFocus={!isOther}
                value={password} onChange={(e) => { setPassword(e.target.value); setError(null) }}
                aria-invalid={wrong || undefined} aria-describedby="ws-pw-hint"
                className="min-w-0 flex-1 border-0 bg-transparent text-[15px] text-white outline-none placeholder:text-white/50" />
              <button type="submit" aria-label="Sign in" disabled={busy}
                className="flex h-9 w-9 cursor-pointer items-center justify-center rounded-[9px] bg-[#1F6BFF] hover:bg-[#3A7DFF] disabled:opacity-70">
                <Icon d={P.arrow} size={18} width={2.5} />
              </button>
            </div>
            <span id="ws-pw-hint" role={error ? 'alert' : undefined} className={`text-[13px] ${error ? 'text-[#FFB4A8]' : 'text-white/60'}`}>
              {error ?? (busy ? 'Signing in…' : 'Press Enter to sign in')}
            </span>
          </form>
          <button type="button" className="cursor-pointer rounded-md p-1.5 text-[13px] text-[#7FB2FF] hover:text-[#B8D4FF]">Forgot password?</button>
        </main>
      )}

      {view === 'password' && (
        <div className="absolute bottom-8 left-10 flex gap-2.5">
          <button type="button" onClick={() => { setView('users'); setError(null); setWrong(false) }}
            className="flex cursor-pointer items-center gap-2.5 rounded-xl border border-white/10 bg-[rgba(8,20,48,0.5)] py-2 pr-3.5 pl-2 text-sm text-white hover:bg-[rgba(8,20,48,0.75)]">
            <span className="flex h-[30px] w-[30px] items-center justify-center rounded-full bg-white/15"><Icon d={P.users} size={16}><circle cx="9" cy="8" r="3.5" /></Icon></span>
            Other user
          </button>
        </div>
      )}
      {bottomRight}
      {confirm && <ShutdownConfirm onCancel={() => setConfirm(false)} />}
    </div>
  )
}

import { useRef, useState, type FormEvent } from 'react'
import type { GreeterProps } from './types'
import { os } from '../lib/os'
import { useANow, aShortDate, aTime } from '../components/AClock'
import { AIconEye, AIconEyeOff, AIconNoWifi, AIconPlus, AIconAlert } from '../components/AIcons'
import { validateAccountName } from '../components/AAccount'

interface AUser { id: string; name: string; role: string; initial: string }
const USERS: AUser[] = [
  { id: 'hasarinda', name: 'Hasarinda', role: 'Administrator', initial: 'H' },
  { id: 'nimali', name: 'Nimali', role: 'Standard user', initial: 'N' },
]
const OTHER = '__other__'

const footBtn = 'h-10 rounded-lg border border-[#334155] bg-transparent px-3 text-[13px] text-[#e2e8f0] hover:bg-white/5'

export default function Greeter({ onSignIn }: GreeterProps) {
  const now = useANow()
  const [selected, setSelected] = useState<string>(USERS[0].id)
  const [otherName, setOtherName] = useState('')
  const [password, setPassword] = useState('')
  const [show, setShow] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const pwRef = useRef<HTMLInputElement>(null)
  const otherRef = useRef<HTMLInputElement>(null)

  const isOther = selected === OTHER
  const user = USERS.find((u) => u.id === selected)

  const pick = (id: string) => {
    setSelected(id); setPassword(''); setError(null); setShow(false)
    requestAnimationFrame(() => (id === OTHER ? otherRef.current : pwRef.current)?.focus())
  }

  const submit = async (e: FormEvent) => {
    e.preventDefault()
    if (busy) return
    const account = isOther ? otherName.trim() : selected
    if (isOther) {
      const err = validateAccountName(account)
      if (err) { setError(err); otherRef.current?.focus(); return }
    }
    if (!password) { setError('Enter your password.'); pwRef.current?.focus(); return }
    setBusy(true); setError(null)
    try {
      const res = await os.authenticate(account, password)
      if (res.ok) onSignIn(account)
      else { setError(res.message ?? 'Incorrect password. Try again.'); setPassword(''); pwRef.current?.focus() }
    } catch {
      setError('Sign-in service is unavailable. Try again.')
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="relative flex h-full w-full flex-col overflow-hidden bg-[#0f172a] text-[#e2e8f0]">
      <svg aria-hidden="true" className="pointer-events-none absolute inset-0 h-full w-full" viewBox="0 0 1440 900" preserveAspectRatio="xMidYMid slice">
        <circle cx="720" cy="430" r="520" fill="none" stroke="#1e293b" />
        <circle cx="720" cy="430" r="380" fill="none" stroke="#1e293b" />
      </svg>

      <header className="relative flex h-14 shrink-0 items-center justify-between px-7">
        <div className="flex items-center gap-2.5 text-sm font-semibold">
          <span className="flex h-7 w-7 items-center justify-center rounded-[7px] bg-[#2563eb] text-[13px] font-bold text-white">W</span>
          WorkSuite OS
        </div>
        <time className="text-sm text-[#cbd5e1]" dateTime={now.toISOString()}>{aShortDate(now)} · {aTime(now)}</time>
      </header>

      <main className="relative flex flex-1 flex-wrap items-center justify-center gap-16 overflow-auto px-4 py-6">
        <div role="group" aria-label="Users on this computer" className="flex w-[260px] flex-col gap-2">
          <div className="px-3 pb-1 text-xs font-semibold uppercase tracking-[0.06em] text-[#94a3b8]">Users</div>
          {USERS.map((u) => {
            const active = selected === u.id
            return (
              <button key={u.id} type="button" aria-pressed={active} onClick={() => pick(u.id)}
                className={`flex h-14 items-center gap-3 rounded-xl border px-3 text-left ${active ? 'border-[#3b82f6] bg-[rgba(37,99,235,0.16)] text-[#f8fafc]' : 'border-transparent text-[#e2e8f0] hover:bg-white/5'}`}>
                <span className={`flex h-9 w-9 items-center justify-center rounded-full font-semibold ${active ? 'bg-[#1e3a8a]' : 'bg-[#334155]'}`}>{u.initial}</span>
                <span className="flex flex-col">
                  <span className={`text-sm ${active ? 'font-semibold' : ''}`}>{u.name}</span>
                  <span className={`text-xs ${active ? 'text-[#cbd5e1]' : 'text-[#94a3b8]'}`}>{u.role}</span>
                </span>
              </button>
            )
          })}
          <button type="button" aria-pressed={isOther} onClick={() => pick(OTHER)}
            className={`flex h-14 items-center gap-3 rounded-xl border border-dashed px-3 text-left text-[#cbd5e1] ${isOther ? 'border-[#3b82f6] bg-[rgba(37,99,235,0.16)]' : 'border-[#334155] hover:bg-white/5'}`}>
            <span className="flex h-9 w-9 items-center justify-center rounded-full border border-[#475569]"><AIconPlus /></span>
            <span className="text-sm">Other user</span>
          </button>
        </div>

        <form aria-label="Sign in" onSubmit={submit} noValidate
          className="flex w-[400px] max-w-full flex-col gap-[18px] rounded-[20px] bg-white p-9 text-[#0f172a] shadow-[0_24px_64px_rgba(2,6,23,0.5)]">
          <div className="flex flex-col items-center gap-2.5">
            <span className="flex h-[72px] w-[72px] items-center justify-center rounded-full bg-[#1e3a8a] text-[28px] font-semibold text-white">
              {isOther ? <AIconPlus size={28} /> : user?.initial}
            </span>
            <div className="text-xl font-semibold">{isOther ? 'Other user' : user?.name}</div>
            <div className="text-[13px] text-[#475569]">Livezen Technologies · Enterprise</div>
          </div>

          {isOther && (
            <label className="flex flex-col gap-1.5 text-[13px] font-semibold text-[#334155]">
              User name
              <input ref={otherRef} type="text" autoComplete="username" autoCapitalize="none" spellCheck={false}
                value={otherName} onChange={(e) => { setOtherName(e.target.value); setError(null) }}
                placeholder="user, user@domain or DOMAIN\user"
                className="h-[46px] rounded-[10px] border border-[#cbd5e1] px-3.5 text-base font-normal text-[#0f172a] outline-none focus:border-2 focus:border-[#2563eb]" />
            </label>
          )}

          <label className="flex flex-col gap-1.5 text-[13px] font-semibold text-[#334155]">
            Password
            <span className={`flex h-[46px] items-center rounded-[10px] border-2 bg-white pl-3.5 pr-1.5 ${error ? 'border-[#b91c1c]' : 'border-[#2563eb]'}`}>
              <input ref={pwRef} type={show ? 'text' : 'password'} autoComplete="current-password" autoFocus
                value={password} onChange={(e) => { setPassword(e.target.value); setError(null) }}
                aria-invalid={!!error} aria-describedby={error ? 'a-greeter-err' : undefined}
                className="min-w-0 flex-1 border-0 bg-transparent text-base font-normal text-[#0f172a] outline-none" />
              <button type="button" onClick={() => setShow((s) => !s)} aria-label={show ? 'Hide password' : 'Show password'} aria-pressed={show}
                className="flex h-9 w-9 items-center justify-center rounded-lg text-[#475569] hover:bg-[#f1f5f9]">
                {show ? <AIconEyeOff size={18} /> : <AIconEye size={18} />}
              </button>
            </span>
          </label>

          {error && (
            <div id="a-greeter-err" role="alert" className="flex items-center gap-2 text-[13px] text-[#b91c1c]">
              <AIconAlert /> {error}
            </div>
          )}

          <button type="submit" disabled={busy}
            className="h-[46px] rounded-[10px] bg-[#2563eb] text-[15px] font-semibold text-white hover:bg-[#1d4ed8] disabled:opacity-70">
            {busy ? 'Signing in…' : 'Sign in'}
          </button>

          <div className="flex items-center gap-2 rounded-[10px] bg-[#fffbeb] px-3 py-2.5 text-xs text-[#92400e]">
            <AIconNoWifi className="shrink-0" /> No network — offline sign-in allowed for 6 more days by policy.
          </div>

          <div className="flex justify-between text-[13px]">
            <button type="button" className="text-[#2563eb] hover:text-[#1d4ed8] hover:underline">Forgot password?</button>
            <span className="text-[#475569]">Session: WorkSuite</span>
          </div>
        </form>
      </main>

      <footer className="relative flex h-16 shrink-0 items-center gap-2 px-7">
        <button type="button" aria-label="Keyboard layout: English (US)" className={footBtn}>EN · US</button>
        <button type="button" aria-label="Accessibility" className={footBtn}>Accessibility</button>
        <div className="ml-auto flex gap-2">
          <button type="button" className={footBtn} onClick={() => void os.power('restart')}>Restart</button>
          <button type="button" className={footBtn} onClick={() => void os.power('shutdown')}>Shut down</button>
        </div>
      </footer>
    </div>
  )
}

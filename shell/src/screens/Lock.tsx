import { useRef, useState, type FormEvent } from 'react'
import type { LockProps } from './types'
import { os } from '../lib/os'
import { useANow, aLongDate, aTime } from '../components/AClock'
import { AIconArrowRight, AIconEye, AIconEyeOff, AIconLock, AIconAlert } from '../components/AIcons'

const btn = 'h-10 rounded-lg border border-[#334155] bg-transparent px-3.5 text-[13px] text-[#e2e8f0] hover:bg-white/5'

export default function Lock({ user, onUnlock }: LockProps) {
  const now = useANow()
  const [password, setPassword] = useState('')
  const [show, setShow] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const ref = useRef<HTMLInputElement>(null)
  const display = user ? user.replace(/^.*\\/, '').replace(/@.*$/, '') : 'User'
  const name = display.charAt(0).toUpperCase() + display.slice(1)

  const submit = async (e: FormEvent) => {
    e.preventDefault()
    if (busy) return
    if (!password) { setError('Enter your password.'); ref.current?.focus(); return }
    setBusy(true); setError(null)
    try {
      const res = await os.authenticate(user, password)
      if (res.ok) onUnlock()
      else { setError(res.message ?? 'Incorrect password.'); setPassword(''); ref.current?.focus() }
    } catch {
      setError('Unable to verify password. Try again.')
    } finally { setBusy(false) }
  }

  return (
    <div className="relative flex h-full w-full flex-col items-center overflow-auto bg-[#0b1120] text-[#f8fafc]">
      <svg aria-hidden="true" className="pointer-events-none absolute inset-0 h-full w-full" viewBox="0 0 1440 900" preserveAspectRatio="xMidYMid slice">
        <circle cx="1180" cy="180" r="420" fill="none" stroke="#1a2438" />
        <circle cx="1180" cy="180" r="300" fill="none" stroke="#1a2438" />
        <circle cx="220" cy="820" r="360" fill="none" stroke="#151e30" />
      </svg>

      <div className="relative mt-[clamp(48px,16vh,150px)] flex flex-col items-center gap-1">
        <time dateTime={now.toISOString()} className="text-[clamp(72px,12vw,120px)] font-extralight leading-none tracking-[-4px]">{aTime(now)}</time>
        <div className="text-xl text-[#cbd5e1]">{aLongDate(now)}</div>
      </div>

      <section aria-label="Notifications while locked" className="relative mt-10 flex w-[420px] max-w-[calc(100%-32px)] flex-col gap-2">
        <div className="flex items-center gap-3 rounded-xl border border-[#24314a] bg-[rgba(30,41,59,0.85)] px-4 py-3">
          <span className="flex h-8 w-8 items-center justify-center rounded-lg bg-[#dbeafe] text-[13px] font-bold text-[#1d4ed8]">M</span>
          <span className="flex-1 text-sm">Mail · 3 new messages</span>
          <span className="text-xs text-[#94a3b8]">Content hidden</span>
        </div>
        <div className="flex items-center gap-3 rounded-xl border border-[#24314a] bg-[rgba(30,41,59,0.85)] px-4 py-3">
          <span className="flex h-8 w-8 items-center justify-center rounded-lg bg-[#ccfbf1] text-xs font-bold text-[#0f766e]">Me</span>
          <span className="flex-1 text-sm">Meet · starts in 18 min</span>
          <span className="text-xs text-[#94a3b8]">10:30</span>
        </div>
      </section>

      <form aria-label="Unlock" onSubmit={submit} noValidate className="relative mb-24 mt-12 flex flex-col items-center gap-3">
        <div className="flex items-center gap-2.5">
          <span className="flex h-10 w-10 items-center justify-center rounded-full bg-[#1e3a8a] font-semibold">{name.charAt(0)}</span>
          <span className="text-base font-semibold">{name}</span>
        </div>
        <div className={`flex h-12 w-[340px] max-w-[calc(100vw-32px)] items-center gap-2 rounded-xl border bg-[rgba(248,250,252,0.1)] pl-4 pr-1.5 focus-within:border-[#60a5fa] ${error ? 'border-[#f87171]' : 'border-[#475569]'}`}>
          <AIconLock className="shrink-0 text-[#cbd5e1]" />
          <input ref={ref} type={show ? 'text' : 'password'} placeholder="Password" aria-label="Password" autoFocus autoComplete="current-password"
            value={password} onChange={(e) => { setPassword(e.target.value); setError(null) }}
            aria-invalid={!!error} aria-describedby={error ? 'a-lock-err' : undefined}
            className="min-w-0 flex-1 border-0 bg-transparent text-[15px] text-[#f8fafc] placeholder:text-[#94a3b8] outline-none" />
          <button type="button" onClick={() => setShow((s) => !s)} aria-label={show ? 'Hide password' : 'Show password'} aria-pressed={show}
            className="flex h-9 w-9 items-center justify-center rounded-lg text-[#cbd5e1] hover:bg-white/10">
            {show ? <AIconEyeOff /> : <AIconEye />}
          </button>
          <button type="submit" aria-label="Unlock" disabled={busy}
            className="flex h-9 w-9 items-center justify-center rounded-lg bg-[#2563eb] text-white hover:bg-[#1d4ed8] disabled:opacity-70">
            <AIconArrowRight />
          </button>
        </div>
        {error
          ? <div id="a-lock-err" role="alert" className="flex items-center gap-1.5 text-xs text-[#fca5a5]"><AIconAlert size={14} />{error}</div>
          : <div className="text-xs text-[#94a3b8]">Locked before sleep · secure session lock</div>}
      </form>

      <div className="absolute bottom-6 left-7 flex items-center gap-4 text-[13px] text-[#cbd5e1]">
        <span>Livezen-Office Wi-Fi</span>
        <span>Battery 79%</span>
      </div>
      <div className="absolute bottom-5 right-7 flex gap-2">
        <button type="button" className={btn} onClick={() => void os.logout()}>Switch user</button>
        <button type="button" aria-label="Accessibility" className={btn}>Accessibility</button>
      </div>
    </div>
  )
}

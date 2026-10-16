// Kiosk exit prompt (WSOS-AUTH-002): shown over the kiosk app after the admin exit gesture (Ctrl+Alt+Shift+K or five
// taps in the top-left corner). The exit PIN is checked by the root helper against the policy's verifier (never here);
// "administrator password" asks through polkit. Both end the kiosk session and return to the greeter.
import { useEffect, useRef, useState, type FormEvent } from 'react'
import { kioskApi, type KioskApi, type KioskExitResult } from '../lib/kioskApi'
import { useT } from '../i18n'

const RED = '#FF8A7A'
const KEYS = ['1', '2', '3', '4', '5', '6', '7', '8', '9', '', '0', 'del'] as const
const IDLE_CLOSE_MS = 60_000

export default function KioskExit({ api = kioskApi() }: { api?: KioskApi | null }) {
  const t = useT()
  const [pinOn, setPinOn] = useState<boolean | null>(null)
  const [pin, setPin] = useState('')
  const [busy, setBusy] = useState(false)
  const [result, setResult] = useState<KioskExitResult | null>(null)
  const input = useRef<HTMLInputElement>(null)
  const lastInput = useRef(Date.now())

  useEffect(() => { void api?.info().then((i) => setPinOn(i.exitPin)).catch(() => setPinOn(false)) }, [api])
  useEffect(() => { if (pinOn) input.current?.focus() }, [pinOn])
  // Left open on an unattended kiosk, the prompt goes away by itself.
  useEffect(() => {
    const iv = setInterval(() => { if (Date.now() - lastInput.current > IDLE_CLOSE_MS) void api?.cancel() }, 5000)
    return () => clearInterval(iv)
  }, [api])
  if (!api || pinOn === null) return null

  const touch = () => { lastInput.current = Date.now() }
  const press = (k: string) => {
    touch()
    if (k === 'del') setPin((p) => p.slice(0, -1))
    else if (pin.length < 12) setPin((p) => p + k)
  }
  const run = async (fn: () => Promise<KioskExitResult>) => {
    setBusy(true); setResult(null)
    const r = await fn().catch(() => 'failed' as const)
    setBusy(false); setResult(r); setPin('')
    if (r !== 'ok') input.current?.focus()
  }
  const submit = (e: FormEvent) => { e.preventDefault(); if (pin.length >= 6 && !busy) void run(() => api.exitWithPin(pin)) }
  const locked = result === 'locked_out'
  const msg: Partial<Record<KioskExitResult, string>> = {
    ok: t('kiosk.leaving'), wrong_pin: t('kiosk.wrongPin'), locked_out: t('kiosk.lockedOut'), pin_disabled: t('kiosk.pinDisabled'),
    cancelled: t('kiosk.cancelled'), failed: t('kiosk.failed'),
  }
  const bad = result !== null && result !== 'ok'
  const btn = 'cursor-pointer rounded-[10px] px-[18px] py-2.5 text-sm font-medium disabled:cursor-default disabled:opacity-50'

  return (
    <main className="fixed inset-0 flex items-center justify-center bg-[#050B18] font-sans text-[#E8EEFA]" onPointerDown={touch} onKeyDown={touch}>
      <form role="alertdialog" aria-modal="true" aria-labelledby="ke-t" aria-describedby="ke-d" onSubmit={submit}
        onKeyDown={(e) => { if (e.key === 'Escape') void api.cancel() }}
        className="relative box-border w-[540px] max-w-[calc(100%-32px)] overflow-hidden rounded-[20px] border bg-[#0F2350] shadow-[0_30px_80px_rgba(0,0,0,0.6)]"
        style={{ borderColor: bad ? 'rgba(255,138,122,0.45)' : 'rgba(127,178,255,0.2)' }}>
        <div className="flex flex-col items-center gap-2.5 px-[26px] pt-[26px] pb-[14px] text-center">
          <span className="flex h-14 w-14 items-center justify-center rounded-2xl bg-[rgba(31,107,255,0.18)]">
            <svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="#7FB2FF" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><rect x="3" y="4" width="18" height="12" rx="2" /><path d="M8 20h8M12 16v4M15 10h-6M11 8l-2 2 2 2" /></svg>
          </span>
          <h1 id="ke-t" className="mt-1 mb-0 text-[19px] font-bold">{t('kiosk.exitTitle')}</h1>
          <p id="ke-d" className="m-0 text-sm leading-normal text-[#C9D6EE]">{pinOn ? t('kiosk.exitBody') : t('kiosk.exitBodyAdmin')}</p>
        </div>
        {pinOn && (
          <div className="flex flex-col gap-2 px-[22px] pt-2">
            <label htmlFor="ke-pin" className="text-xs text-[#C9D6EE]">{t('kiosk.pinLabel')}</label>
            <input id="ke-pin" ref={input} type="password" inputMode="numeric" autoComplete="off" maxLength={12} value={pin} disabled={busy || locked}
              onChange={(e) => { touch(); setPin(e.target.value.replace(/\D/g, '').slice(0, 12)) }} aria-invalid={bad || undefined} aria-describedby="ke-msg"
              className="box-border h-[46px] rounded-xl bg-[rgba(4,10,26,0.6)] px-3.5 text-center font-mono text-xl tracking-[0.4em] text-white outline-none focus-visible:outline-2 focus-visible:outline-[#7FB2FF]"
              style={{ border: `1px solid ${bad ? RED : 'rgba(255,255,255,0.2)'}` }} />
            <div role="group" aria-label={t('kiosk.keypad')} className="grid grid-cols-3 gap-2 pt-1">
              {KEYS.map((k, i) => k === '' ? <span key={i} /> : (
                <button key={k} type="button" disabled={busy || locked} onClick={() => press(k)} aria-label={k === 'del' ? t('kiosk.deleteDigit') : undefined}
                  className="h-12 cursor-pointer rounded-xl border border-[rgba(127,178,255,0.18)] bg-white/[0.06] text-lg font-semibold text-[#E8EEFA] hover:bg-white/[0.12] disabled:opacity-40">
                  {k === 'del' ? <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" className="mx-auto"><path d="M21 5H9l-6 7 6 7h12zM17 9l-6 6M11 9l6 6" /></svg> : k}
                </button>
              ))}
            </div>
          </div>
        )}
        <p id="ke-msg" role={bad ? 'alert' : 'status'} className="m-0 min-h-[18px] px-[22px] pt-3 text-xs" style={{ color: bad ? RED : '#8FA3C8' }}>
          {busy ? t('kiosk.checking') : result ? msg[result] : t('kiosk.autoClose')}
        </p>
        <div className="mt-3 flex flex-wrap items-center justify-end gap-2.5 border-t border-[rgba(127,178,255,0.12)] bg-[rgba(4,10,26,0.35)] px-[18px] py-3.5">
          <button type="button" disabled={busy} onClick={() => void run(() => api.exitAsAdmin())} className="mr-auto cursor-pointer border-0 bg-transparent p-0 text-sm font-medium text-[#7FB2FF] hover:text-[#B8D4FF] disabled:opacity-50">{t('kiosk.useAdmin')}</button>
          <button type="button" onClick={() => void api.cancel()} className={`${btn} border border-[rgba(127,178,255,0.25)] bg-transparent text-[#E8EEFA]`}>{t('kiosk.cancel')}</button>
          {pinOn && <button type="submit" disabled={busy || locked || pin.length < 6} className={`${btn} border-0 bg-[#1F6BFF] font-semibold text-white`}>{t('kiosk.leave')}</button>}
        </div>
      </form>
    </main>
  )
}

/** Shown by the kiosk app while the app starts, restarts after a crash, or cannot be reached. */
export function KioskStatus({ state }: { state: 'starting' | 'unavailable' }) {
  const t = useT()
  return (
    <main className="fixed inset-0 flex flex-col items-center justify-center gap-4 bg-[#0A1A3D] px-6 text-center font-sans text-[#E8EEFA]">
      <svg width="64" height="80" viewBox="0 0 30 38" aria-hidden="true"><rect x="10" y="0" width="20" height="20" fill="#0A6CFF" /><rect x="0" y="10" width="10" height="10" fill="#00DAF2" /><rect x="10" y="10" width="10" height="10" fill="#0B2A66" /><rect x="10" y="20" width="10" height="10" fill="#00DAF2" /><rect x="0" y="33" width="30" height="5" rx="2.5" fill="#E2E8F0" /></svg>
      {state === 'starting' ? <p role="status" className="m-0 text-base text-[#C9D6EE]">{t('kiosk.starting')}</p> : (
        <>
          <h1 className="m-0 text-2xl font-bold">{t('kiosk.unavailableTitle')}</h1>
          <p role="status" className="m-0 max-w-[480px] text-sm text-[#C9D6EE]">{t('kiosk.unavailableBody')}</p>
        </>
      )}
    </main>
  )
}

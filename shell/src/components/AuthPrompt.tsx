// G05 "Administrator access needed": the shell-drawn polkit prompt (electron/polkit.ts, services/session/polkit).
// The message, action, requesting program and account come from polkit; PAM checks the password; tries left and the
// lockout follow pam_faillock's deny / unlock_time (WSOS-AUTH-004). Without the agent bridge nothing is shown.
import { useEffect, useRef, useState, type FormEvent } from 'react'
import { countdown, polkitApi, type PolkitPrompt } from '../lib/polkitApi'
import { aTime } from './AClock'
import { formatNumber, useT } from '../i18n'

const RED = '#FF8A7A'

/** onOpen: a prompt is up (the desktop lifts the shell over the apps so it shows; electron/panelHost.ts). */
export default function AuthPrompt({ onOpen }: { onOpen?: (open: boolean) => void } = {}) {
  const t = useT()
  const api = polkitApi()
  const [p, setP] = useState<PolkitPrompt | null>(null)
  const [pw, setPw] = useState('')
  const [details, setDetails] = useState(false)
  const [now, setNow] = useState(() => Date.now())
  const input = useRef<HTMLInputElement>(null)

  useEffect(() => {
    if (!api) return
    let live = true
    void api.state().then((s) => { if (live) setP(s) }).catch(() => {})
    const off = api.onState((s) => setP(s))
    return () => { live = false; off() }
  }, [api])
  const id = p?.id
  useEffect(() => { setPw(''); setDetails(false) }, [id])
  const locked = !!p?.locked && !(p.lockedUntil != null && now >= p.lockedUntil)
  useEffect(() => {
    if (!p?.locked || p.lockedUntil == null) return
    const iv = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(iv)
  }, [p?.locked, p?.lockedUntil])
  useEffect(() => { if (p && !locked && !p.busy) input.current?.focus() }, [p, locked])

  const shown = !!api && !!p
  useEffect(() => { onOpen?.(shown) }, [shown, onOpen])
  if (!api || !p) return null
  const cancel = () => { void api.cancel(p.id) }
  const submit = (e: FormEvent) => {
    e.preventDefault()
    if (locked || p.busy || !pw) return
    void api.respond(p.id, pw)
    setPw('')
  }
  const minutes = formatNumber(Math.max(1, Math.round(p.unlockTime / 60)))
  const failed = p.failed && !locked
  const bad = failed || locked
  let msg = p.info?.text ?? ''
  let msgColor = p.info?.error ? RED : '#8FA3C8'
  if (locked) {
    msg = p.lockedUntil != null ? t('polkit.tryAt', { time: aTime(new Date(p.lockedUntil)) }) : t('polkit.askIt')
    msgColor = '#FFB98A'
  } else if (failed) {
    const left = p.remaining ?? 0
    msg = p.unlockTime === 0 ? t('polkit.wrongAdmin', { count: formatNumber(left) })
      : left === 1 ? t('polkit.wrongOne', { minutes }) : t('polkit.wrong', { count: formatNumber(left), minutes })
    msgColor = RED
  }
  const program = p.program ?? t('polkit.unknownProgram')
  const iconColor = locked ? RED : '#7FB2FF'

  return (
    <div className="fixed inset-0 z-[97] flex items-center justify-center font-sans text-[#E8EEFA]">
      <div className="absolute inset-0 bg-[rgba(2,6,16,0.6)] backdrop-blur-[8px]" aria-hidden="true" />
      <form role="alertdialog" aria-modal="true" aria-labelledby="au-t" aria-describedby="au-d" onSubmit={submit}
        onKeyDown={(e) => { if (e.key === 'Escape') cancel() }}
        className="relative box-border w-[460px] max-w-[calc(100%-32px)] overflow-hidden rounded-[20px] bg-[#0F2350] shadow-[0_30px_80px_rgba(0,0,0,0.6)]"
        style={{ border: `1px solid ${locked ? 'rgba(255,138,122,0.5)' : failed ? 'rgba(255,138,122,0.4)' : 'rgba(127,178,255,0.2)'}` }}>
        <div className="flex flex-col items-center gap-2.5 px-[26px] pt-[26px] pb-[18px] text-center">
          <span className="flex h-14 w-14 items-center justify-center rounded-2xl" style={{ background: locked ? 'rgba(255,138,122,0.16)' : 'rgba(31,107,255,0.18)' }}>
            <svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke={iconColor} strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M12 3l8 3v6c0 5-3.5 8-8 9-4.5-1-8-4-8-9V6zM12 9v4M12 16h.01" /></svg>
          </span>
          <h2 id="au-t" className="mt-1 mb-0 text-[19px] font-bold">{locked ? t('polkit.titleLocked') : t('polkit.title')}</h2>
          <p id="au-d" className="m-0 text-sm leading-normal text-[#C9D6EE]">
            {locked ? (p.lockedUntil != null
              ? t('polkit.lockedBody', { time: countdown(p.lockedUntil, now), count: formatNumber(p.deny) })
              : t('polkit.lockedBodyAdmin', { count: formatNumber(p.deny) })) : p.message}
          </p>
        </div>
        <div className="mx-[22px] flex flex-col gap-2 rounded-xl bg-[rgba(4,10,26,0.5)] px-3.5 py-3">
          <div className="flex items-center gap-3">
            <span className="flex h-[34px] w-[34px] items-center justify-center rounded-[9px] bg-[#1F6BFF] text-sm font-bold" aria-hidden="true">{program.slice(0, 1).toUpperCase()}</span>
            <span className="flex min-w-0 flex-1 flex-col gap-0.5">
              <span className="text-[13px] font-semibold">{program}</span>
            </span>
            <button type="button" aria-expanded={details} onClick={() => setDetails(!details)} className="cursor-pointer border-0 bg-transparent p-0 text-xs text-[#7FB2FF] hover:text-[#B8D4FF]">
              {details ? t('polkit.hideDetails') : t('polkit.details')}
            </button>
          </div>
          {details && (
            <div className="flex flex-col gap-1 border-t border-[rgba(127,178,255,0.12)] pt-2 text-xs text-[#C9D6EE]">
              <span>{t('polkit.detailAccount', { user: p.user })}</span>
              <span className="truncate font-mono text-[11px] text-[#8FA3C8]">{p.actionId}</span>
              <span>{p.unlockTime === 0 ? t('polkit.detailPolicyAdmin', { count: formatNumber(p.deny) }) : t('polkit.detailPolicy', { count: formatNumber(p.deny), minutes })}</span>
            </div>
          )}
        </div>
        <div className="flex flex-col gap-2 px-[22px] pt-4 pb-5">
          <label htmlFor="au-pw" className="text-xs text-[#C9D6EE]">{t('polkit.passwordFor', { name: p.userDisplay })}</label>
          <input id="au-pw" ref={input} type="password" value={pw} disabled={locked} autoComplete="current-password"
            onChange={(e) => setPw(e.target.value)} aria-invalid={failed || undefined} aria-describedby="au-msg"
            className="box-border h-[46px] rounded-xl bg-[rgba(4,10,26,0.6)] px-3.5 text-base text-white outline-none focus-visible:outline-2 focus-visible:outline-[#7FB2FF]"
            style={{ border: `1px solid ${bad && !locked ? RED : 'rgba(255,255,255,0.2)'}`, opacity: locked ? 0.4 : 1 }} />
          <span id="au-msg" role={bad ? 'alert' : undefined} className="min-h-[18px] text-xs" style={{ color: msgColor }}>{msg}</span>
        </div>
        <div className="flex justify-end gap-2.5 border-t border-[rgba(127,178,255,0.12)] bg-[rgba(4,10,26,0.35)] px-[18px] py-3.5">
          <button type="button" onClick={cancel} className="cursor-pointer rounded-[10px] border border-[rgba(127,178,255,0.25)] bg-transparent px-[18px] py-2.5 text-sm font-medium text-[#E8EEFA]">{t('polkit.cancel')}</button>
          <button type="submit" disabled={locked || p.busy || !pw} className="cursor-pointer rounded-[10px] border-0 px-5 py-2.5 text-sm font-semibold disabled:cursor-default"
            style={{ background: locked ? 'rgba(31,107,255,0.3)' : '#1F6BFF', color: locked ? 'rgba(255,255,255,0.5)' : '#FFFFFF' }}>
            {p.busy ? t('polkit.checking') : t('polkit.authenticate')}
          </button>
        </div>
      </form>
    </div>
  )
}

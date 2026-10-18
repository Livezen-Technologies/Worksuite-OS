// Shutdown / restart / sign-out overlay (BootSplash board, "shutting down" and "restarting" modes): the splash's
// column on #040A1A fades in over the desktop while apps close, so Plymouth's shutdown splash (same column, same
// place) continues it without a jump. Apps that do not close, and logind inhibitors, get the macOS-style
// "These apps are preventing shutdown" dialog. Every display shows the overlay (EndMirror on the other outputs).
import { useEffect, useRef, useState } from 'react'
import { os } from '../lib/os'
import type { PanelWindow } from '../lib/panel'
import { errorMessage } from '../lib/errors'
import { sessionApi, type EndAction, type EndState } from '../lib/sessionApi'
import { ANYWAY, BLOCKED_TITLE, CLOSE_TIMEOUT_MS, SUB, TITLE, appWindows, blockers, closeProgress, type Blocker } from '../lib/sessionEnd'
import { t } from '../i18n'

const BG = '#040A1A'
/** How long a forced restart/shutdown may wait for polkit before the dialog comes back. */
export const FORCE_TIMEOUT_MS = 45_000

/** The splash's mark (branding/plymouth/mark.svg) in its spinning ring. */
function RingMark() {
  return (
    <div className="relative h-[120px] w-[120px]" aria-hidden="true">
      <svg width="120" height="120" viewBox="0 0 120 120" className="absolute inset-0 animate-spin [animation-duration:1.4s]">
        <circle cx="60" cy="60" r="54" fill="none" stroke="rgba(127,178,255,0.12)" strokeWidth="4" />
        <path d="M60 6a54 54 0 0 1 54 54" fill="none" stroke="#18D4F0" strokeWidth="4" strokeLinecap="round" />
      </svg>
      <svg width="48" height="48" viewBox="0 0 60 60" className="absolute top-9 left-9">
        <rect x="20" y="0" width="40" height="40" rx="3" fill="#1F6BFF" />
        <rect x="20" y="20" width="20" height="20" fill={BG} />
        <rect x="0" y="20" width="20" height="20" rx="3" fill="#18D4F0" />
        <rect x="20" y="40" width="20" height="20" rx="3" fill="#18D4F0" />
      </svg>
    </div>
  )
}

/** The column itself, shared by the main window and the mirrors. */
/** How long the fade-in may take before onOpaque is called anyway (a busy machine can drop transitionend). */
export const OPAQUE_FALLBACK_MS = 2000

export function EndColumn({ state, shown, onOpaque }: { state: EndState; shown: boolean; onOpaque?: () => void }) {
  const phase = state.phase === 'ending' ? (state.action === 'logout' ? t('end.phaseSigningOut') : t('end.phaseTurningOff'))
    : t('end.phaseClosing')
  return (
    <div className={`fixed inset-0 z-[95] flex flex-col items-center justify-center gap-7 font-sans text-[#E8EEFA] transition-opacity duration-500 ease-out ${shown ? 'opacity-100' : 'opacity-0'}`}
      style={{ background: BG }} role="status" aria-live="polite"
      onTransitionEnd={(e) => { if (e.target === e.currentTarget && e.propertyName === 'opacity' && shown) onOpaque?.() }}>
      <RingMark />
      <div className="flex flex-col items-center gap-2.5">
        <h1 className="m-0 text-[28px] font-medium">{t(TITLE[state.action])}</h1>
        <p className="m-0 text-[15px] text-[#8FA3C8]">{t(SUB[state.action])}</p>
      </div>
      <div className="flex w-[420px] max-w-[calc(100vw-32px)] flex-col gap-2.5">
        <div className="h-1 overflow-hidden rounded-sm bg-[rgba(127,178,255,0.12)]" role="progressbar" aria-label={phase} aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(state.progress * 100)}>
          <div className="h-full bg-[linear-gradient(90deg,#1F6BFF,#18D4F0)] transition-[width] duration-500 ease-out" style={{ width: `${Math.max(1, state.progress * 100)}%` }} />
        </div>
        <div className="flex justify-between font-mono text-xs text-[#8FA3C8]"><span>{phase}</span><span>WorkSuite OS</span></div>
      </div>
    </div>
  )
}

/** Other displays: the same overlay while the main window runs it. */
export function EndMirror() {
  const [state, setState] = useState<EndState | null>(null)
  const [shown, setShown] = useState(false)
  useEffect(() => sessionApi.onEndState((s) => {
    if (s) { setState(s); requestAnimationFrame(() => setShown(true)) } else { setShown(false); setTimeout(() => setState(null), 500) }
  }), [])
  return state ? <EndColumn state={state} shown={shown} /> : null
}

const prettyId = (id: string) => (id.split('.').pop() ?? id).replace(/[-_]+/g, ' ').replace(/^./, (c) => c.toUpperCase())

/** onOpaque: the overlay has fully faded in. A dialog it replaces (the shutdown confirmation) stays until then: closing it
 *  on a timer showed a frame of plain desktop through the half-faded overlay on a busy machine. */
export function SessionEnd({ action, onCancel, onLogout = () => os.logout(), nameOf = (id) => prettyId(id), onOpaque }: {
  action: EndAction; onCancel: () => void; onLogout?: () => unknown; nameOf?: (appId: string, title: string) => string; onOpaque?: () => void
}) {
  const [state, setState] = useState<EndState>({ action, phase: 'closing', progress: 0 })
  const [shown, setShown] = useState(false)
  const [blocked, setBlocked] = useState<Blocker[] | null>(null)
  const [error, setError] = useState<string | null>(null)
  const done = useRef(false)
  const total = useRef(0)
  const left = useRef<PanelWindow[]>([])
  const inhibited = useRef(false)
  const cancelBtn = useRef<HTMLButtonElement>(null)
  const opaqueSent = useRef(false)
  const opaque = () => { if (!opaqueSent.current) { opaqueSent.current = true; onOpaque?.() } }
  useEffect(() => { const id = setTimeout(opaque, OPAQUE_FALLBACK_MS); return () => clearTimeout(id) }, [])  // eslint-disable-line react-hooks/exhaustive-deps

  const publish = (s: EndState | null) => { void sessionApi.setEndState(s) }
  const go = async (force = false) => {
    if (done.current && !force) return
    done.current = true
    setBlocked(null)
    const s: EndState = { action, phase: 'ending', progress: 1 }
    setState(s); publish(s)
    await new Promise((r) => setTimeout(r, 600))   // let the bar finish before systemd's splash takes over
    if (action === 'logout') { await onLogout(); return }
    if (force && inhibited.current) {
      // polkit asks for an administrator here; if that prompt is dismissed or never answered, come back to the
      // dialog instead of leaving the overlay on screen (systemd has not started shutting down).
      const r = await Promise.race([sessionApi.powerForce(action), new Promise<{ ok: false; error: string }>((res) => setTimeout(() => res({ ok: false, error: 'timeout' }), FORCE_TIMEOUT_MS))])
      if (!r.ok) {
        done.current = false
        setError(errorMessage(r.error === 'timeout' ? 'not_authorized' : r.error, 'generic'))
        const s: EndState = { action, phase: 'blocked', progress: closeProgress(total.current, left.current.length) }
        setState(s); publish(s); setBlocked(blockers(left.current, [], nameOf).length ? blockers(left.current, [], nameOf) : [])
      }
      return
    }
    await os.power(action)
  }
  const proceed = async () => {
    if (done.current) return
    const inh = action === 'logout' ? { ok: true as const, value: [] } : await sessionApi.inhibitors(action).catch(() => ({ ok: false as const, error: 'failed' }))
    inhibited.current = inh.ok && inh.value.length > 0
    const list = blockers(left.current, inh.ok ? inh.value : [], nameOf)
    if (list.length) {
      const s: EndState = { action, phase: 'blocked', progress: closeProgress(total.current, left.current.length) }
      setState(s); publish(s); setBlocked(list)
      return
    }
    void go()
  }

  useEffect(() => {
    requestAnimationFrame(() => setShown(true))
    publish(state)
    const panel = window.worksuitePanel
    let off = () => {}
    let timer: ReturnType<typeof setTimeout> | null = null
    const update = (ws: PanelWindow[]) => {
      left.current = appWindows(ws)
      if (done.current) return
      const s: EndState = { action, phase: 'closing', progress: closeProgress(total.current, left.current.length) }
      setState((prev) => (prev.phase === 'blocked' ? prev : s))
      if (left.current.length === 0) { if (timer) clearTimeout(timer); timer = null; void proceed() }
    }
    if (!panel) { const id = setTimeout(() => void proceed(), 700); return () => clearTimeout(id) }
    void panel.windows().then((ws) => {
      const mine = appWindows(ws)
      total.current = mine.length
      left.current = mine
      // Ask every app to close (like quitting each one); apps with unsaved work show their own question.
      for (const w of mine) void panel.close(w.handle)
      off = panel.onWindows(update)
      if (mine.length === 0) setTimeout(() => void proceed(), 700)
      else timer = setTimeout(() => void proceed(), CLOSE_TIMEOUT_MS)
    }).catch(() => void proceed())
    return () => { off(); if (timer) clearTimeout(timer) }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  useEffect(() => { if (blocked) cancelBtn.current?.focus() }, [blocked])

  const cancel = () => {
    done.current = true
    setShown(false); publish(null)
    setTimeout(onCancel, 450)
  }

  return (
    <>
      <EndColumn state={state} shown={shown} onOpaque={opaque} />
      {blocked && (
        <div className="fixed inset-0 z-[96] flex items-center justify-center bg-[rgba(2,6,16,0.45)] p-4 font-sans">
          <div role="alertdialog" aria-modal="true" aria-labelledby="end-blocked-t" aria-describedby="end-blocked-d"
            onKeyDown={(e) => { if (e.key === 'Escape') { e.preventDefault(); cancel() } }}
            className="flex w-[460px] max-w-full flex-col gap-[18px] rounded-[20px] border border-[rgba(127,178,255,0.18)] bg-[#0C1E46] p-7 text-[#E8EEFA] shadow-[0_30px_80px_rgba(0,0,0,0.6)]">
            <div className="flex flex-col gap-1.5">
              <h2 id="end-blocked-t" className="m-0 text-xl font-bold">{t(BLOCKED_TITLE[action])}</h2>
              <p id="end-blocked-d" className="m-0 text-sm text-[#8FA3C8]">{error ?? t('end.blockedBody')}</p>
            </div>
            {blocked.length > 0 && (
              <ul className="m-0 flex list-none flex-col gap-2 p-0">
                {blocked.map((b) => (
                  <li key={b.name} className="flex items-center gap-3 rounded-xl border border-[rgba(255,159,90,0.25)] bg-[rgba(255,159,90,0.08)] px-3.5 py-3">
                    <span className="flex h-[30px] w-[30px] shrink-0 items-center justify-center rounded-lg bg-[#1F6BFF] text-[13px] font-bold text-white" aria-hidden="true">{b.name.charAt(0).toUpperCase()}</span>
                    <span className="flex min-w-0 flex-col"><span className="truncate text-sm font-medium">{b.name}</span><span className="truncate text-xs text-[#C9D6EE]">{b.reason ?? t('end.stillOpen')}</span></span>
                  </li>
                ))}
              </ul>
            )}
            <div className="flex justify-end gap-3">
              <button ref={cancelBtn} type="button" onClick={cancel} className="cursor-pointer rounded-[10px] border border-[rgba(127,178,255,0.25)] px-5 py-2.5 text-[15px] font-medium hover:bg-white/5">{t('common.cancel')}</button>
              <button type="button" onClick={() => void go(true)} className="cursor-pointer rounded-[10px] bg-[#D9452B] px-5 py-2.5 text-[15px] font-semibold text-white shadow-[0_8px_24px_rgba(217,69,43,0.35)] hover:brightness-110">{t(ANYWAY[action])}</button>
            </div>
          </div>
        </div>
      )}
    </>
  )
}

let fadedIn = false
/** Signing in: the greeter ends on a dark frame (#040A1A) and the window starts with that colour (electron/main.ts),
 *  so the desktop fades in from it once per shell start instead of flashing. */
export function SessionFadeIn() {
  const [phase, setPhase] = useState<'on' | 'fading' | 'gone'>(fadedIn ? 'gone' : 'on')
  useEffect(() => {
    // Not `if (fadedIn) return`: React's StrictMode (the dev preview) runs this twice, and the cleanup of the first
    // run would cancel the fade, leaving the dark frame over the desktop for good.
    if (phase === 'gone') return
    fadedIn = true
    const raf = requestAnimationFrame(() => setPhase('fading'))
    const done = setTimeout(() => setPhase('gone'), 900)
    return () => { cancelAnimationFrame(raf); clearTimeout(done) }
  }, []) // eslint-disable-line react-hooks/exhaustive-deps
  if (phase === 'gone') return null
  return <div aria-hidden="true" className={`pointer-events-none fixed inset-0 z-[99] transition-opacity duration-700 ease-out ${phase === 'on' ? 'opacity-100' : 'opacity-0'}`} style={{ background: BG }} />
}

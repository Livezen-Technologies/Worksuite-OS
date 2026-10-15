// Power menu and shutdown confirmation (PowerMenu / ShutdownConfirm boards).
import { useEffect, useRef, useState, type KeyboardEvent as RKeyboardEvent } from 'react'
import { os } from '../lib/os'
import { SHUTDOWN_SECONDS, ringDash, uptimeLabel } from '../lib/power'
import { Avatar, Icon, P, mono } from './Ws'

export interface PowerMenuProps {
  /** Shown in the header when signed in; the greeter passes none. */
  user?: string
  onClose: () => void
  onLock?: () => void
  onSignOut?: () => void
  /** Opens the shutdown confirmation. */
  onShutdown: () => void
  className?: string
}

export function PowerMenu({ user, onClose, onLock, onSignOut, onShutdown, className = '' }: PowerMenuProps) {
  const ref = useRef<HTMLDivElement>(null)
  const items: { label: string; d: readonly string[]; key?: string; sep?: boolean; run: () => void }[] = []
  if (onLock) items.push({ label: 'Lock', d: P.lock, key: 'Super+L', run: onLock })
  if (onSignOut) items.push({ label: 'Sign out', d: P.signOut, run: onSignOut })
  items.push(
    { label: 'Sleep', d: P.sleep, sep: items.length > 0, run: () => void os.power('suspend') },
    { label: 'Restart', d: P.restart, run: () => void os.power('restart') },
    { label: 'Shut down', d: P.power, run: onShutdown },
  )

  useEffect(() => {
    Array.from(ref.current?.querySelectorAll<HTMLElement>('[role="menuitem"]') ?? []).pop()?.focus()
    const onDown = (e: MouseEvent) => { if (ref.current && !ref.current.contains(e.target as Node) && !(e.target as HTMLElement).closest('[data-power-toggle]')) onClose() }
    window.addEventListener('mousedown', onDown)
    return () => window.removeEventListener('mousedown', onDown)
  }, [onClose])

  const onKey = (e: RKeyboardEvent) => {
    const all = Array.from(ref.current?.querySelectorAll<HTMLElement>('[role="menuitem"]') ?? [])
    const i = all.indexOf(document.activeElement as HTMLElement)
    if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); onClose() }
    else if (e.key === 'ArrowDown') { e.preventDefault(); all[(i + 1) % all.length]?.focus() }
    else if (e.key === 'ArrowUp') { e.preventDefault(); all[(i - 1 + all.length) % all.length]?.focus() }
    else if (e.key === 'Home') { e.preventDefault(); all[0]?.focus() }
    else if (e.key === 'End') { e.preventDefault(); all[all.length - 1]?.focus() }
  }

  return (
    <div ref={ref} role="menu" aria-label="Power options" onKeyDown={onKey}
      className={`absolute z-50 flex w-80 flex-col gap-0.5 rounded-2xl border border-[rgba(127,178,255,0.18)] bg-[rgba(10,24,56,0.94)] p-2 text-[#E8EEFA] shadow-[0_24px_60px_rgba(0,0,0,0.5)] backdrop-blur-[24px] ${className}`}>
      {user && (
        <>
          <div className="flex items-center gap-3 px-3 pt-2.5 pb-3.5">
            <Avatar name={user} size={40} font={16} />
            <span className="flex flex-col gap-0.5">
              <span className="text-[15px] font-semibold">{user}</span>
              <span className="text-xs text-[#8FA3C8]">{uptimeLabel(typeof performance !== 'undefined' ? performance.now() : 0)}</span>
            </span>
          </div>
          <div className="mx-2 mb-1 h-px bg-[rgba(127,178,255,0.12)]" />
        </>
      )}
      {items.map((it) => (
        <div key={it.label} className="contents">
          {it.sep && <div role="separator" className="mx-2 my-1 h-px bg-[rgba(127,178,255,0.12)]" />}
          <button type="button" role="menuitem" onClick={() => { onClose(); it.run() }}
            className="group flex cursor-pointer items-center gap-3.5 rounded-[10px] px-3 py-[11px] text-left outline-none hover:bg-[rgba(31,107,255,0.22)] focus:bg-[rgba(31,107,255,0.22)] focus:outline-none">
            <Icon d={it.d} className="text-[#C9D6EE] group-hover:text-[#7FB2FF] group-focus:text-[#7FB2FF]" />
            <span className="flex-1 text-sm font-medium group-hover:text-white group-focus:text-white">{it.label}</span>
            {it.key && <span className={`text-[11px] text-[#8FA3C8] ${mono}`}>{it.key}</span>}
          </button>
        </div>
      ))}
    </div>
  )
}

export function ShutdownConfirm({ onCancel, seconds = SHUTDOWN_SECONDS }: { onCancel: () => void; seconds?: number }) {
  const [secs, setSecs] = useState(seconds)
  const [pending, setPending] = useState(0)
  const [installUpdates, setInstallUpdates] = useState(true)
  const [busy, setBusy] = useState<string | null>(null)
  const ref = useRef<HTMLDivElement>(null)
  const done = useRef(false)

  // Pending package updates, from the package service (nothing shown when it can't tell).
  useEffect(() => {
    let live = true
    void os.pkgCheckUpdates().then((r) => { if (live && r.ok) setPending(r.value.packages.length + r.value.flatpaks.length) }).catch(() => {})
    return () => { live = false }
  }, [])

  const act = async (action: 'shutdown' | 'restart') => {
    if (done.current) return
    done.current = true
    if (installUpdates && pending > 0) {
      setBusy('Installing updates…')
      const r = await os.pkgApplyUpdate()
      if (r.ok) await new Promise<void>((resolve) => {
        const off = os.onPkgJob((e) => { if (e.job === r.value && e.kind === 'finished') { off(); resolve() } })
      })
    }
    setBusy(action === 'shutdown' ? 'Shutting down…' : 'Restarting…')
    await os.power(action)
  }
  const actRef = useRef(act)
  actRef.current = act

  useEffect(() => {
    if (busy) return
    if (secs <= 0) { void actRef.current('shutdown'); return }
    const t = setTimeout(() => setSecs((s) => s - 1), 1000)
    return () => clearTimeout(t)
  }, [secs, busy])

  useEffect(() => {
    ref.current?.querySelector<HTMLElement>('[data-autofocus]')?.focus()
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape' && !done.current) onCancel() }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onCancel])

  const btn = 'cursor-pointer rounded-[10px] border border-[rgba(127,178,255,0.25)] px-[22px] py-3 text-[15px] font-medium text-[#E8EEFA] hover:bg-white/5 disabled:cursor-default disabled:opacity-60'
  return (
    <div className="fixed inset-0 z-[60] flex items-center justify-center bg-[rgba(2,6,16,0.62)] p-4 font-sans backdrop-blur-[8px]">
      <div ref={ref} role="alertdialog" aria-modal="true" aria-labelledby="sd-title" aria-describedby="sd-desc"
        className="flex w-[520px] max-w-full flex-col gap-[22px] rounded-[20px] border border-[rgba(127,178,255,0.18)] bg-[#0C1E46] p-8 text-[#E8EEFA] shadow-[0_30px_80px_rgba(0,0,0,0.6)]">
        <div className="flex items-center gap-[18px]">
          <div className="relative h-16 w-16 shrink-0">
            <svg width="64" height="64" viewBox="0 0 64 64" aria-hidden="true">
              <circle cx="32" cy="32" r="28" fill="none" stroke="rgba(127,178,255,0.15)" strokeWidth="5" />
              <circle cx="32" cy="32" r="28" fill="none" stroke="#1F6BFF" strokeWidth="5" strokeLinecap="round" strokeDasharray={ringDash(secs, seconds)} transform="rotate(-90 32 32)" />
            </svg>
            <span className={`absolute inset-0 flex items-center justify-center text-xl font-medium ${mono}`} aria-hidden="true">{secs}</span>
          </div>
          <div className="flex flex-col gap-1">
            <h2 id="sd-title" className="m-0 text-[22px] font-bold">Shut down now?</h2>
            <span id="sd-desc" className="text-sm text-[#8FA3C8]" aria-live={busy ? 'polite' : 'off'}>{busy ?? `Shutting down automatically in ${secs} seconds.`}</span>
          </div>
        </div>
        {pending > 0 && (
          <label className="flex cursor-pointer items-center gap-2.5 text-sm text-[#C9D6EE]">
            <input type="checkbox" checked={installUpdates} disabled={!!busy} onChange={(e) => setInstallUpdates(e.target.checked)} className="h-[18px] w-[18px] accent-[#1F6BFF]" />
            Install {pending} pending update{pending === 1 ? '' : 's'} before shutting down
          </label>
        )}
        <div className="flex justify-end gap-3">
          <button type="button" disabled={!!busy} onClick={onCancel} data-autofocus className={btn}>Cancel</button>
          <button type="button" disabled={!!busy} onClick={() => void act('restart')} className={btn}>Restart</button>
          <button type="button" disabled={!!busy} onClick={() => void act('shutdown')}
            className="cursor-pointer rounded-[10px] bg-[#D9452B] px-6 py-3 text-[15px] font-semibold text-white shadow-[0_8px_24px_rgba(217,69,43,0.35)] hover:bg-[#E5563C] disabled:cursor-default disabled:opacity-60">Shut down</button>
        </div>
      </div>
    </div>
  )
}

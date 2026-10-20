// Dark navy pieces shared by Settings, update and device screens (boot-install boards: Set*, Upd*, Hw*, U*, H*).
import { useEffect, useId, useRef, useState, type ReactNode } from 'react'
import { t } from '../i18n'
import { createPortal } from 'react-dom'
import { AnimatedProgress, type ProgressTone } from './AnimatedProgress'

export const C = {
  // Theme variables (index.css --ws-g-*): dark values by default, light ones under Settings › Appearance › Light.
  ink: 'var(--ws-g-ink)', soft: 'var(--ws-g-soft)', muted: 'var(--ws-g-muted)', dim: 'var(--ws-g-muted)', blue: '#1F6BFF', link: 'var(--ws-g-link)', cyan: 'var(--ws-g-cyan)',
  green: 'var(--ws-g-green)', amber: 'var(--ws-g-amber)', red: 'var(--ws-g-red)', dialog: 'var(--ws-g-dialog)',
}
export const card = 'rounded-[14px] border border-[rgba(127,178,255,0.12)] bg-[rgba(14,32,72,0.6)]'
export const heroCard = 'rounded-[14px] border border-[rgba(127,178,255,0.14)] bg-[rgba(14,32,72,0.7)]'
export const rowLine = 'border-t border-[rgba(127,178,255,0.1)] first:border-t-0'
export const btnGhost = 'inline-flex cursor-pointer items-center justify-center whitespace-nowrap rounded-[10px] border border-[rgba(127,178,255,0.25)] px-[18px] py-[10px] text-sm font-medium text-[#E8EEFA] hover:bg-white/[0.06] disabled:cursor-default disabled:opacity-50'
export const btnPrimary = 'inline-flex cursor-pointer items-center justify-center whitespace-nowrap rounded-[10px] bg-[#1F6BFF] px-5 py-[10px] text-sm font-semibold text-white hover:bg-[#3A7DFF] disabled:cursor-default disabled:bg-[rgba(31,107,255,0.3)] disabled:text-white/50'
export const linkBtn = 'cursor-pointer rounded text-[13px] text-[#7FB2FF] hover:text-[#B8D4FF]'
export const chip = 'rounded-full bg-[rgba(127,178,255,0.12)] px-2 py-0.5 text-[11px] text-[#C9D6EE]'
export const sectionLabel = 'text-xs uppercase tracking-[0.08em] text-[#8FA3C8]'
export const field = 'h-10 rounded-[9px] border border-[rgba(127,178,255,0.25)] bg-[rgba(4,10,26,0.5)] px-3 text-sm text-[#E8EEFA] outline-none focus:border-[#1F6BFF]'

export function Svg({ d, size = 20, stroke = 'currentColor', width = 2, className }: { d: string; size?: number; stroke?: string; width?: number; className?: string }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke={stroke} strokeWidth={width} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" className={className}>
      <path d={d} />
    </svg>
  )
}

export function Spinner({ size = 14, stroke = C.cyan }: { size?: number; stroke?: string }) {
  return <svg className="ws-spin" width={size} height={size} viewBox="0 0 24 24" fill="none" stroke={stroke} strokeWidth="3" strokeLinecap="round" aria-hidden="true"><path d="M21 12a9 9 0 1 1-9-9" /></svg>
}

/** What a switch's change handler may answer: a failed bridge reply (`ok: false` / `available: false`) or a thrown
 *  error shows the switch's error line; anything else counts as applied. */
export type SwitchResult = void | boolean | { ok?: boolean; available?: boolean; error?: string; reason?: string } | null | undefined
export function switchFailed(r: unknown): boolean {
  return r === false || (!!r && typeof r === 'object' && ((r as { ok?: unknown }).ok === false || (r as { available?: unknown }).available === false))
}

export interface SwitchProps {
  label: string
  checked: boolean
  /** May return a promise: the switch shows "Applying…" until it settles, and an error line if it fails. */
  onChange?: (v: boolean) => SwitchResult | Promise<SwitchResult>
  disabled?: boolean
  /** Waiting for the system (the caller's own busy state); the switch also shows this while its onChange runs. */
  loading?: boolean
  /** Why the setting can't be used here (no hardware, managed, service missing): shown under the switch, which
   *  stays focusable but can't be changed. */
  unavailable?: string
  /** An error the caller already knows about (shown like a failed change). */
  error?: string | null
  small?: boolean
  large?: boolean
  color?: string
  /** Show the On/Off word next to the track (default). */
  stateText?: boolean
}

/** The one Settings switch (#34): role="switch" button with a visible On/Off word, a check mark in the knob when on,
 *  a spinner while applying, a dashed track when unavailable, a 44px hit area, a focus ring (index.css), and an error
 *  line when the change could not be applied. Off uses a bordered track so both states keep 3:1 contrast. */
export function Switch({ label, checked, onChange, disabled, loading, unavailable, error, small, large, color = C.blue, stateText = true }: SwitchProps) {
  const [pending, setPending] = useState(false)
  const [failed, setFailed] = useState<string | null>(null)
  const live = useRef(true)
  useEffect(() => { live.current = true; return () => { live.current = false } }, [])
  const id = useId()
  const w = large ? 50 : small ? 44 : 46, h = large ? 30 : small ? 26 : 28, k = large ? 24 : small ? 20 : 22
  const busy = !!loading || pending
  const blocked = !!unavailable
  const off = disabled || !onChange
  const msg = error ?? failed
  const click = () => {
    if (busy || blocked || off) return
    setFailed(null)
    let r: SwitchResult | Promise<SwitchResult>
    try { r = onChange!(!checked) } catch { setFailed(t('switch.failed')); return }
    if (r && typeof (r as Promise<SwitchResult>).then === 'function') {
      setPending(true)
      ;(r as Promise<SwitchResult>).then((v) => { if (live.current && switchFailed(v)) setFailed(t('switch.failed')) }, () => { if (live.current) setFailed(t('switch.failed')) })
        .finally(() => { if (live.current) setPending(false) })
    } else if (switchFailed(r)) setFailed(t('switch.failed'))
  }
  const word = busy ? t('switch.applying') : blocked ? t('switch.unavailable') : checked ? t('switch.on') : t('switch.off')
  const describe = [blocked ? `${id}-why` : '', msg ? `${id}-err` : ''].filter(Boolean).join(' ') || undefined
  return (
    <span className="inline-flex shrink-0 flex-col items-end gap-1">
      <span className="inline-flex items-center gap-2.5">
        {stateText && <span aria-hidden="true" className={`min-w-[2.5em] text-right text-xs font-medium ${checked && !blocked ? 'text-[#C9D6EE]' : 'text-[#8FA3C8]'}`}>{word}</span>}
        <button type="button" role="switch" aria-checked={checked} aria-label={label} aria-busy={busy || undefined} aria-describedby={describe}
          aria-disabled={blocked || busy || undefined} disabled={off && !blocked} onClick={click} data-state={blocked ? 'unavailable' : busy ? 'loading' : checked ? 'on' : 'off'}
          className={`relative shrink-0 cursor-pointer rounded-full border-2 transition-colors after:absolute after:-inset-[9px] after:content-[''] disabled:cursor-not-allowed disabled:opacity-50 aria-disabled:cursor-not-allowed ${blocked ? 'border-dashed border-[#5E739C]' : checked ? 'border-transparent' : 'border-[#8FA3C8]'}`}
          style={{ width: w, height: h, background: blocked ? 'transparent' : checked ? color : 'rgba(4,10,26,0.55)' }}>
          <span className={`absolute top-1/2 flex -translate-y-1/2 items-center justify-center rounded-full transition-all ${blocked ? 'bg-[#5E739C]' : checked ? 'bg-white' : 'bg-[#C9D6EE]'}`}
            style={{ width: k - 4, height: k - 4, left: checked ? w - k - 2 : 1 }}>
            {busy ? <Spinner size={k - 10} stroke={checked ? color : '#1B2A4A'} />
              : checked && !blocked ? <svg width={k - 10} height={k - 10} viewBox="0 0 24 24" fill="none" stroke={color} strokeWidth="4" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M5 12.5l4.5 4.5L19 7.5" /></svg> : null}
          </span>
        </button>
      </span>
      {blocked && <span id={`${id}-why`} className="max-w-[260px] text-right text-[11px] leading-[1.4] text-[#8FA3C8]">{unavailable}</span>}
      {msg && <span id={`${id}-err`} role="alert" className="max-w-[260px] text-right text-[11px] leading-[1.4] text-[#FF9C8A]">{msg}</span>}
    </span>
  )
}

/** Gradient bar; `value` null = indeterminate. Thin wrapper over the shared AnimatedProgress. */
export function Progress({ value, label, height = 8, shine = true, tone }: { value: number | null; label: string; height?: number; shine?: boolean; tone?: ProgressTone }) {
  return <AnimatedProgress value={value} label={label} height={height} shimmer={shine} tone={tone} />
}

export function Tag({ text, bg, color }: { text: string; bg: string; color: string }) {
  return <span className="rounded-[4px] px-1.5 py-0.5 font-mono text-[10px] font-medium" style={{ background: bg, color }}>{text}</span>
}

/**
 * Modal dialog in the boards' style: dimmed backdrop, #0F2350 card, focus moved in and kept in, Escape closes.
 * Children get the title id through render props.
 */
export function Dialog({ width = 440, onClose, children, label, alert, backdrop = 'rgba(2,6,16,0.55)', className = '' }: {
  width?: number; onClose?: () => void; children: (titleId: string) => ReactNode; label?: string; alert?: boolean; backdrop?: string; className?: string
}) {
  const id = useId()
  const ref = useRef<HTMLDivElement>(null)
  const close = useRef(onClose)
  close.current = onClose
  useEffect(() => {
    const prev = document.activeElement as HTMLElement | null
    const el = ref.current
    ;(el?.querySelector<HTMLElement>('[data-autofocus]') ?? el?.querySelector<HTMLElement>('button:not([disabled]), input:not([disabled]), [href]'))?.focus()
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && close.current) { e.stopPropagation(); close.current() }
      if (e.key !== 'Tab' || !el) return
      const all = Array.from(el.querySelectorAll<HTMLElement>('button:not([disabled]), input:not([disabled]), [href], [tabindex="0"]'))
      if (!all.length) return
      const first = all[0], last = all[all.length - 1]
      if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus() }
      else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus() }
    }
    window.addEventListener('keydown', onKey, true)
    return () => { window.removeEventListener('keydown', onKey, true); prev?.focus?.() }
  }, [])
  // Portalled to <body> so a dialog opened from a toast or a window covers the taskbar too.
  return createPortal(
    <div className="fixed inset-0 z-[70] flex items-center justify-center p-4 font-sans text-[#E8EEFA]" style={{ background: backdrop }}>
      <div ref={ref} role={alert ? 'alertdialog' : 'dialog'} aria-modal="true" aria-labelledby={label ? undefined : id} aria-label={label}
        className={`max-h-full max-w-full overflow-auto rounded-[18px] border border-[rgba(127,178,255,0.2)] bg-[#0F2350] shadow-[0_30px_80px_rgba(0,0,0,0.6)] ${className}`} style={{ width }}>
        {children(id)}
      </div>
    </div>,
    document.body,
  )
}

export const dialogFooter = 'flex items-center justify-end gap-2.5 border-t border-[rgba(127,178,255,0.12)] bg-[rgba(4,10,26,0.35)] px-[18px] py-3.5'

/** Radio card used by the restart and device setup dialogs. */
export function OptionCard({ name, checked, disabled, onPick, title, desc, tag, right }: {
  name: string; checked: boolean; disabled?: boolean; onPick: () => void; title: ReactNode; desc: ReactNode; tag?: ReactNode; right?: ReactNode
}) {
  return (
    <label className={`flex gap-3 rounded-xl border px-3.5 py-3 ${disabled ? 'cursor-default opacity-55' : 'cursor-pointer'}`}
      style={{ borderColor: checked ? C.blue : 'rgba(127,178,255,0.14)', background: checked ? 'rgba(31,107,255,0.12)' : 'transparent' }}>
      <input type="radio" name={name} checked={checked} disabled={disabled} onChange={onPick} className="mt-0.5 h-[18px] w-[18px] shrink-0 accent-[#1F6BFF]" />
      <span className="flex flex-1 flex-col gap-0.5">
        <span className="flex items-center gap-2 text-sm font-semibold">{title}{tag}</span>
        <span className="text-xs text-[#8FA3C8]">{desc}</span>
      </span>
      {right}
    </label>
  )
}

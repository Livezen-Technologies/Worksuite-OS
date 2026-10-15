// Dark navy pieces shared by Settings, update and device screens (boot-install boards: Set*, Upd*, Hw*, U*, H*).
import { useEffect, useId, useRef, type ReactNode } from 'react'
import { createPortal } from 'react-dom'

export const C = {
  ink: '#E8EEFA', soft: '#C9D6EE', muted: '#8FA3C8', dim: '#5E739C', blue: '#1F6BFF', link: '#7FB2FF', cyan: '#18D4F0',
  green: '#5FD39A', amber: '#FFB98A', red: '#FF8A7A', dialog: '#0F2350',
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

/** Board switch: 46×28 track, 22px knob. Real button with role="switch". */
export function Switch({ label, checked, onChange, disabled, small }: { label: string; checked: boolean; onChange?: (v: boolean) => void; disabled?: boolean; small?: boolean }) {
  const w = small ? 44 : 46, h = small ? 26 : 28, k = small ? 20 : 22
  return (
    <button type="button" role="switch" aria-checked={checked} aria-label={label} disabled={disabled || !onChange} onClick={() => onChange?.(!checked)}
      className="relative shrink-0 cursor-pointer rounded-full transition-colors disabled:cursor-default disabled:opacity-60"
      style={{ width: w, height: h, background: checked ? C.blue : 'rgba(127,178,255,0.25)' }}>
      <span className="absolute top-[3px] rounded-full bg-white transition-all" style={{ width: k, height: k, left: checked ? w - k - 3 : 3 }} />
    </button>
  )
}

/** Gradient bar; `value` null = indeterminate shimmer. */
export function Progress({ value, label, height = 8, shine }: { value: number | null; label: string; height?: number; shine?: boolean }) {
  return (
    <div role="progressbar" aria-label={label} aria-valuemin={0} aria-valuemax={100} aria-valuenow={value ?? undefined} aria-valuetext={value == null ? 'In progress' : `${value}%`}
      className="relative overflow-hidden rounded-full bg-[rgba(127,178,255,0.14)]" style={{ height }}>
      <div className="absolute inset-y-0 left-0 overflow-hidden rounded-full bg-[linear-gradient(90deg,#1F6BFF,#18D4F0)]" style={{ width: value == null ? '35%' : `${value}%` }}>
        {(shine || value == null) && <div className="ws-shine absolute inset-y-0 w-[40%] bg-[linear-gradient(90deg,transparent,rgba(255,255,255,0.35),transparent)]" />}
      </div>
    </div>
  )
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

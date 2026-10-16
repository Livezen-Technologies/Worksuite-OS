// Shared pieces of the recovery boards (docs/design/boot-install/project/R1–R6).
import { useEffect, useRef, type KeyboardEvent, type ReactNode } from 'react'
import { Icon, Mark, mono } from '../../components/Ws'
import { t } from '../../i18n'

export const BG_TOP = 'radial-gradient(ellipse 70% 50% at 50% 0%, #0E2A55 0%, #061029 60%, #030816 100%)'
export const BG_CENTER = 'radial-gradient(ellipse 60% 50% at 50% 35%, #0E2A55 0%, #061029 60%, #030816 100%)'

export const ring = 'outline-none focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#7FB2FF]'
export const primary = `cursor-pointer rounded-[10px] bg-[#1F6BFF] px-7 py-3 text-[15px] font-semibold text-white shadow-[0_8px_24px_rgba(31,107,255,0.35)] hover:bg-[#3A7DFF] disabled:cursor-default disabled:opacity-50 disabled:shadow-none disabled:hover:bg-[#1F6BFF] ${ring}`
export const danger = `cursor-pointer rounded-[10px] bg-[#D9452B] px-7 py-3 text-[15px] font-semibold text-white shadow-[0_8px_24px_rgba(217,69,43,0.35)] hover:bg-[#E5563C] disabled:cursor-default disabled:opacity-50 disabled:shadow-none ${ring}`
export const ghost = `cursor-pointer rounded-[10px] border border-[rgba(127,178,255,0.25)] px-[22px] py-3 text-[15px] font-medium text-[#E8EEFA] hover:bg-white/5 disabled:cursor-default disabled:opacity-50 disabled:hover:bg-transparent ${ring}`
export const small = `cursor-pointer rounded-[9px] border border-[rgba(127,178,255,0.25)] px-4 py-[9px] text-[13px] text-[#E8EEFA] hover:bg-white/5 disabled:cursor-default disabled:opacity-50 disabled:hover:bg-transparent ${ring}`
export const link = `cursor-pointer text-[13px] text-[#7FB2FF] underline-offset-2 hover:text-[#B8D4FF] hover:underline ${ring} rounded-sm`

export const RP = {
  repair: 'M14.7 6.3a4 4 0 0 0-5.4 5.4L3 18l3 3 6.3-6.3a4 4 0 0 0 5.4-5.4l-2.5 2.5-2.4-.6-.6-2.4z',
  snapshot: 'M3 12a9 9 0 1 0 2.6-6.4M3 4v5h5M12 8v4l3 2',
  reinstall: 'M12 4v11M7 10l5 5 5-5M4 20h16',
  lock: 'M7 11V7a5 5 0 0 1 10 0v4M5 11h14v10H5z',
  usb: 'M9 3h6v6H9zM6 9h12v12H6z',
  terminal: 'M4 5h16v14H4zM7 9l3 3-3 3M12 15h5',
  wifi: 'M2 9a15 15 0 0 1 20 0M5.5 12.5a10 10 0 0 1 13 0M9 16a5 5 0 0 1 6 0',
  back: 'M15 6l-6 6 6 6',
  check: 'M5 12.5l4.5 4.5L19 7.5',
} as const

export function Page({ children, label, center = false }: { children: ReactNode; label: string; center?: boolean }) {
  return (
    <main aria-label={label} className="relative h-full min-h-[640px] w-full overflow-auto font-sans text-[#E8EEFA]"
      style={{ background: center ? BG_CENTER : BG_TOP, fontFamily: "'IBM Plex Sans', ui-sans-serif, system-ui, sans-serif" }}>
      {children}
    </main>
  )
}

export function Header({ onBack, right, logo = false }: { onBack?: () => void; right?: ReactNode; logo?: boolean }) {
  return (
    <header className="flex h-16 items-center gap-3 border-b border-[rgba(127,178,255,0.1)] px-10">
      {onBack && (
        <button type="button" aria-label={t('rec.backToMenu')} onClick={onBack}
          className={`flex h-9 w-9 cursor-pointer items-center justify-center rounded-[9px] border border-[rgba(127,178,255,0.2)] hover:bg-white/5 ${ring}`}>
          <Icon d={[RP.back]} size={16} stroke="#C9D6EE" />
        </button>
      )}
      {logo && <Mark size={26} hole="#061029" />}
      <span className="text-base font-semibold">{t('rec.title')}</span>
      {right != null && <span className="ml-auto">{right}</span>}
    </header>
  )
}

export function MonoTag({ children }: { children: ReactNode }) {
  return <span className={`${mono} rounded-[5px] bg-[rgba(95,211,154,0.16)] px-[7px] py-0.5 text-[10px] font-medium text-[#5FD39A]`}>{children}</span>
}

export function Footer({ children, className = '' }: { children: ReactNode; className?: string }) {
  return <footer className={`absolute inset-x-0 bottom-0 flex items-center border-t border-[rgba(127,178,255,0.1)] ${className}`}>{children}</footer>
}

/** Modal confirmation: focus starts on Cancel, Tab stays inside, Escape cancels. */
export function Confirm({ title, children, onCancel, actions, busy }: { title: string; children: ReactNode; onCancel: () => void; actions: ReactNode; busy?: boolean }) {
  const ref = useRef<HTMLDivElement>(null)
  useEffect(() => {
    const prev = document.activeElement as HTMLElement | null
    // The page behind is inert while the dialog is open.
    const overlay = ref.current?.parentElement
    const behind = Array.from(overlay?.parentElement?.children ?? []).filter((el) => el !== overlay)
    behind.forEach((el) => el.setAttribute('inert', ''))
    ref.current?.querySelector<HTMLElement>('[data-autofocus]')?.focus()
    return () => { behind.forEach((el) => el.removeAttribute('inert')); prev?.focus() }
  }, [])
  const onKey = (e: KeyboardEvent) => {
    if (e.key === 'Escape' && !busy) { e.stopPropagation(); onCancel() }
    if (e.key !== 'Tab') return
    const all = Array.from(ref.current?.querySelectorAll<HTMLElement>('button:not([disabled]), input:not([disabled])') ?? [])
    if (!all.length) return
    const i = all.indexOf(document.activeElement as HTMLElement)
    if (e.shiftKey && i <= 0) { e.preventDefault(); all[all.length - 1].focus() }
    else if (!e.shiftKey && i === all.length - 1) { e.preventDefault(); all[0].focus() }
  }
  return (
    <div className="fixed inset-0 z-[60] flex items-center justify-center bg-[rgba(2,6,16,0.62)] p-4 backdrop-blur-[8px]">
      <div ref={ref} role="alertdialog" aria-modal="true" aria-labelledby="rc-title" aria-describedby="rc-desc" onKeyDown={onKey}
        className="flex w-[540px] max-w-full flex-col gap-5 rounded-[20px] border border-[rgba(127,178,255,0.18)] bg-[#0C1E46] p-8 text-[#E8EEFA] shadow-[0_30px_80px_rgba(0,0,0,0.6)]">
        <h2 id="rc-title" className="m-0 text-[22px] font-bold">{title}</h2>
        <div id="rc-desc" className="flex flex-col gap-3 text-sm leading-normal text-[#C9D6EE]">{children}</div>
        <div className="flex justify-end gap-3">
          <button type="button" data-autofocus disabled={busy} onClick={onCancel} className={ghost}>{t('common.cancel')}</button>
          {actions}
        </div>
      </div>
    </div>
  )
}

/** Inline notice in the board's info-box style. */
export function Note({ children, tone = 'info', role }: { children: ReactNode; tone?: 'info' | 'warn'; role?: 'status' | 'alert' }) {
  const warn = tone === 'warn'
  return (
    <div role={role} className={`flex items-start gap-3 rounded-xl border px-4 py-3.5 text-[13px] ${warn ? 'border-[rgba(255,138,122,0.35)] bg-[rgba(217,69,43,0.1)] text-[#FFB4A8]' : 'border-[rgba(31,107,255,0.3)] bg-[rgba(31,107,255,0.08)] text-[#C9D6EE]'}`}>
      <Icon size={18} stroke={warn ? '#FFB4A8' : '#7FB2FF'} className="mt-px shrink-0"><circle cx="12" cy="12" r="9" /><path d="M12 11v6M12 7.5h.01" /></Icon>
      <span>{children}</span>
    </div>
  )
}

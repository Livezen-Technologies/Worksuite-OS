// Shared pieces of the navy boot / sign-in / setup look (docs/design/boot-install).
import type { CSSProperties, ReactNode } from 'react'

export const BG = {
  setupCenter: 'radial-gradient(ellipse 70% 60% at 50% 20%, #163B82 0%, #0A1A3D 60%, #060E22 100%)',
  setupTop: 'radial-gradient(ellipse 70% 60% at 50% 0%, #163B82 0%, #0A1A3D 60%, #060E22 100%)',
  greeter: 'radial-gradient(circle at 78% 22%, rgba(24,212,240,0.22) 0%, transparent 38%), radial-gradient(circle at 18% 80%, rgba(31,107,255,0.35) 0%, transparent 45%), linear-gradient(160deg, #0B2254 0%, #061029 60%, #030816 100%)',
  lock: 'radial-gradient(circle at 78% 22%, rgba(24,212,240,0.35) 0%, transparent 38%), radial-gradient(circle at 18% 80%, rgba(31,107,255,0.5) 0%, transparent 45%), linear-gradient(160deg, #0E2A66 0%, #071330 60%, #040A1A 100%)',
  desktop: 'radial-gradient(circle at 78% 22%, rgba(24,212,240,0.3) 0%, transparent 38%), radial-gradient(circle at 18% 80%, rgba(31,107,255,0.45) 0%, transparent 45%), linear-gradient(160deg, #0E2A66 0%, #071330 60%, #040A1A 100%)',
} as const

export const AVATAR_GRADIENTS = ['linear-gradient(135deg, #1F6BFF, #18D4F0)', 'linear-gradient(135deg, #7A4FE0, #E0559B)', 'linear-gradient(135deg, #2E9E6A, #18D4F0)']

export const P = {
  arrow: ['M5 12h14', 'M13 6l6 6-6 6'],
  power: ['M12 3v9', 'M6.3 7.3a8 8 0 1 0 11.4 0'],
  wifi: ['M2 9a15 15 0 0 1 20 0', 'M5.5 12.5a10 10 0 0 1 13 0', 'M9 16a5 5 0 0 1 6 0'],
  a11y: ['M5 8l7 1.5L19 8', 'M12 9.5v5l-3 6', 'M12 14.5l3 6'],
  users: ['M2.5 20c1-3.5 3.5-5 6.5-5s5.5 1.5 6.5 5', 'M16 4.5a3.5 3.5 0 0 1 0 7', 'M18 15c2 .6 3 2.2 3.5 5'],
  lock: ['M7 11V7a5 5 0 0 1 10 0v4M5 11h14v10H5z'],
  signOut: ['M15 4h4v16h-4M10 8l-4 4 4 4M6 12h10'],
  sleep: ['M20 14A8 8 0 1 1 10 4a6 6 0 0 0 10 10z'],
  restart: ['M4 12a8 8 0 1 0 2.3-5.7M4 4v4h4'],
  check: ['M5 12.5l4.5 4.5L19 7.5'],
  chevronUp: ['M6 15l6-6 6 6'],
  person: ['M4 21c1.5-4 4.5-6 8-6s6.5 2 8 6'],
  settings: ['M12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6z', 'M19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1z'],
  bell: ['M18 8a6 6 0 0 0-12 0c0 7-3 9-3 9h18s-3-2-3-9', 'M13.7 21a2 2 0 0 1-3.4 0'],
  close: ['M6 6l12 12', 'M18 6L6 18'],
  alert: ['M12 8v5', 'M12 16.5v.5', 'M10.3 3.9L1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0z'],
} as const

export function Icon({ d, size = 20, stroke = 'currentColor', width = 2, className, children }: { d?: readonly string[]; size?: number; stroke?: string; width?: number; className?: string; children?: ReactNode }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke={stroke} strokeWidth={width} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" className={className}>
      {d?.map((p) => <path key={p} d={p} />)}
      {children}
    </svg>
  )
}

/** The WorkSuite mark from the boards (blue square, cyan steps). */
export function Mark({ size = 96, hole = '#0D2353' }: { size?: number; hole?: string }) {
  return (
    <svg width={size} height={size} viewBox="0 0 60 60" aria-hidden="true">
      <rect x="20" y="0" width="40" height="40" rx="3" fill="#1F6BFF" />
      <rect x="20" y="20" width="20" height="20" fill={hole} />
      <rect x="0" y="20" width="20" height="20" rx="3" fill="#18D4F0" />
      <rect x="20" y="40" width="20" height="20" rx="3" fill="#18D4F0" />
    </svg>
  )
}

/** Setup progress: done steps green, current a cyan pill, the rest dim. */
export function StepDots({ step, total = 5 }: { step: number; total?: number }) {
  return (
    <div className="flex gap-2" aria-hidden="true">
      {Array.from({ length: total }, (_, i) => (
        <span key={i} className="h-1.5 rounded-[3px]" style={{ width: i === step ? 24 : 6, background: i < step ? '#5FD39A' : i === step ? '#18D4F0' : 'rgba(127,178,255,0.3)' }} />
      ))}
    </div>
  )
}

export function initials(name: string) {
  const parts = name.trim().split(/\s+/).filter(Boolean)
  if (!parts.length) return '?'
  return (parts.length > 1 ? parts[0][0] + parts[1][0] : parts[0][0]).toUpperCase()
}

export function Avatar({ name, size, font, bg = AVATAR_GRADIENTS[0], style, children }: { name: string; size: number; font: number; bg?: string; style?: CSSProperties; children?: ReactNode }) {
  return (
    <span className="flex shrink-0 items-center justify-center rounded-full font-semibold text-white" style={{ width: size, height: size, fontSize: font, background: bg, ...style }}>
      {children ?? initials(name)}
    </span>
  )
}

/** Translucent square icon button used on the greeter and lock screens. */
export const glassBtn = 'flex h-11 w-11 cursor-pointer items-center justify-center rounded-xl border border-white/10 bg-[rgba(8,20,48,0.5)] text-white hover:bg-[rgba(8,20,48,0.75)]'
export const primaryBtn = 'cursor-pointer rounded-[10px] bg-[#1F6BFF] px-7 py-3 text-[15px] font-semibold text-white shadow-[0_8px_24px_rgba(31,107,255,0.35)] hover:bg-[#3A7DFF] disabled:cursor-default disabled:opacity-60'
export const ghostBtn = 'cursor-pointer rounded-[10px] border border-[rgba(127,178,255,0.25)] px-6 py-3 text-[15px] font-medium text-[#E8EEFA] hover:bg-white/5 disabled:cursor-default disabled:opacity-60'
export const mono = "font-['IBM_Plex_Mono',ui-monospace,monospace]"

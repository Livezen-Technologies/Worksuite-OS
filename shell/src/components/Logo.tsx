// WorkSuite OS mark: the app icon's light tile (branding/icons/worksuite.svg), drawn by Ws.tsx's Mark.
import { Mark } from './Ws'

const NAVY = '#001842'

/** The mark on its own; `onDark` is kept for callers, the light tile reads on either ground. */
export function LogoMark({ height = 28, label }: { onDark?: boolean; height?: number; label?: string }) {
  return <Mark size={height} label={label} />
}

/** OS icon: the mark's tile (app icon, About, installer). */
export function AppIcon({ size = 64, label }: { size?: number; label?: string }) {
  return <Mark size={size} label={label} />
}

/**
 * Horizontal lockup: symbol · "worksuite" · divider · "OS". The canvas uses an image wordmark that couldn't be
 * exported here, so the word is set in text until the wordmark asset is added under public/.
 */
export function Lockup({ onDark = false, height = 28 }: { onDark?: boolean; height?: number }) {
  const ink = onDark ? '#E2E8F0' : NAVY
  const fs = Math.round(height * 0.62)
  return (
    <span role="img" aria-label="WorkSuite OS" className="inline-flex items-center" style={{ gap: height * 0.35 }}>
      <LogoMark onDark={onDark} height={height} />
      <span aria-hidden="true" style={{ fontSize: fs, fontWeight: 700, color: ink, letterSpacing: '-0.01em', lineHeight: 1 }}>worksuite</span>
      <span aria-hidden="true" style={{ width: 1.5, height: fs * 0.95, background: onDark ? '#334155' : '#cbd5e1' }} />
      <span aria-hidden="true" style={{ fontSize: fs, fontWeight: 500, color: ink, letterSpacing: '0.02em', lineHeight: 1 }}>OS</span>
    </span>
  )
}

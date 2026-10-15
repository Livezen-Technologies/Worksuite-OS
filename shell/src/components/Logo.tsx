// WorkSuite OS mark, concept A "Foundation" (WorkSuite OS — Logo canvas): three cells on a base bar.
// On dark grounds the inner cell and base switch to their dark-ground colours, as in the lockup spec.

const BLUE = '#0A6CFF'
const CYAN = '#00DAF2'
const NAVY = '#001842'

export function LogoMark({ onDark = false, height = 28, label }: { onDark?: boolean; height?: number; label?: string }) {
  const a11y = label ? { role: 'img', 'aria-label': label } : { 'aria-hidden': true }
  return (
    <svg {...a11y} width={(height * 30) / 38} height={height} viewBox="0 0 30 38" className="shrink-0">
      <rect x="10" y="0" width="20" height="20" fill={BLUE} />
      <rect x="0" y="10" width="10" height="10" fill={CYAN} />
      <rect x="10" y="10" width="10" height="10" fill={onDark ? '#0B2A66' : NAVY} />
      <rect x="10" y="20" width="10" height="10" fill={CYAN} />
      <rect x="0" y="33" width="30" height="5" rx="2.5" fill={onDark ? '#E2E8F0' : NAVY} />
    </svg>
  )
}

/** OS icon: the mark on a navy rounded tile (app icon, About, installer). */
export function AppIcon({ size = 64, label }: { size?: number; label?: string }) {
  const a11y = label ? { role: 'img', 'aria-label': label } : { 'aria-hidden': true }
  return (
    <svg {...a11y} width={size} height={size} viewBox="0 0 64 64" className="shrink-0">
      <rect width="64" height="64" rx="14" fill={NAVY} />
      <rect x="27" y="10" width="20" height="20" fill={BLUE} />
      <rect x="17" y="20" width="10" height="10" fill={CYAN} />
      <rect x="27" y="20" width="10" height="10" fill="#0B2A66" />
      <rect x="27" y="30" width="10" height="10" fill={CYAN} />
      <rect x="17" y="45" width="30" height="5" rx="2.5" fill="#E2E8F0" />
    </svg>
  )
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

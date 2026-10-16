// Shared progress bar from the boot-install boards (U3/U5/H5/R3/FM4/G08/S6a): track rgba(127,178,255,.14),
// blue→cyan gradient fill eased toward the value, a white shimmer sweep (ws-shimmer) over the filled part,
// and a sliding segment when the value is unknown. Reduced motion (setting or OS) = instant fill, no sweep.
import { useEffect, useRef, useState, type CSSProperties } from 'react'
import { motionReduced, useA11y } from '../lib/a11y'
import { formatNumber, t } from '../i18n'

export type ProgressTone = 'default' | 'success' | 'error' | 'paused'

const FILL: Record<ProgressTone, string> = {
  default: 'linear-gradient(90deg,#1F6BFF,#18D4F0)',
  success: 'linear-gradient(90deg,#2FB57A,#5FD39A)',
  error: 'linear-gradient(90deg,#E5604F,#FF8A7A)',
  paused: 'linear-gradient(90deg,#E89A62,#FFB98A)',
}

export function useReducedMotion(): boolean {
  return motionReduced(useA11y())
}

/** Tweens a number toward `target` (count-up); jumps straight to it under reduced motion. */
export function useCountUp(target: number | null | undefined, ms = 600): number | null {
  const reduced = useReducedMotion()
  const [shown, setShown] = useState<number | null>(target ?? null)
  const from = useRef(target ?? 0)
  useEffect(() => {
    if (target == null) { setShown(null); return }
    if (reduced || typeof requestAnimationFrame !== 'function') { from.current = target; setShown(target); return }
    const start = performance.now(), a = from.current
    let id = 0
    const step = (now: number) => {
      const k = Math.min(1, (now - start) / ms), e = 1 - Math.pow(1 - k, 3)
      const v = Math.round(a + (target - a) * e)
      from.current = v
      setShown(v)
      if (k < 1) id = requestAnimationFrame(step)
    }
    id = requestAnimationFrame(step)
    return () => cancelAnimationFrame(id)
  }, [target, reduced, ms])
  return shown
}

/** A percentage that counts up toward `value`. */
export function CountUp({ value, suffix = '%', render }: { value: number | null | undefined; suffix?: string; render?: (formatted: string) => string }) {
  const v = useCountUp(value)
  if (v == null) return null
  return <>{render ? render(formatNumber(v)) : `${formatNumber(v)}${suffix}`}</>
}

export function AnimatedProgress({ value, label, height = 8, tone = 'default', shimmer = true, valueText, decorative, className = '', trackColor = 'rgba(127,178,255,0.14)', style }: {
  /** 0–100, or null/undefined for indeterminate. */
  value: number | null | undefined
  label?: string
  height?: number
  tone?: ProgressTone
  shimmer?: boolean
  valueText?: string
  /** Visual meter only (a sibling already announces the value). */
  decorative?: boolean
  className?: string
  trackColor?: string
  style?: CSSProperties
}) {
  const reduced = useReducedMotion()
  const indeterminate = value == null || Number.isNaN(value)
  const pct = indeterminate ? 0 : Math.max(0, Math.min(100, value))
  const busy = indeterminate || (tone === 'default' && pct < 100)
  const sweep = !reduced && shimmer && busy
  const a11y = decorative ? { 'aria-hidden': true as const } : {
    role: 'progressbar', 'aria-label': label, 'aria-valuemin': 0, 'aria-valuemax': 100,
    'aria-valuenow': indeterminate ? undefined : Math.round(pct),
    'aria-valuetext': valueText ?? (indeterminate ? t('progress.working') : `${Math.round(pct)}%`),
    'aria-busy': busy,
  }
  return (
    <div {...a11y} data-indeterminate={indeterminate || undefined} data-reduced={reduced || undefined} data-tone={tone}
      className={`relative overflow-hidden rounded-full ${className}`} style={{ height, background: trackColor, ...style }}>
      {indeterminate ? (
        <div data-part="segment" className={`absolute inset-y-0 rounded-full ${reduced ? 'left-0 w-full opacity-40' : 'ws-indeterminate w-[35%]'}`} style={{ background: FILL[tone] }} />
      ) : (
        <div data-part="fill" className="absolute inset-y-0 left-0 overflow-hidden rounded-full"
          style={{ width: `${pct}%`, background: FILL[tone], transition: reduced ? 'none' : 'width 600ms cubic-bezier(0.22,1,0.36,1), background 300ms ease' }}>
          {sweep && <div data-part="shimmer" className="ws-shine absolute inset-y-0 w-[40%] bg-[linear-gradient(90deg,transparent,rgba(255,255,255,0.35),transparent)]" />}
        </div>
      )}
    </div>
  )
}

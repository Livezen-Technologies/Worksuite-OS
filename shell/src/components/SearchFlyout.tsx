// Taskbar search (#29): a floating panel above the taskbar's search control instead of a full-screen page. The input
// has the focus as soon as it opens; Escape, the Esc button or a click outside closes it, and the person goes back to
// what they were doing (the app that had the focus, else the taskbar control).
import { useEffect, useRef } from 'react'
import GlobalSearch, { type GlobalSearchProps } from './GlobalSearch'

export const SEARCH_FLYOUT_ID = 'ws-search'
const WIDTH = 560
const GUTTER = 12

/** Left edge of the panel: over the control, kept on screen. */
export function flyoutLeft(anchorLeft: number, viewport: number, width = WIDTH): number {
  return Math.max(GUTTER, Math.min(anchorLeft, viewport - width - GUTTER))
}

export interface SearchFlyoutProps extends Omit<GlobalSearchProps, 'compact' | 'id'> {
  /** Left edge of the taskbar control (px). */
  anchorLeft: number
  /** Selector of the control that opened it: a click there toggles rather than counting as "outside". */
  toggleSelector: string
}

export default function SearchFlyout({ anchorLeft, toggleSelector, onClose, ...search }: SearchFlyoutProps) {
  const ref = useRef<HTMLDivElement>(null)
  const close = useRef(onClose)
  close.current = onClose
  useEffect(() => {
    const down = (e: PointerEvent | MouseEvent) => {
      const t = e.target as Element | null
      if (!ref.current || (t && (ref.current.contains(t) || t.closest?.(toggleSelector)))) return
      close.current()
    }
    window.addEventListener('mousedown', down)
    return () => window.removeEventListener('mousedown', down)
  }, [toggleSelector])
  const vw = typeof window === 'undefined' ? 1280 : window.innerWidth
  return (
    <div ref={ref} className="ws-rise absolute bottom-[60px] z-40 max-w-[calc(100%-24px)]" style={{ left: flyoutLeft(anchorLeft, vw, Math.min(WIDTH, vw - 2 * GUTTER)) }}>
      <GlobalSearch {...search} onClose={onClose} compact id={SEARCH_FLYOUT_ID} />
    </div>
  )
}

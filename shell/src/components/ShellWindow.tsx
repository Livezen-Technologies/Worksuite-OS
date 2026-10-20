import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import BIcon from './BIcon'
import { t } from '../i18n'
import type { WindowApp } from '../screens/types'
import {
  EDGES, MIN_SIZE, TITLE_BAR, activeWin, clampRect, defaultRect, edgeCursor, moveRect, resizeRect,
  type Edge, type Rect, type ShellWin, type ShellWins, type Size,
} from '../lib/shellWindows'

/** What App.tsx shows in each shell window. */
export interface ShellWindowContent { title: string; icon: string; closeLabel?: string; body: React.ReactNode }
export interface ShellWindowActions {
  focus: (app: WindowApp) => void
  close: (app: WindowApp) => void
  minimize: (app: WindowApp) => void
  toggleMax: (app: WindowApp) => void
  move: (app: WindowApp, r: Rect) => void
}

/** The taskbar icon of each shell app (BIcon names). */
export const SHELL_APP_ICON: Record<WindowApp, string> = { files: 'folder', settings: 'settings', appcenter: 'grid', monitor: 'monitor', snip: 'scissors' }
// Stable DOM order (stacking is z-index): moving nodes on every raise would drop the keyboard focus inside them.
const DOM_ORDER: WindowApp[] = ['files', 'settings', 'appcenter', 'monitor', 'snip']

/** The desktop work area with the shell's windows in it (lib/shellWindows.ts has the rules). The area itself lets clicks
 *  through to the desktop; only the windows take them. */
export function ShellWindowsHost({ wins, content, actions }: { wins: ShellWins; content: (app: WindowApp) => ShellWindowContent; actions: ShellWindowActions }) {
  const ref = useRef<HTMLDivElement>(null)
  const [area, setArea] = useState<Size>(() => ({ w: typeof window === 'undefined' ? 1280 : window.innerWidth, h: typeof window === 'undefined' ? 720 : window.innerHeight - 52 }))
  useLayoutEffect(() => {
    const el = ref.current
    if (!el) return
    const measure = () => { if (el.clientWidth > 0 && el.clientHeight > 0) setArea((a) => (a.w === el.clientWidth && a.h === el.clientHeight ? a : { w: el.clientWidth, h: el.clientHeight })) }
    measure()
    if (typeof ResizeObserver === 'undefined') { window.addEventListener('resize', measure); return () => window.removeEventListener('resize', measure) }
    const ro = new ResizeObserver(measure)
    ro.observe(el)
    return () => ro.disconnect()
  }, [])
  const active = activeWin(wins)
  const ordered = [...wins].sort((a, b) => DOM_ORDER.indexOf(a.app) - DOM_ORDER.indexOf(b.app))
  return (
    <div ref={ref} data-testid="shell-work-area" className="pointer-events-none relative h-full w-full">
      {ordered.map((w) => (
        <ShellWindow key={w.app} win={w} z={wins.indexOf(w) + 1} index={wins.indexOf(w)} active={active === w.app} area={area} content={content(w.app)} actions={actions} />
      ))}
    </div>
  )
}

type Drag = { kind: 'move' | Edge; id: number; x0: number; y0: number; start: Rect; restoreFromMax: boolean; moved: boolean }

/** One Windows 11-style window: title bar (drag to move, double-click to maximize or restore, drag to the top edge to
 *  maximize), Minimize / Maximize-Restore / Close at the top right, edges and corners to resize down to the minimum. */
export function ShellWindow({ win, z, index, active, area, content, actions }: {
  win: ShellWin; z: number; index: number; active: boolean; area: Size; content: ShellWindowContent; actions: ShellWindowActions
}) {
  const { app } = win
  const min = MIN_SIZE[app]
  const rect = clampRect(win.rect ?? defaultRect(app, area, index), area, min)
  const drag = useRef<Drag | null>(null)
  const [dragging, setDragging] = useState(false)
  const ownRef = useRef<HTMLDivElement>(null)
  // Raised with the keyboard too (Tab into it), and the focus goes into a window that is restored or opened.
  useEffect(() => { if (active && !win.minimized && ownRef.current && !ownRef.current.contains(document.activeElement)) ownRef.current.focus({ preventScroll: true }) }, [active, win.minimized])

  const begin = (kind: Drag['kind']) => (e: React.PointerEvent) => {
    if (e.button !== 0) return
    if (kind === 'move' && (e.target as HTMLElement).closest('button')) return
    e.preventDefault()
    actions.focus(app)
    ;(e.currentTarget as HTMLElement).setPointerCapture?.(e.pointerId)
    drag.current = { kind, id: e.pointerId, x0: e.clientX, y0: e.clientY, start: rect, restoreFromMax: kind === 'move' && win.maximized, moved: false }
    setDragging(true)
  }
  const onMove = (e: React.PointerEvent) => {
    const d = drag.current
    if (!d || d.id !== e.pointerId) return
    const dx = e.clientX - d.x0, dy = e.clientY - d.y0
    if (!d.moved && Math.abs(dx) < 4 && Math.abs(dy) < 4) return
    d.moved = true
    if (d.kind === 'move') {
      if (d.restoreFromMax) {
        // Dragging a maximized window restores it under the pointer, at the same place along its title bar (Windows 11).
        const host = ownRef.current?.parentElement?.getBoundingClientRect()
        const px = e.clientX - (host?.left ?? 0)
        const ratio = Math.min(1, Math.max(0, d.x0 / Math.max(1, area.w)))
        d.start = clampRect({ ...rect, x: px - rect.w * ratio, y: 0 }, area, min)
        d.x0 = e.clientX; d.y0 = e.clientY; d.restoreFromMax = false
        actions.move(app, d.start)
        return
      }
      actions.move(app, moveRect(d.start, dx, dy, area, min))
    } else if (!win.maximized) actions.move(app, resizeRect(d.start, d.kind, dx, dy, area, min))
  }
  const end = (e: React.PointerEvent) => {
    const d = drag.current
    if (!d || d.id !== e.pointerId) return
    drag.current = null
    setDragging(false)
    // Dropped against the top edge of the work area: maximize (Windows 11 snap).
    if (d.kind === 'move' && d.moved && !win.maximized) {
      const host = ownRef.current?.parentElement?.getBoundingClientRect()
      if (host && e.clientY - host.top <= 2) actions.toggleMax(app)
    }
  }

  const box = win.maximized ? { left: 0, top: 0, width: area.w, height: area.h } : { left: rect.x, top: rect.y, width: rect.w, height: rect.h }
  const maxLabel = win.maximized ? t('window.restore') : t('window.maximize')
  return (
    <div ref={ownRef} tabIndex={-1} hidden={win.minimized} data-shell-window={app} data-active={active} data-maximized={win.maximized}
      onPointerDownCapture={() => { if (!active) actions.focus(app) }} onFocusCapture={() => { if (!active) actions.focus(app) }}
      onKeyDown={(e) => {
        // Like Windows: Super+Up maximizes, Super+Down restores and then minimizes (the shell has the keyboard here).
        if (!e.metaKey) return
        if (e.key === 'ArrowUp' && !win.maximized) { e.preventDefault(); actions.toggleMax(app) }
        else if (e.key === 'ArrowDown') { e.preventDefault(); if (win.maximized) actions.toggleMax(app); else actions.minimize(app) }
      }}
      className={`ws-win pointer-events-auto absolute flex flex-col overflow-hidden outline-none ${dragging ? 'select-none' : ''}`}
      style={{ ...box, zIndex: z, minWidth: Math.min(min.w, area.w), minHeight: Math.min(min.h, area.h) }}>
      <div className="ws-win-bar flex shrink-0 items-center" style={{ height: TITLE_BAR, touchAction: 'none' }}
        onPointerDown={begin('move')} onPointerMove={onMove} onPointerUp={end} onPointerCancel={end}
        onDoubleClick={(e) => { if (!(e.target as HTMLElement).closest('button')) actions.toggleMax(app) }}>
        <span aria-hidden="true" className="flex w-10 shrink-0 items-center justify-center"><BIcon name={content.icon} size={15} /></span>
        <span className="min-w-0 flex-1 truncate text-[12px]">{content.title}</span>
        <div className="flex h-full shrink-0">
          <button type="button" className="ws-win-btn cursor-pointer" aria-label={t('window.minimize')} title={t('window.minimize')} onClick={() => actions.minimize(app)}>
            <svg aria-hidden="true" width="10" height="10" viewBox="0 0 10 10"><path d="M0 5.5h10" stroke="currentColor" strokeWidth="1" /></svg>
          </button>
          <button type="button" className="ws-win-btn cursor-pointer" aria-label={maxLabel} title={maxLabel} onClick={() => actions.toggleMax(app)}>
            {win.maximized
              ? <svg aria-hidden="true" width="10" height="10" viewBox="0 0 10 10" fill="none" stroke="currentColor" strokeWidth="1"><rect x="0.5" y="2.5" width="7" height="7" rx="1" /><path d="M2.5 2.5V1.5a1 1 0 0 1 1-1h5a1 1 0 0 1 1 1v5a1 1 0 0 1-1 1H7.5" /></svg>
              : <svg aria-hidden="true" width="10" height="10" viewBox="0 0 10 10" fill="none" stroke="currentColor" strokeWidth="1"><rect x="0.5" y="0.5" width="9" height="9" rx="1" /></svg>}
          </button>
          <button type="button" data-close="" className="ws-win-btn cursor-pointer" aria-label={content.closeLabel ?? t('common.close')} title={t('common.close')} onClick={() => actions.close(app)}>
            <svg aria-hidden="true" width="10" height="10" viewBox="0 0 10 10"><path d="M0.5 0.5l9 9M9.5 0.5l-9 9" stroke="currentColor" strokeWidth="1" /></svg>
          </button>
        </div>
      </div>
      <div className="relative flex min-h-0 grow">{content.body}</div>
      {!win.maximized && EDGES.map((edge) => (
        <div key={edge} aria-hidden="true" data-edge={edge} onPointerDown={begin(edge)} onPointerMove={onMove} onPointerUp={end} onPointerCancel={end}
          className="absolute" style={{ ...EDGE_BOX[edge], cursor: edgeCursor(edge), touchAction: 'none', zIndex: 2 }} />
      ))}
    </div>
  )
}

// Resize grips inside the frame: 6 px along the sides and bottom, 12 px squares at the bottom corners; the top edge and
// its corners are 4 px deep so they stay clear of the title bar's buttons.
const G = 6, C = 12, T = 4
const EDGE_BOX: Record<Edge, React.CSSProperties> = {
  n: { top: 0, left: C, right: C, height: T }, s: { bottom: 0, left: C, right: C, height: G },
  w: { left: 0, top: C, bottom: C, width: G }, e: { right: 0, top: C, bottom: C, width: G },
  nw: { left: 0, top: 0, width: C, height: T }, ne: { right: 0, top: 0, width: C, height: T },
  sw: { left: 0, bottom: 0, width: C, height: C }, se: { right: 0, bottom: 0, width: C, height: C },
}

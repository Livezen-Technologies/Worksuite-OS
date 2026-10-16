// The snipping overlay (Super+Shift+S, Alt+Print, the Snipping Tool's New): the frozen screen, dimmed, with the
// Windows 11 toolbar on top — Rectangle, Window, Full screen, Freeform — and the selection cut out of the dim layer.
// One per monitor: every shell window (the main desktop and each OutputDesktop) draws it on its own output's frame,
// all lifted over the apps by the main process (electron/capture.ts). The selection is cut out here, in a canvas,
// and only the resulting PNG goes back to be copied.
//
// Keyboard: Tab reaches the toolbar; Enter takes the selection (a centred rectangle to start with), arrows move it,
// Shift+arrows resize it (Ctrl: 10 px steps), F takes the full screen, Esc cancels.
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { captureApi, type SnipMode, type SnipOpen } from '../lib/captureApi'
import { bigEnough, clampRect, luminance, normRect, nudge, pathBounds, scaleRect, snapWindowRect, type Pt, type Rect } from '../lib/snip'
import { t, useT, type MessageKey } from '../i18n'

const MODE_ICON: Record<SnipMode, string> = {
  rect: 'M4 4h16v16H4z',
  window: 'M3 5h18v14H3zM3 9h18',
  full: 'M3 4h18v13H3zM8 21h8M12 17v4',
  free: 'M6 15c-2-3 0-8 5-9s9 2 8 6-6 3-8 6-6 1-5-3z',
}
const SNAP_W = 480

export interface SnipOverlayProps {
  open: SnipOpen
  /** This window's output ('' = the main window: the first frame). */
  output: string
  /** A frame to use instead of asking the main process (tests, preview). */
  frame?: string | null
  /** The selection as a PNG data: URL (default: handed to the main process). */
  onDone?: (png: string) => void
  onCancel?: () => void
}

export default function SnipOverlay({ open, output, frame: given, onDone, onCancel }: SnipOverlayProps) {
  useT()
  const [frame, setFrame] = useState<string | null>(given ?? null)
  const [mode, setMode] = useState<SnipMode>(open.mode)
  const [sel, setSel] = useState<Rect | null>(null)
  const [path, setPath] = useState<Pt[]>([])
  const [hover, setHover] = useState<Rect | null>(null)
  const [busy, setBusy] = useState(false)
  const drag = useRef<Pt | null>(null)
  const img = useRef<HTMLImageElement | null>(null)
  const gray = useRef<{ g: Uint8ClampedArray; w: number; h: number } | null>(null)
  const root = useRef<HTMLDivElement>(null)
  const [vw, vh] = [window.innerWidth, window.innerHeight]

  useEffect(() => {
    if (given !== undefined) { setFrame(given); return }
    let live = true
    void captureApi?.snipFrame(open.id, output).then((f) => { if (live) setFrame(f) })
    return () => { live = false }
  }, [open.id, output, given])

  // The frame as an image (cropping) and a small luminance copy (Window mode's edge search).
  useEffect(() => {
    if (!frame) return
    const im = new Image()
    im.onload = () => {
      img.current = im
      try {
        const s = Math.min(1, SNAP_W / im.naturalWidth)
        const c = document.createElement('canvas')
        c.width = Math.max(1, Math.round(im.naturalWidth * s)); c.height = Math.max(1, Math.round(im.naturalHeight * s))
        const x = c.getContext('2d', { willReadFrequently: true })
        if (!x) return
        x.drawImage(im, 0, 0, c.width, c.height)
        gray.current = { g: luminance(x.getImageData(0, 0, c.width, c.height).data), w: c.width, h: c.height }
      } catch { gray.current = null }
    }
    im.src = frame
  }, [frame])

  useEffect(() => { root.current?.focus() }, [])

  const cancel = useCallback(() => { if (onCancel) onCancel(); else void captureApi?.snipCancel(open.id) }, [onCancel, open.id])

  /** Cut the selection (screen px) out of the frame; freeform: transparent outside the drawn shape. */
  const finish = useCallback((r: Rect, shape?: Pt[]) => {
    const im = img.current
    if (!im || busy) return
    const sx = im.naturalWidth / vw, sy = im.naturalHeight / vh
    const ir = scaleRect(clampRect(r, vw, vh), sx, sy)
    const c = document.createElement('canvas')
    c.width = ir.w; c.height = ir.h
    const x = c.getContext('2d')
    if (!x) return
    if (shape && shape.length > 2) {
      x.beginPath()
      shape.forEach((p, i) => { const px = p.x * sx - ir.x, py = p.y * sy - ir.y; if (i) x.lineTo(px, py); else x.moveTo(px, py) })
      x.closePath()
      x.clip()
    }
    x.drawImage(im, ir.x, ir.y, ir.w, ir.h, 0, 0, ir.w, ir.h)
    const png = c.toDataURL('image/png')
    setBusy(true)
    if (onDone) onDone(png); else void captureApi?.snipDone(open.id, png)
  }, [busy, onDone, open.id, vw, vh])

  const pick = (m: SnipMode) => {
    setMode(m); setSel(null); setPath([]); setHover(null)
    if (m === 'full') finish({ x: 0, y: 0, w: vw, h: vh })
  }

  const pt = (e: React.PointerEvent): Pt => ({ x: e.clientX, y: e.clientY })
  const snapAt = (p: Pt): Rect | null => {
    const gr = gray.current
    if (!gr) return null
    const kx = gr.w / vw, ky = gr.h / vh
    const r = snapWindowRect(gr.g, gr.w, gr.h, p.x * kx, p.y * ky)
    return r && { x: r.x / kx, y: r.y / ky, w: r.w / kx, h: r.h / ky }
  }
  const down = (e: React.PointerEvent) => {
    if (e.button !== 0 || (e.target as HTMLElement).closest('[data-snip-toolbar]')) return
    if (mode === 'window') { const r = snapAt(pt(e)); if (r) finish(r); return }
    if (mode === 'full') { finish({ x: 0, y: 0, w: vw, h: vh }); return }
    ;(e.currentTarget as HTMLElement).setPointerCapture?.(e.pointerId)
    drag.current = pt(e)
    if (mode === 'free') setPath([pt(e)]); else setSel({ ...pt(e), w: 0, h: 0 })
  }
  const move = (e: React.PointerEvent) => {
    if (mode === 'window' && !drag.current) { setHover(snapAt(pt(e))); return }
    if (!drag.current) return
    if (mode === 'free') setPath((p) => [...p, pt(e)])
    else setSel(normRect(drag.current, pt(e)))
  }
  const up = () => {
    if (!drag.current) return
    drag.current = null
    if (mode === 'free') { const b = pathBounds(path); if (bigEnough(b)) finish(b, path); else setPath([]) }
    else if (sel && bigEnough(sel)) finish(sel)
    else setSel(null)
  }
  const key = (e: React.KeyboardEvent) => {
    if (e.key === 'Escape') { e.preventDefault(); cancel(); return }
    if ((e.target as HTMLElement).closest('[data-snip-toolbar]') && e.key !== 'Enter') return
    if (e.key === 'f' || e.key === 'F') { e.preventDefault(); pick('full'); return }
    const cur = sel ?? hover ?? { x: Math.round(vw / 4), y: Math.round(vh / 4), w: Math.round(vw / 2), h: Math.round(vh / 2) }
    if (e.key === 'Enter') { e.preventDefault(); if ((e.target as HTMLElement).closest('[data-snip-toolbar]')) return; finish(cur); return }
    if (e.key.startsWith('Arrow')) { e.preventDefault(); setSel(nudge(cur, e.key, e.shiftKey, e.ctrlKey ? 10 : 1, vw, vh)) }
  }

  const shown = mode === 'window' ? hover : mode === 'free' ? (path.length > 1 ? pathBounds(path) : null) : sel
  const hole = useMemo(() => {
    if (mode === 'free' && path.length > 1) return `M${path.map((p) => `${p.x},${p.y}`).join('L')}Z`
    if (shown && shown.w > 0 && shown.h > 0) return `M${shown.x},${shown.y}h${shown.w}v${shown.h}h${-shown.w}z`
    return ''
  }, [mode, path, shown])
  const im = img.current
  const size = shown && im ? scaleRect(shown, im.naturalWidth / vw, im.naturalHeight / vh) : null
  const modes: SnipMode[] = ['rect', 'window', 'full', 'free']

  return createPortal(
    <div ref={root} tabIndex={-1} role="dialog" aria-modal="true" aria-label={t('snip.overlay')} aria-describedby="ws-snip-help" data-snip-overlay
      className="fixed inset-0 z-[95] cursor-crosshair touch-none select-none outline-none" onPointerDown={down} onPointerMove={move} onPointerUp={up} onKeyDown={key}
      onContextMenu={(e) => e.preventDefault()}>
      {frame ? <img src={frame} alt="" draggable={false} className="pointer-events-none absolute inset-0 h-full w-full" /> : <div className="absolute inset-0 bg-black" />}
      <svg className="pointer-events-none absolute inset-0 h-full w-full" aria-hidden="true">
        <path d={`M0,0H${vw}V${vh}H0Z${hole}`} fillRule="evenodd" fill="rgba(0,0,0,0.45)" />
        {hole && <path d={hole} fill="none" stroke="#FFFFFF" strokeWidth={mode === 'window' ? 3 : 1.5} strokeDasharray={mode === 'free' ? undefined : mode === 'window' ? undefined : '6 4'} />}
      </svg>
      {shown && size && shown.w > 30 && (
        <div aria-hidden="true" className="pointer-events-none absolute rounded-md bg-[rgba(10,24,56,0.9)] px-2 py-1 font-mono text-[11px] text-white"
          style={{ left: Math.min(shown.x, vw - 110), top: shown.y > 30 ? shown.y - 28 : shown.y + shown.h + 6 }}>{`${size.w} × ${size.h}`}</div>
      )}
      <div data-snip-toolbar role="toolbar" aria-label={t('snip.modes')} className="absolute top-4 left-1/2 flex -translate-x-1/2 items-center gap-1 rounded-xl border border-[rgba(127,178,255,0.25)] bg-[rgba(10,24,56,0.96)] p-1.5 text-[#E8EEFA] shadow-[0_16px_40px_rgba(0,0,0,0.5)]"
        onPointerDown={(e) => e.stopPropagation()}>
        {modes.map((m) => (
          <button key={m} type="button" aria-pressed={mode === m} title={t(`snip.mode.${m}` as MessageKey)} onClick={() => pick(m)}
            className={`flex h-10 cursor-pointer items-center gap-2 rounded-lg px-3 text-[13px] ${mode === m ? 'bg-[#1F6BFF] text-white' : 'hover:bg-white/10'}`}>
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinejoin="round" aria-hidden="true"><path d={MODE_ICON[m]} /></svg>
            <span className="max-md:sr-only">{t(`snip.mode.${m}` as MessageKey)}</span>
          </button>
        ))}
        <span aria-hidden="true" className="mx-1 h-6 w-px bg-[rgba(127,178,255,0.25)]" />
        <button type="button" aria-label={t('snip.cancel')} title={t('snip.cancel')} onClick={cancel} className="flex h-10 w-10 cursor-pointer items-center justify-center rounded-lg hover:bg-white/10">
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" aria-hidden="true"><path d="M6 6l12 12M18 6L6 18" /></svg>
        </button>
      </div>
      <p id="ws-snip-help" className="pointer-events-none absolute bottom-6 left-1/2 m-0 -translate-x-1/2 rounded-lg bg-[rgba(10,24,56,0.9)] px-3 py-1.5 text-center text-[13px] text-[#E8EEFA]" aria-live="polite">
        {t(`snip.hint.${mode}` as MessageKey)}
      </p>
    </div>,
    document.body,
  )
}

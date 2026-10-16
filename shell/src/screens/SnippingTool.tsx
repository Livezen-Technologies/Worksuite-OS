// Snipping Tool: "New" (mode and a 3/5/10 s delay) and the editor for a screenshot — crop, pen, highlighter, eraser,
// text, arrow, undo/redo, Copy, Save as PNG or JPEG (Pictures/Screenshots by default) and Show in Files. Opened from
// Start, from the "Screenshot copied — click to edit" toast and after a snip started here. Marks are kept as a list
// (lib/snip.ts) over the untouched screenshot, so undo, redo and the eraser never lose pixels; the image is drawn
// only for Copy and Save. Nothing is uploaded.
import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react'
import type { WindowProps } from './types'
import { captureApi, DELAYS, SNIP_MODES, type SnipMode } from '../lib/captureApi'
import { addOp, commit, eraseAt, extend, HIGHLIGHT_COLORS, newHistory, normRect, outputRect, PEN_COLORS, redo, render, setCrop, undo, drawOp, bigEnough, type Ctx2D, type History, type Op, type Pt, type Rect, type Tool } from '../lib/snip'
import { formatNumber, t, useT, type MessageKey } from '../i18n'
import { Svg, btnGhost, btnPrimary } from '../components/Dk'

const TOOL_ICON: Record<Tool, string> = {
  crop: 'M6 2v14a2 2 0 0 0 2 2h14M18 22V8a2 2 0 0 0-2-2H2',
  pen: 'M12 20h9M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4z',
  highlighter: 'M9 11l-6 6v3h9l3-3M22 12l-4.6 4.6a2 2 0 0 1-2.8 0l-5.2-5.2a2 2 0 0 1 0-2.8L14 4',
  eraser: 'M7 21l-4.3-4.3a1 1 0 0 1 0-1.4l10-10a1 1 0 0 1 1.4 0l5.6 5.6a1 1 0 0 1 0 1.4L13 19M22 21H7M5 11l9 9',
  text: 'M4 7V4h16v3M9 20h6M12 4v16',
  arrow: 'M5 19L19 5M9 5h10v10',
}
const TOOLS: Tool[] = ['crop', 'pen', 'highlighter', 'eraser', 'text', 'arrow']
const TOOL_KEY: Record<string, Tool> = { r: 'crop', p: 'pen', h: 'highlighter', e: 'eraser', t: 'text', a: 'arrow' }
type Shot = { id: number; url: string; file: string | null }

export const OPEN_FILES_EVENT = 'ws:open-files'

export default function SnippingTool({ onClose, shotId = 0, onNew }: WindowProps & { shotId?: number; onNew?: (mode: SnipMode, delay: number) => void }) {
  useT()
  const [shot, setShot] = useState<Shot | null>(null)
  const [loading, setLoading] = useState(!!shotId)
  const [mode, setMode] = useState<SnipMode>('rect')
  const [delay, setDelay] = useState(0)
  const [allowed, setAllowed] = useState<boolean | null>(captureApi ? null : false)
  useEffect(() => {
    void captureApi?.settings().then((s) => { setMode(s.mode); setDelay(s.delay) }).catch(() => undefined)
    void captureApi?.allowed().then(setAllowed).catch(() => setAllowed(false))
  }, [])
  useEffect(() => {
    if (!shotId) { setShot(null); setLoading(false); return }
    let live = true
    setLoading(true)
    void captureApi?.snipImage(shotId).then((s) => { if (live) { setShot(s); setLoading(false) } }).catch(() => setLoading(false))
    return () => { live = false }
  }, [shotId])

  const startNew = () => {
    if (onNew) onNew(mode, delay)
    else void captureApi?.snipStart(mode, delay)
  }

  return (
    <div role="dialog" aria-modal="false" aria-label={t('snip.app')} className="fixed inset-0 z-50 flex flex-col bg-[#0A1A3D] font-sans text-[#E8EEFA]"
      onKeyDown={(e) => { if (e.key === 'Escape' && !document.querySelector('[aria-modal="true"]') && !(e.target as HTMLElement).closest('textarea')) onClose() }}>
      <header className="flex flex-wrap items-center gap-2 border-b border-[rgba(127,178,255,0.12)] bg-[rgba(6,14,34,0.6)] px-4 py-2.5">
        <span className="flex items-center gap-2 pe-3 text-sm font-semibold"><Svg d="M6 3a3 3 0 1 0 0 6 3 3 0 0 0 0-6zM6 15a3 3 0 1 0 0 6 3 3 0 0 0 0-6zM20 4L8.1 15.9M14.5 14.5L20 20M8.1 8.1L12 12" size={18} stroke="#18D4F0" />{t('snip.app')}</span>
        <button type="button" onClick={startNew} disabled={allowed === false} className={`${btnPrimary} gap-2 px-4 py-2`} aria-keyshortcuts="Control+N">
          <Svg d="M12 5v14M5 12h14" size={16} stroke="#FFFFFF" />{t('snip.new')}
        </button>
        <label className="flex items-center gap-1.5 text-[13px] text-[#C9D6EE]">
          <span className="sr-only">{t('snip.modeLabel')}</span>
          <select value={mode} onChange={(e) => setMode(e.target.value as SnipMode)} aria-label={t('snip.modeLabel')} className="h-9 rounded-lg border border-[rgba(127,178,255,0.25)] bg-[rgba(4,10,26,0.5)] px-2 text-[13px] text-[#E8EEFA]">
            {SNIP_MODES.map((m) => <option key={m} value={m}>{t(`snip.mode.${m}` as MessageKey)}</option>)}
          </select>
        </label>
        <label className="flex items-center gap-1.5 text-[13px] text-[#C9D6EE]">
          <Svg d="M12 7v5l3 2M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18z" size={16} />
          <span className="sr-only">{t('snip.delay')}</span>
          <select value={delay} onChange={(e) => setDelay(Number(e.target.value))} aria-label={t('snip.delay')} className="h-9 rounded-lg border border-[rgba(127,178,255,0.25)] bg-[rgba(4,10,26,0.5)] px-2 text-[13px] text-[#E8EEFA]">
            {DELAYS.map((d) => <option key={d} value={d}>{d ? t('snip.delaySeconds', { n: formatNumber(d) }) : t('snip.noDelay')}</option>)}
          </select>
        </label>
        <span className="flex-1" />
        <button type="button" aria-label={t('common.close')} title={t('common.close')} onClick={onClose} className="flex h-9 w-9 cursor-pointer items-center justify-center rounded-lg text-[#8FA3C8] hover:bg-white/10 hover:text-white">
          <Svg d="M6 6l12 12M18 6L6 18" size={16} />
        </button>
      </header>
      {allowed === false && captureApi && <p role="status" className="m-0 bg-[rgba(217,69,43,0.15)] px-4 py-2 text-[13px] text-[#FFB4A6]">{t('snip.blockedBody')}</p>}
      {shot ? <Editor key={shot.id} shot={shot} /> : (
        <div className="flex flex-1 flex-col items-center justify-center gap-3 p-6 text-center">
          {loading ? <p className="m-0 text-sm text-[#8FA3C8]">{t('snip.loading')}</p> : <>
            <Svg d="M4 4h16v16H4z" size={48} stroke="#3D5280" />
            <p className="m-0 max-w-[420px] text-[15px]">{captureApi ? t('snip.homeHint') : t('snip.unavailable')}</p>
            <p className="m-0 text-[13px] text-[#8FA3C8]">{t('snip.homeKeys')}</p>
          </>}
        </div>
      )}
    </div>
  )
}

function Editor({ shot }: { shot: Shot }) {
  const [img, setImg] = useState<HTMLImageElement | null>(null)
  const [hist, setHist] = useState<History | null>(null)
  const [tool, setTool] = useState<Tool>('pen')
  const [penColor, setPenColor] = useState(PEN_COLORS[2])
  const [hlColor, setHlColor] = useState(HIGHLIGHT_COLORS[0])
  const [width, setWidth] = useState(4)
  const [live, setLive] = useState<Op | null>(null)
  const [cropDraft, setCropDraft] = useState<Rect | null>(null)
  const [text, setText] = useState<{ at: Pt; value: string } | null>(null)
  const [format, setFormat] = useState<'png' | 'jpeg'>('png')
  const [saved, setSaved] = useState<string | null>(shot.file)
  const [status, setStatus] = useState<string | null>(null)
  const canvas = useRef<HTMLCanvasElement>(null)
  const drag = useRef<Pt | null>(null)
  const eraseBase = useRef<History | null>(null)   // an eraser drag is one undo step
  const textRef = useRef<HTMLTextAreaElement>(null)

  useEffect(() => {
    const im = new Image()
    im.onload = () => { setImg(im); setHist(newHistory(im.naturalWidth, im.naturalHeight)) }
    im.src = shot.url
  }, [shot.url])

  const doc = hist?.present
  const view: Rect | null = doc ? (tool === 'crop' ? { x: 0, y: 0, w: doc.w, h: doc.h } : outputRect(doc)) : null

  // Draw: while cropping the whole image with the crop dimmed around it; otherwise the cropped result.
  useEffect(() => {
    const c = canvas.current
    if (!c || !img || !doc || !view) return
    c.width = view.w; c.height = view.h
    const x = c.getContext('2d') as unknown as Ctx2D | null
    if (!x) return
    if (tool === 'crop') {
      render(x, img, { ...doc, crop: null })
      const r = cropDraft ?? doc.crop
      if (r) {
        const cx = c.getContext('2d')!
        cx.save(); cx.fillStyle = 'rgba(0,0,0,0.5)'; cx.beginPath(); cx.rect(0, 0, doc.w, doc.h); cx.rect(r.x, r.y, r.w, r.h); cx.fill('evenodd')
        cx.strokeStyle = '#FFFFFF'; cx.lineWidth = Math.max(2, doc.w / 600); cx.setLineDash([8, 6]); cx.strokeRect(r.x, r.y, r.w, r.h); cx.restore()
      }
    } else render(x, img, doc, live ? [live] : [])
  }, [img, doc, view?.w, view?.h, tool, live, cropDraft]) // eslint-disable-line react-hooks/exhaustive-deps

  const change = useCallback((f: (d: NonNullable<typeof doc>) => NonNullable<typeof doc>) => setHist((h) => (h ? commit(h, f(h.present)) : h)), [])
  const toImage = (e: React.PointerEvent): Pt => {
    const c = canvas.current!, b = c.getBoundingClientRect()
    return { x: (e.clientX - b.left) * (c.width / b.width) + (view?.x ?? 0), y: (e.clientY - b.top) * (c.height / b.height) + (view?.y ?? 0) }
  }
  const scale = () => { const c = canvas.current; return c ? c.width / Math.max(1, c.getBoundingClientRect().width) : 1 }

  const commitText = () => {
    if (text?.value.trim()) change((d) => addOp(d, { kind: 'text', color: penColor, size: Math.round(22 * scale()), at: text.at, text: text.value }))
    setText(null)
  }
  const down = (e: React.PointerEvent<HTMLCanvasElement>) => {
    if (!doc || e.button !== 0) return
    const p = toImage(e)
    if (text) { commitText(); return }
    if (tool === 'text') { setText({ at: p, value: '' }); setTimeout(() => textRef.current?.focus(), 0); return }
    e.currentTarget.setPointerCapture?.(e.pointerId)
    drag.current = p
    const w = Math.max(1, width * scale())
    if (tool === 'eraser') { eraseBase.current = hist; setHist((h) => (h ? { ...h, present: eraseAt(h.present, p, 8 * scale()) } : h)) }
    else if (tool === 'pen' || tool === 'highlighter') setLive({ kind: 'stroke', tool, color: tool === 'pen' ? penColor : hlColor, width: tool === 'pen' ? w : w * 4, points: [p] })
    else if (tool === 'arrow') setLive({ kind: 'arrow', color: penColor, width: w, from: p, to: p })
    else if (tool === 'crop') setCropDraft({ ...p, w: 0, h: 0 })
  }
  const move = (e: React.PointerEvent) => {
    if (!drag.current) return
    const p = toImage(e)
    if (tool === 'eraser') { setHist((h) => (h ? { ...h, present: eraseAt(h.present, p, 8 * scale()) } : h)); return }
    if (tool === 'crop') { setCropDraft(normRect(drag.current, p)); return }
    setLive((l) => (!l ? l : l.kind === 'stroke' ? { ...l, points: extend(l.points, p) } : l.kind === 'arrow' ? { ...l, to: p } : l))
  }
  const up = () => {
    if (!drag.current) return
    drag.current = null
    if (tool === 'eraser') {
      const base = eraseBase.current
      eraseBase.current = null
      setHist((h) => (h && base && h.present !== base.present ? { past: [...base.past, base.present], present: h.present, future: [] } : h))
      return
    }
    if (tool === 'crop' && cropDraft) { if (bigEnough(cropDraft)) change((d) => setCrop(d, cropDraft)); setCropDraft(null); return }
    if (live && (live.kind !== 'arrow' || Math.hypot(live.to.x - live.from.x, live.to.y - live.from.y) > 4)) change((d) => addOp(d, live))
    setLive(null)
  }

  /** The finished image: cropped, with every mark. JPEG gets a white ground (no transparency). */
  const exportUrl = (fmt: 'png' | 'jpeg') => {
    if (!img || !doc) return null
    const r = outputRect(doc)
    const c = document.createElement('canvas')
    c.width = r.w; c.height = r.h
    const x = c.getContext('2d')
    if (!x) return null
    if (fmt === 'jpeg') { x.fillStyle = '#FFFFFF'; x.fillRect(0, 0, r.w, r.h) }
    render(x as unknown as Ctx2D, img, doc)
    return c.toDataURL(fmt === 'png' ? 'image/png' : 'image/jpeg', 0.92)
  }
  const copy = async () => { const u = exportUrl('png'); const ok = !!u && !!(await captureApi?.snipCopy(u)); setStatus(ok ? t('snip.copied') : t('snip.copyFailed')) }
  const save = async () => {
    const u = exportUrl(format)
    if (!u || !captureApi) return
    const r = await captureApi.snipSave(u)
    if (r.ok) { setSaved(r.value); setStatus(t('snip.savedTo', { name: r.value.split('/').pop() ?? '' })) }
    else if (r.error !== 'cancelled') setStatus(t('snip.saveFailed'))
  }
  const reveal = async () => {
    if (!saved) return
    const at = await captureApi?.snipReveal(saved)
    if (at) window.dispatchEvent(new CustomEvent(OPEN_FILES_EVENT, { detail: { root: at.root, rel: at.rel } }))
  }

  const onKey = (e: React.KeyboardEvent) => {
    if ((e.target as HTMLElement).closest('textarea, input, select')) return
    const k = e.key.toLowerCase()
    if (e.ctrlKey && k === 'z' && !e.shiftKey) { e.preventDefault(); setHist((h) => (h ? undo(h) : h)) }
    else if (e.ctrlKey && (k === 'y' || (k === 'z' && e.shiftKey))) { e.preventDefault(); setHist((h) => (h ? redo(h) : h)) }
    else if (e.ctrlKey && k === 'c') { e.preventDefault(); void copy() }
    else if (e.ctrlKey && k === 's') { e.preventDefault(); void save() }
    else if (!e.ctrlKey && !e.altKey && !e.metaKey && TOOL_KEY[k]) { e.preventDefault(); setTool(TOOL_KEY[k]) }
  }

  const colors = tool === 'highlighter' ? HIGHLIGHT_COLORS : PEN_COLORS
  const color = tool === 'highlighter' ? hlColor : penColor
  const setColor = tool === 'highlighter' ? setHlColor : setPenColor
  const out = doc ? outputRect(doc) : null
  const c = canvas.current
  const textPos = text && c && view ? { left: (text.at.x - view.x) / (c.width / c.getBoundingClientRect().width), top: (text.at.y - view.y) / (c.height / c.getBoundingClientRect().height) } : null

  return (
    <div className="flex min-h-0 flex-1 flex-col" onKeyDown={onKey}>
      <div role="toolbar" aria-label={t('snip.tools')} className="flex flex-wrap items-center gap-1.5 border-b border-[rgba(127,178,255,0.1)] px-4 py-2">
        {TOOLS.map((x) => (
          <ToolButton key={x} label={t(`snip.tool.${x}` as MessageKey)} pressed={tool === x} onClick={() => { if (text) commitText(); setTool(x) }} d={TOOL_ICON[x]} shortcut={Object.entries(TOOL_KEY).find(([, v]) => v === x)?.[0].toUpperCase()} />
        ))}
        {tool === 'crop' && doc?.crop && <button type="button" onClick={() => change((d) => setCrop(d, null))} className={`${btnGhost} px-3 py-1.5 text-[13px]`}>{t('snip.resetCrop')}</button>}
        {(tool === 'pen' || tool === 'highlighter' || tool === 'arrow' || tool === 'text') && (
          <span role="radiogroup" aria-label={t('snip.color')} className="ms-2 flex items-center gap-1">
            {colors.map((x) => (
              <button key={x} type="button" role="radio" aria-checked={color === x} aria-label={t('snip.colorN', { n: colors.indexOf(x) + 1 })} onClick={() => setColor(x)}
                className="h-7 w-7 cursor-pointer rounded-full border-2" style={{ background: x, borderColor: color === x ? '#18D4F0' : 'rgba(127,178,255,0.35)' }} />
            ))}
          </span>
        )}
        {(tool === 'pen' || tool === 'highlighter' || tool === 'arrow') && (
          <label className="ms-2 flex items-center gap-2 text-[12px] text-[#8FA3C8]">{t('snip.size')}
            <input type="range" min={1} max={16} value={width} onChange={(e) => setWidth(Number(e.target.value))} className="w-24 accent-[#1F6BFF]" />
          </label>
        )}
        <span aria-hidden="true" className="mx-2 h-6 w-px bg-[rgba(127,178,255,0.2)]" />
        <ToolButton label={t('snip.undo')} d="M9 14L4 9l5-5M4 9h11a5 5 0 0 1 0 10h-3" disabled={!hist?.past.length} onClick={() => setHist((h) => (h ? undo(h) : h))} shortcut="Ctrl+Z" />
        <ToolButton label={t('snip.redo')} d="M15 14l5-5-5-5M20 9H9a5 5 0 0 0 0 10h3" disabled={!hist?.future.length} onClick={() => setHist((h) => (h ? redo(h) : h))} shortcut="Ctrl+Y" />
        <span className="flex-1" />
        <button type="button" onClick={() => void copy()} className={`${btnGhost} gap-2 px-3 py-1.5 text-[13px]`} aria-keyshortcuts="Control+C"><Svg d="M9 9h11v11H9zM5 15H4V4h11v1" size={16} />{t('snip.copy')}</button>
        <span className="flex items-center gap-1">
          <select value={format} onChange={(e) => setFormat(e.target.value as 'png' | 'jpeg')} aria-label={t('snip.format')} className="h-9 rounded-lg border border-[rgba(127,178,255,0.25)] bg-[rgba(4,10,26,0.5)] px-2 text-[13px] text-[#E8EEFA]">
            <option value="png">{t('snip.png')}</option><option value="jpeg">{t('snip.jpeg')}</option>
          </select>
          <button type="button" onClick={() => void save()} disabled={!captureApi} className={`${btnPrimary} gap-2 px-3 py-1.5 text-[13px]`} aria-keyshortcuts="Control+S"><Svg d="M5 3h11l3 3v15H5zM8 3v5h8M8 14h8v7H8z" size={16} stroke="#FFFFFF" />{t('snip.saveAs')}</button>
        </span>
        <button type="button" onClick={() => void reveal()} disabled={!saved} title={saved ? undefined : t('snip.saveFirst')} className={`${btnGhost} gap-2 px-3 py-1.5 text-[13px]`}><Svg d="M3 6h6l2 2h10v11H3z" size={16} />{t('snip.showInFiles')}</button>
      </div>
      <div className="relative flex min-h-0 flex-1 items-center justify-center overflow-auto bg-[repeating-conic-gradient(#0d1f47_0_25%,#0b1a3c_0_50%)] [background-size:20px_20px] p-6">
        {doc && view ? (
          <div className="relative max-h-full max-w-full">
            <canvas ref={canvas} role="img" aria-label={t('snip.imageLabel', { w: formatNumber(out!.w), h: formatNumber(out!.h) })} onPointerDown={down} onPointerMove={move} onPointerUp={up}
              className={`block max-h-[calc(100vh-170px)] max-w-full touch-none shadow-[0_10px_40px_rgba(0,0,0,0.5)] ${tool === 'text' ? 'cursor-text' : tool === 'eraser' ? 'cursor-cell' : 'cursor-crosshair'}`} />
            {text && textPos && (
              <textarea ref={textRef} value={text.value} aria-label={t('snip.textLabel')} rows={1} onChange={(e) => setText({ ...text, value: e.target.value })}
                onKeyDown={(e) => { e.stopPropagation(); if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); commitText() } if (e.key === 'Escape') { e.preventDefault(); setText(null) } }}
                className="absolute min-w-[120px] resize rounded border border-dashed border-[#18D4F0] bg-transparent p-0.5 text-[22px] font-semibold outline-none" style={{ left: textPos.left, top: textPos.top, color: penColor }} />
            )}
          </div>
        ) : <p className="m-0 text-sm text-[#8FA3C8]">{t('snip.loading')}</p>}
      </div>
      <p role="status" aria-live="polite" className="m-0 min-h-[30px] border-t border-[rgba(127,178,255,0.1)] px-4 py-1.5 text-[12px] text-[#8FA3C8]">
        {status ?? (out ? t('snip.size2', { w: formatNumber(out.w), h: formatNumber(out.h) }) : '')}
      </p>
    </div>
  )
}

function ToolButton({ label, d, pressed, disabled, onClick, shortcut }: { label: string; d: string; pressed?: boolean; disabled?: boolean; onClick: () => void; shortcut?: string }): ReactNode {
  return (
    <button type="button" aria-label={label} aria-pressed={pressed} title={shortcut ? `${label} (${shortcut})` : label} disabled={disabled} onClick={onClick}
      className={`flex h-9 w-9 cursor-pointer items-center justify-center rounded-lg disabled:cursor-default disabled:opacity-40 ${pressed ? 'bg-[#1F6BFF] text-white' : 'text-[#C9D6EE] hover:bg-white/10'}`}>
      <Svg d={d} size={18} />
    </button>
  )
}

/** For tests: draw a list of marks (used by the editor's export and its preview). */
export const drawMarks = (ctx: Ctx2D, ops: Op[]) => ops.forEach((o) => drawOp(ctx, o))

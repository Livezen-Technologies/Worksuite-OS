// Snipping tool logic without the DOM: selection geometry for the overlay (components/SnipOverlay.tsx), the Window
// mode's guess of the window under the pointer, and the editor's document with undo/redo (screens/SnippingTool.tsx).
export interface Pt { x: number; y: number }
export interface Rect { x: number; y: number; w: number; h: number }

export const normRect = (a: Pt, b: Pt): Rect => ({ x: Math.min(a.x, b.x), y: Math.min(a.y, b.y), w: Math.abs(a.x - b.x), h: Math.abs(a.y - b.y) })
export function clampRect(r: Rect, w: number, h: number): Rect {
  const x = Math.max(0, Math.min(w, r.x)), y = Math.max(0, Math.min(h, r.y))
  return { x, y, w: Math.max(0, Math.min(w, r.x + r.w) - x), h: Math.max(0, Math.min(h, r.y + r.h) - y) }
}
/** Screen (CSS) pixels → image pixels (the frame is at the output's scale). */
export const scaleRect = (r: Rect, sx: number, sy: number): Rect => {
  const x = Math.round(r.x * sx), y = Math.round(r.y * sy)
  return { x, y, w: Math.max(1, Math.round((r.x + r.w) * sx) - x), h: Math.max(1, Math.round((r.y + r.h) * sy) - y) }
}
export function pathBounds(pts: Pt[]): Rect {
  if (!pts.length) return { x: 0, y: 0, w: 0, h: 0 }
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity
  for (const p of pts) { x0 = Math.min(x0, p.x); y0 = Math.min(y0, p.y); x1 = Math.max(x1, p.x); y1 = Math.max(y1, p.y) }
  return { x: x0, y: y0, w: x1 - x0, h: y1 - y0 }
}
/** A selection big enough to keep (a click without a drag is not a snip). */
export const bigEnough = (r: Rect) => r.w >= 4 && r.h >= 4
/** Keyboard nudging of a selection: arrows move it, Shift+arrows resize it (10 px with Ctrl). */
export function nudge(r: Rect, key: string, shift: boolean, step: number, w: number, h: number): Rect {
  const d = { ArrowLeft: [-step, 0], ArrowRight: [step, 0], ArrowUp: [0, -step], ArrowDown: [0, step] }[key]
  if (!d) return r
  if (shift) return clampRect({ ...r, w: Math.max(4, r.w + d[0]), h: Math.max(4, r.h + d[1]) }, w, h)
  return { ...r, x: Math.max(0, Math.min(w - r.w, r.x + d[0])), y: Math.max(0, Math.min(h - r.h, r.y + d[1])) }
}

/**
 * Window mode. Labwc 0.8 tells no client where windows are (wlr-foreign-toplevel has no geometry), so the overlay
 * finds the window under the pointer in the frozen frame. Window borders are long straight edges; the candidates are
 * the straight edges on each side of the pointer (within a band around it), and the window is the largest rectangle
 * of candidates whose four sides are edges along (nearly) their whole length — larger than a panel inside the window,
 * whose edges stop at the title bar. Rectangles that lean on the screen's border are taken only when nothing else fits
 * (a maximised window). `gray` is a luminance image of w×h (a scaled-down copy is fine). Returns null when nothing
 * window-like is around the point; the person can still drag a rectangle.
 */
export function snapWindowRect(gray: ArrayLike<number>, w: number, h: number, px: number, py: number, threshold = 22): Rect | null {
  px = Math.max(1, Math.min(w - 2, Math.round(px))); py = Math.max(1, Math.min(h - 2, Math.round(py)))
  const g = (x: number, y: number) => gray[y * w + x]
  // An edge between x-1 and x (vertical) or y-1 and y (horizontal); the screen's border counts as one.
  const vEdge = (x: number, y: number) => x <= 0 || x >= w || Math.abs(g(x, y) - g(x - 1, y)) > threshold
  const hEdge = (x: number, y: number) => y <= 0 || y >= h || Math.abs(g(x, y) - g(x, y - 1)) > threshold
  const share = (ok: (i: number) => boolean, a: number, b: number, need: number) => { let c = 0, t = 0; for (let i = a; i <= b; i++) { t++; if (ok(i)) c++ } return t > 0 && c / t >= need }
  const by = Math.max(4, Math.round(h * 0.04)), bx = Math.max(4, Math.round(w * 0.04))
  const ys = [Math.max(0, py - by), Math.min(h - 1, py + by)], xs = [Math.max(0, px - bx), Math.min(w - 1, px + bx)]
  const MAXC = 10
  const lefts: number[] = [], rights: number[] = [], tops: number[] = [], bottoms: number[] = []
  for (let x = px; x >= 0 && lefts.length < MAXC; x--) if (share((y) => vEdge(x, y), ys[0], ys[1], 0.6)) lefts.push(x)
  for (let x = px + 1; x <= w && rights.length < MAXC; x++) if (share((y) => vEdge(x, y), ys[0], ys[1], 0.6)) rights.push(x)
  for (let y = py; y >= 0 && tops.length < MAXC; y--) if (share((x) => hEdge(x, y), xs[0], xs[1], 0.6)) tops.push(y)
  for (let y = py + 1; y <= h && bottoms.length < MAXC; y++) if (share((x) => hEdge(x, y), xs[0], xs[1], 0.6)) bottoms.push(y)
  let best: { r: Rect; border: number; area: number } | null = null
  for (const l of lefts) for (const r of rights) for (const t of tops) for (const b of bottoms) {
    const rw = r - l, rh = b - t
    if (rw < Math.min(60, w / 5) || rh < Math.min(40, h / 5)) continue
    const border = Number(l <= 0) + Number(r >= w) + Number(t <= 0) + Number(b >= h)
    if (border === 4) continue
    const ok = share((y) => vEdge(l, y), t, b - 1, 0.8) && share((y) => vEdge(r, y), t, b - 1, 0.8) && share((x) => hEdge(x, t), l, r - 1, 0.8) && share((x) => hEdge(x, b), l, r - 1, 0.8)
    if (!ok) continue
    const area = rw * rh
    if (!best || border < best.border || (border === best.border && area > best.area)) best = { r: { x: l, y: t, w: rw, h: rh }, border, area }
  }
  return best?.r ?? null
}
/** RGBA → luminance (0–255). */
export function luminance(rgba: ArrayLike<number>): Uint8ClampedArray {
  const out = new Uint8ClampedArray(rgba.length / 4)
  for (let i = 0; i < out.length; i++) out[i] = (rgba[i * 4] * 54 + rgba[i * 4 + 1] * 183 + rgba[i * 4 + 2] * 19) >> 8
  return out
}

// ---- the editor's document ----------------------------------------------------------------------------------------
export type Tool = 'pen' | 'highlighter' | 'eraser' | 'text' | 'arrow' | 'crop'
export type Op =
  | { kind: 'stroke'; tool: 'pen' | 'highlighter'; color: string; width: number; points: Pt[] }
  | { kind: 'arrow'; color: string; width: number; from: Pt; to: Pt }
  | { kind: 'text'; color: string; size: number; at: Pt; text: string }
/** Marks are in image pixels of the original screenshot; crop is a rectangle of it (null = the whole image). */
export interface Doc { w: number; h: number; crop: Rect | null; ops: Op[] }
export interface History { past: Doc[]; present: Doc; future: Doc[] }

export const PEN_COLORS = ['#111111', '#FFFFFF', '#E5322D', '#1F6BFF', '#2E9E6A', '#7A4FE0']
export const HIGHLIGHT_COLORS = ['#FFE14D', '#7CF29C', '#7FD8FF', '#FF9AD5']
export const MAX_HISTORY = 100

export const newHistory = (w: number, h: number): History => ({ past: [], present: { w, h, crop: null, ops: [] }, future: [] })
export function commit(hist: History, next: Doc): History {
  if (next === hist.present) return hist
  return { past: [...hist.past, hist.present].slice(-MAX_HISTORY), present: next, future: [] }
}
export const undo = (h: History): History => (h.past.length ? { past: h.past.slice(0, -1), present: h.past[h.past.length - 1], future: [h.present, ...h.future] } : h)
export const redo = (h: History): History => (h.future.length ? { past: [...h.past, h.present], present: h.future[0], future: h.future.slice(1) } : h)
export const addOp = (d: Doc, op: Op): Doc => ({ ...d, ops: [...d.ops, op] })
export const setCrop = (d: Doc, r: Rect | null): Doc => {
  if (!r) return d.crop ? { ...d, crop: null } : d
  const c = clampRect(r, d.w, d.h)
  return bigEnough(c) ? { ...d, crop: c } : d
}
/** What the exported image covers. */
export const outputRect = (d: Doc): Rect => d.crop ?? { x: 0, y: 0, w: d.w, h: d.h }

function segDist(p: Pt, a: Pt, b: Pt): number {
  const dx = b.x - a.x, dy = b.y - a.y
  const l2 = dx * dx + dy * dy
  const t = l2 ? Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.y - a.y) * dy) / l2)) : 0
  return Math.hypot(p.x - (a.x + t * dx), p.y - (a.y + t * dy))
}
export function textBox(op: Extract<Op, { kind: 'text' }>): Rect {
  const lines = op.text.split('\n')
  return { x: op.at.x, y: op.at.y, w: Math.max(...lines.map((l) => l.length), 1) * op.size * 0.6, h: lines.length * op.size * 1.25 }
}
/** Whether a mark passes within r of the point (the eraser removes whole marks, like the Windows Snipping Tool). */
export function hits(op: Op, p: Pt, r: number): boolean {
  if (op.kind === 'text') { const b = textBox(op); return p.x >= b.x - r && p.x <= b.x + b.w + r && p.y >= b.y - r && p.y <= b.y + b.h + r }
  if (op.kind === 'arrow') return segDist(p, op.from, op.to) <= r + op.width / 2
  const pts = op.points
  if (pts.length === 1) return Math.hypot(p.x - pts[0].x, p.y - pts[0].y) <= r + op.width / 2
  for (let i = 1; i < pts.length; i++) if (segDist(p, pts[i - 1], pts[i]) <= r + op.width / 2) return true
  return false
}
export function eraseAt(d: Doc, p: Pt, r: number): Doc {
  const ops = d.ops.filter((o) => !hits(o, p, r))
  return ops.length === d.ops.length ? d : { ...d, ops }
}
/** Points closer than `min` to the last one are dropped while drawing (smaller documents, smoother lines). */
export function extend(points: Pt[], p: Pt, min = 1.5): Pt[] {
  const last = points[points.length - 1]
  return last && Math.hypot(p.x - last.x, p.y - last.y) < min ? points : [...points, p]
}
/** The two short strokes of an arrow head at `to`. */
export function arrowHead(from: Pt, to: Pt, size: number): [Pt, Pt] {
  const a = Math.atan2(to.y - from.y, to.x - from.x)
  return [-1, 1].map((s) => ({ x: to.x - size * Math.cos(a + s * Math.PI / 7), y: to.y - size * Math.sin(a + s * Math.PI / 7) })) as [Pt, Pt]
}

/** The part of CanvasRenderingContext2D the renderer uses (tests record the calls). */
export interface Ctx2D {
  save(): void; restore(): void; beginPath(): void; moveTo(x: number, y: number): void; lineTo(x: number, y: number): void; stroke(): void
  fillText(t: string, x: number, y: number): void; translate(x: number, y: number): void; drawImage(...a: unknown[]): void
  strokeStyle: unknown; fillStyle: unknown; lineWidth: number; lineCap: CanvasLineCap; lineJoin: CanvasLineJoin; globalAlpha: number; globalCompositeOperation: GlobalCompositeOperation; font: string; textBaseline: CanvasTextBaseline
}
/** Draws the image (cropped) and every mark, in image pixels with the crop's corner at 0,0. */
export function render(ctx: Ctx2D, img: unknown, d: Doc, extra: Op[] = []) {
  const c = outputRect(d)
  ctx.save()
  ctx.drawImage(img, c.x, c.y, c.w, c.h, 0, 0, c.w, c.h)
  ctx.translate(-c.x, -c.y)
  for (const op of [...d.ops, ...extra]) drawOp(ctx, op)
  ctx.restore()
}
export function drawOp(ctx: Ctx2D, op: Op) {
  ctx.save()
  ctx.lineCap = 'round'; ctx.lineJoin = 'round'
  if (op.kind === 'text') {
    ctx.fillStyle = op.color; ctx.font = `600 ${op.size}px sans-serif`; ctx.textBaseline = 'top'
    op.text.split('\n').forEach((l, i) => ctx.fillText(l, op.at.x, op.at.y + i * op.size * 1.25))
  } else if (op.kind === 'arrow') {
    ctx.strokeStyle = op.color; ctx.lineWidth = op.width
    const [h1, h2] = arrowHead(op.from, op.to, Math.max(12, op.width * 4))
    ctx.beginPath(); ctx.moveTo(op.from.x, op.from.y); ctx.lineTo(op.to.x, op.to.y); ctx.moveTo(h1.x, h1.y); ctx.lineTo(op.to.x, op.to.y); ctx.lineTo(h2.x, h2.y); ctx.stroke()
  } else {
    ctx.strokeStyle = op.color; ctx.lineWidth = op.width
    if (op.tool === 'highlighter') { ctx.globalAlpha = 0.4; ctx.globalCompositeOperation = 'multiply'; ctx.lineCap = 'square' }
    ctx.beginPath()
    op.points.forEach((p, i) => (i ? ctx.lineTo(p.x, p.y) : ctx.moveTo(p.x, p.y)))
    if (op.points.length === 1) ctx.lineTo(op.points[0].x + 0.1, op.points[0].y)
    ctx.stroke()
  }
  ctx.restore()
}

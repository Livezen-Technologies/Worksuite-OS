import { describe, expect, it } from 'vitest'
import { addOp, arrowHead, clampRect, commit, eraseAt, extend, hits, MAX_HISTORY, newHistory, normRect, nudge, outputRect, pathBounds, redo, render, scaleRect, setCrop, snapWindowRect, undo, type Ctx2D, type Op } from './snip'

describe('selection geometry', () => {
  it('normalizes, clamps, scales and bounds', () => {
    expect(normRect({ x: 50, y: 40 }, { x: 10, y: 60 })).toEqual({ x: 10, y: 40, w: 40, h: 20 })
    expect(clampRect({ x: -10, y: 5, w: 50, h: 500 }, 100, 100)).toEqual({ x: 0, y: 5, w: 40, h: 95 })
    expect(scaleRect({ x: 10, y: 10, w: 20.4, h: 5 }, 2, 2)).toEqual({ x: 20, y: 20, w: 41, h: 10 })
    expect(pathBounds([{ x: 3, y: 9 }, { x: 1, y: 2 }, { x: 7, y: 4 }])).toEqual({ x: 1, y: 2, w: 6, h: 7 })
  })

  it('moves and resizes a selection from the keyboard, inside the screen', () => {
    const r = { x: 0, y: 0, w: 10, h: 10 }
    expect(nudge(r, 'ArrowLeft', false, 1, 100, 100)).toEqual(r)
    expect(nudge(r, 'ArrowRight', false, 10, 100, 100)).toEqual({ x: 10, y: 0, w: 10, h: 10 })
    expect(nudge(r, 'ArrowDown', true, 5, 100, 100)).toEqual({ x: 0, y: 0, w: 10, h: 15 })
    expect(nudge(r, 'ArrowLeft', true, 50, 100, 100)).toEqual({ x: 0, y: 0, w: 4, h: 10 })
  })
})

/** A dark desktop (30) with a light window (220) at 40..199 × 30..149, a title bar (160) on top and a sidebar line inside. */
function screen(w = 320, h = 200) {
  const g = new Uint8ClampedArray(w * h).fill(30)
  for (let y = 30; y < 150; y++) for (let x = 40; x < 200; x++) g[y * w + x] = y < 42 ? 160 : x === 90 ? 120 : 220
  return { g, w, h }
}

describe('Window mode', () => {
  it('finds the window around the pointer, past the edges inside it', () => {
    const { g, w, h } = screen()
    expect(snapWindowRect(g, w, h, 150, 100)).toEqual({ x: 40, y: 30, w: 160, h: 120 })
    expect(snapWindowRect(g, w, h, 60, 100)).toEqual({ x: 40, y: 30, w: 160, h: 120 })   // left of the sidebar line
    expect(snapWindowRect(g, w, h, 100, 35)).toEqual({ x: 40, y: 30, w: 160, h: 120 })   // on the title bar
  })

  it('gives nothing on an empty desktop', () => {
    const g = new Uint8ClampedArray(320 * 200).fill(30)
    expect(snapWindowRect(g, 320, 200, 100, 100)).toBeNull()
  })
})

describe('editor document', () => {
  const pen = (pts: [number, number][], width = 4): Op => ({ kind: 'stroke', tool: 'pen', color: '#000', width, points: pts.map(([x, y]) => ({ x, y })) })

  it('undoes and redoes every change, and a new change drops the redo list', () => {
    let h = newHistory(100, 80)
    h = commit(h, addOp(h.present, pen([[1, 1], [9, 9]])))
    h = commit(h, setCrop(h.present, { x: 10, y: 10, w: 50, h: 40 }))
    expect(outputRect(h.present)).toEqual({ x: 10, y: 10, w: 50, h: 40 })
    h = undo(h)
    expect(h.present.crop).toBeNull()
    expect(h.present.ops).toHaveLength(1)
    h = undo(undo(h))
    expect(h.present.ops).toHaveLength(0)
    h = redo(h)
    expect(h.present.ops).toHaveLength(1)
    h = commit(h, addOp(h.present, pen([[5, 5]])))
    expect(redo(h)).toBe(h)
    for (let i = 0; i < MAX_HISTORY + 20; i++) h = commit(h, addOp(h.present, pen([[i, i]])))
    expect(h.past).toHaveLength(MAX_HISTORY)
  })

  it('crops inside the image and ignores a tiny crop', () => {
    const d = newHistory(100, 80).present
    expect(setCrop(d, { x: 90, y: 70, w: 50, h: 50 }).crop).toEqual({ x: 90, y: 70, w: 10, h: 10 })
    expect(setCrop(d, { x: 5, y: 5, w: 2, h: 2 })).toBe(d)
    expect(setCrop(setCrop(d, { x: 0, y: 0, w: 50, h: 50 }), null).crop).toBeNull()
  })

  it('erases whole marks the eraser touches, and only those', () => {
    const d = { w: 100, h: 100, crop: null, ops: [pen([[0, 0], [50, 0]]), { kind: 'arrow', color: '#f00', width: 3, from: { x: 0, y: 50 }, to: { x: 50, y: 50 } } as Op, { kind: 'text', color: '#000', size: 20, at: { x: 60, y: 60 }, text: 'Hi' } as Op] }
    expect(eraseAt(d, { x: 25, y: 3 }, 2).ops.map((o) => o.kind)).toEqual(['arrow', 'text'])
    expect(eraseAt(d, { x: 25, y: 52 }, 2).ops.map((o) => o.kind)).toEqual(['stroke', 'text'])
    expect(eraseAt(d, { x: 70, y: 70 }, 2).ops.map((o) => o.kind)).toEqual(['stroke', 'arrow'])
    expect(eraseAt(d, { x: 90, y: 20 }, 2)).toBe(d)
    expect(hits(pen([[10, 10]], 6), { x: 13, y: 10 }, 0)).toBe(true)
  })

  it('thins pointer input and draws arrow heads behind the tip', () => {
    expect(extend([{ x: 0, y: 0 }], { x: 0.5, y: 0.5 })).toHaveLength(1)
    expect(extend([{ x: 0, y: 0 }], { x: 3, y: 0 })).toHaveLength(2)
    const [a, b] = arrowHead({ x: 0, y: 0 }, { x: 100, y: 0 }, 10)
    expect(a.x).toBeLessThan(100); expect(b.x).toBeLessThan(100)
    expect(Math.sign(a.y)).toBe(-Math.sign(b.y))
  })

  it('renders the cropped image and translates the marks', () => {
    const calls: string[] = []
    const ctx = new Proxy({}, {
      get: (_t, k) => (k in { save: 1, restore: 1, beginPath: 1, moveTo: 1, lineTo: 1, stroke: 1, fillText: 1, translate: 1, drawImage: 1 } ? (...a: unknown[]) => calls.push(`${String(k)}(${a.filter((x) => typeof x !== 'object').join(',')})`) : undefined),
      set: () => true,
    }) as unknown as Ctx2D
    render(ctx, {}, { w: 100, h: 80, crop: { x: 10, y: 20, w: 30, h: 40 }, ops: [pen([[15, 25], [20, 30]])] })
    expect(calls).toContain('drawImage(10,20,30,40,0,0,30,40)')
    expect(calls).toContain('translate(-10,-20)')
    expect(calls).toContain('moveTo(15,25)')
  })
})

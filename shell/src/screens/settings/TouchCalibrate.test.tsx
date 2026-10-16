// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { TouchCalibrate } from './TouchCalibrate'
import { TARGETS } from '../../lib/calibrate'

const g = globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }
beforeAll(() => { g.IS_REACT_ACT_ENVIRONMENT = true })
let root: Root | null = null
let host: HTMLDivElement | null = null
afterEach(() => { act(() => root?.unmount()); host?.remove(); root = null; host = null })

function tap(el: Element, x: number, y: number, pointerType = 'touch') {
  const e = new MouseEvent('pointerdown', { bubbles: true, cancelable: true, clientX: x, clientY: y })
  Object.defineProperty(e, 'pointerType', { value: pointerType })
  act(() => { el.dispatchEvent(e) })
}
const button = (name: string) => [...host!.querySelectorAll<HTMLButtonElement>('button')].find((b) => b.textContent === name)

describe('touch calibration page', () => {
  it('takes four touch taps (not mouse clicks) and saves the fitted matrix', () => {
    host = document.createElement('div'); document.body.append(host); root = createRoot(host)
    const save = vi.fn()
    act(() => root!.render(<TouchCalibrate device="ELAN Touchscreen" current={undefined} onSave={save} onClose={() => {}} />))
    const page = host.querySelector('[role=dialog]')!
    const w = window.innerWidth, h = window.innerHeight
    tap(page, 10, 10, 'mouse')
    expect(host.textContent).toContain('point 1 of 4')
    // Touches land 6 px right of each target.
    TARGETS.forEach(([x, y]) => tap(page, x * w + 6, y * h))
    expect(host.textContent).toContain('Touch is lined up')
    act(() => button('Save calibration')!.click())
    const m = save.mock.calls[0][0] as number[]
    expect(m[0]).toBeCloseTo(1, 6); expect(m[2]).toBeCloseTo(-6 / w, 6); expect(m[5]).toBeCloseTo(0, 6)
  })

  it('asks to start over when a tap misses', () => {
    host = document.createElement('div'); document.body.append(host); root = createRoot(host)
    act(() => root!.render(<TouchCalibrate device="ELAN" current={undefined} onSave={() => {}} onClose={() => {}} />))
    const page = host.querySelector('[role=dialog]')!
    const w = window.innerWidth, h = window.innerHeight
    TARGETS.forEach(([x, y], i) => tap(page, x * w + (i === 2 ? -300 : 0), y * h))
    expect(host.textContent).toContain('didn’t line up')
    expect(button('Save calibration')).toBeUndefined()
    act(() => button('Start over')!.click())
    expect(host.textContent).toContain('point 1 of 4')
  })
})

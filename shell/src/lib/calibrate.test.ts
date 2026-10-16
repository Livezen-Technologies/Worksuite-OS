import { describe, expect, it } from 'vitest'
import { IDENTITY, TARGETS, compose, fitAffine, meanError, sane, type Matrix } from './calibrate'

const apply = (m: Matrix, [u, v]: [number, number]): [number, number] => [m[0] * u + m[1] * v + m[2], m[3] * u + m[4] * v + m[5]]

describe('touch calibration', () => {
  it('recovers an offset and scale from four taps', () => {
    // The panel reports touches 2% right and 3% low, and 5% too wide.
    const skew: Matrix = [1.05, 0, 0.02, 0, 1, 0.03]
    const taps = TARGETS.map((t) => apply(skew, t))
    const m = fitAffine(taps, TARGETS)!
    expect(meanError(m, taps, TARGETS, 2560, 1600)).toBeLessThan(1e-6)
    TARGETS.forEach((t, i) => apply(m, taps[i]).forEach((x, k) => expect(x).toBeCloseTo(t[k], 6)))
    expect(sane(m)).toBe(true)
  })
  it('composes with the matrix already in force', () => {
    const current: Matrix = [1, 0, 0.01, 0, 1, 0]
    const fix: Matrix = [1, 0, -0.01, 0, 1, 0]
    expect(compose(fix, current).map((x) => Math.round(x * 1e9) / 1e9)).toEqual(IDENTITY)
  })
  it('refuses taps that do not span the screen', () => {
    expect(fitAffine([[0.5, 0.5], [0.5, 0.5], [0.5, 0.5], [0.5, 0.5]], TARGETS)).toBeNull()
    expect(fitAffine([[0.1, 0.1]], TARGETS)).toBeNull()
    expect(sane([9, 0, 0, 0, 1, 0])).toBe(false)
  })
})

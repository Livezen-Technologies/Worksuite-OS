// @vitest-environment jsdom
import { describe, expect, it } from 'vitest'
import { applyA11y, getA11y, motionReduced, setA11y } from './a11y'

describe('accessibility preferences', () => {
  it('apply as attributes on <html> and persist', () => {
    setA11y({ highContrast: true, reducedMotion: true, textScale: 2 })
    const html = document.documentElement
    expect(html.hasAttribute('data-high-contrast')).toBe(true)
    expect(html.hasAttribute('data-reduced-motion')).toBe(true)
    expect(html.style.getPropertyValue('zoom')).toBe('2')
    expect(JSON.parse(localStorage.getItem('ws.a11y')!)).toEqual({ highContrast: true, reducedMotion: true, textScale: 2 })
    setA11y({ highContrast: false, reducedMotion: false, textScale: 1 })
    expect(html.hasAttribute('data-high-contrast')).toBe(false)
    expect(html.style.getPropertyValue('zoom')).toBe('')
  })

  it('reduced motion follows the system preference too', () => {
    const orig = window.matchMedia
    window.matchMedia = ((q: string) => ({ matches: q.includes('reduce'), media: q })) as unknown as typeof window.matchMedia
    expect(motionReduced({ ...getA11y(), reducedMotion: false })).toBe(true)
    window.matchMedia = orig
  })

  it('ignores a missing root', () => {
    expect(() => applyA11y(getA11y(), null)).not.toThrow()
  })
})

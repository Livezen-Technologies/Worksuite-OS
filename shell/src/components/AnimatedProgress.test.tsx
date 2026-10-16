// @vitest-environment jsdom
// Shared progress bar: ARIA, indeterminate segment, reduced-motion path, count-up.
import { act, type ReactNode } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeAll, describe, expect, it } from 'vitest'
import { AnimatedProgress, CountUp } from './AnimatedProgress'
import { setA11y } from '../lib/a11y'

const g = globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }
beforeAll(() => { g.IS_REACT_ACT_ENVIRONMENT = true })
let root: Root | null = null
let host: HTMLDivElement | null = null
function mount(node: ReactNode) {
  if (!host) { host = document.createElement('div'); document.body.append(host); root = createRoot(host) }
  act(() => root!.render(node))
  return host
}
afterEach(() => { act(() => root?.unmount()); host?.remove(); host = null; root = null; act(() => setA11y({ reducedMotion: false })) })
const bar = () => host!.querySelector<HTMLElement>('[role="progressbar"]')!

describe('AnimatedProgress', () => {
  it('exposes progressbar ARIA with value, bounds and busy state', () => {
    mount(<AnimatedProgress value={42.4} label="Copying" />)
    expect(bar().getAttribute('aria-label')).toBe('Copying')
    expect(bar().getAttribute('aria-valuenow')).toBe('42')
    expect(bar().getAttribute('aria-valuemin')).toBe('0')
    expect(bar().getAttribute('aria-valuemax')).toBe('100')
    expect(bar().getAttribute('aria-busy')).toBe('true')
    const fill = bar().querySelector<HTMLElement>('[data-part="fill"]')!
    expect(fill.style.width).toBe('42.4%')
    expect(fill.style.transition).toContain('width')
    expect(bar().querySelector('[data-part="shimmer"]')).not.toBeNull()
  })

  it('is not busy once complete and clamps the value', () => {
    mount(<AnimatedProgress value={140} label="Done" tone="success" />)
    expect(bar().getAttribute('aria-valuenow')).toBe('100')
    expect(bar().getAttribute('aria-busy')).toBe('false')
    expect(bar().querySelector('[data-part="shimmer"]')).toBeNull()
  })

  it('renders an indeterminate sliding segment without aria-valuenow', () => {
    mount(<AnimatedProgress value={null} label="Preparing" />)
    expect(bar().hasAttribute('aria-valuenow')).toBe(false)
    expect(bar().getAttribute('aria-busy')).toBe('true')
    expect(bar().querySelector('[data-part="segment"]')!.className).toContain('ws-indeterminate')
  })

  it('drops shimmer, sweep and the width transition under reduced motion', () => {
    act(() => setA11y({ reducedMotion: true }))
    mount(<AnimatedProgress value={30} label="R" />)
    expect(bar().querySelector('[data-part="shimmer"]')).toBeNull()
    expect(bar().querySelector<HTMLElement>('[data-part="fill"]')!.style.transition).toBe('none')
    mount(<AnimatedProgress value={null} label="R" />)
    expect(bar().querySelector('[data-part="segment"]')!.className).not.toContain('ws-indeterminate')
  })

  it('decorative meters are hidden from assistive tech', () => {
    mount(<AnimatedProgress value={50} decorative />)
    expect(host!.querySelector('[role="progressbar"]')).toBeNull()
    expect(host!.firstElementChild!.getAttribute('aria-hidden')).toBe('true')
  })

  it('count-up lands on the target at once under reduced motion', () => {
    act(() => setA11y({ reducedMotion: true }))
    mount(<CountUp value={10} />)
    mount(<CountUp value={75} />)
    expect(host!.textContent).toBe('75%')
  })
})

// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { installLongPress } from './touch'

const touch = (type: string, el: Element, x: number, y: number, n = 1) => {
  const e = new Event(type, { bubbles: true }) as Event & { touches: { clientX: number; clientY: number }[] }
  Object.defineProperty(e, 'touches', { value: Array.from({ length: n }, () => ({ clientX: x, clientY: y })) })
  el.dispatchEvent(e)
}

describe('long-press for right-click', () => {
  afterEach(() => vi.useRealTimers())
  it('sends contextmenu after the delay, not when the finger moves or lifts', () => {
    vi.useFakeTimers()
    const el = document.createElement('button'); document.body.append(el)
    const menu = vi.fn(); el.addEventListener('contextmenu', menu)
    const off = installLongPress(document, 800)
    touch('touchstart', el, 10, 10)
    vi.advanceTimersByTime(700); expect(menu).not.toHaveBeenCalled()
    vi.advanceTimersByTime(150); expect(menu).toHaveBeenCalledTimes(1)
    touch('touchstart', el, 10, 10); touch('touchmove', el, 40, 10); vi.advanceTimersByTime(1000)
    touch('touchstart', el, 10, 10); touch('touchend', el, 10, 10, 0); vi.advanceTimersByTime(1000)
    touch('touchstart', el, 10, 10, 2); vi.advanceTimersByTime(1000)
    expect(menu).toHaveBeenCalledTimes(1)
    off(); touch('touchstart', el, 10, 10); vi.advanceTimersByTime(1000)
    expect(menu).toHaveBeenCalledTimes(1)
  })
})

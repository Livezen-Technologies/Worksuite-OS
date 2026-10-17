// @vitest-environment jsdom
// Taskbar against the design canvas (G01 desktop panel): running indicators, icon size and the overflowing app list.
import { afterEach, describe, expect, it, vi } from 'vitest'
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { ACTIVATED, panel } from '../lib/panel'
import { RunningApps } from './PanelItems'

let root: ReturnType<typeof createRoot>, el: HTMLDivElement
function render(node: React.ReactNode) {
  el = document.createElement('div'); document.body.append(el)
  root = createRoot(el)
  return act(async () => root.render(node))
}
afterEach(() => { act(() => root.unmount()); el.remove(); vi.restoreAllMocks() })
const info = (id: string) => ({ id, name: id, mark: id.slice(0, 2), bg: '#1F6BFF', fg: '#FFFFFF' })

describe('taskbar (canvas G01)', () => {
  it('marks the focused app with a 16 px cyan bar and background apps with a 5 px grey dot', async () => {
    vi.spyOn(panel, 'workspaces').mockResolvedValue({ supported: false, current: 1, count: 1, windows: {} })
    vi.spyOn(panel, 'windows').mockResolvedValue([
      { handle: 'a', appId: 'mail', title: 'Mail', output: '', flags: ACTIVATED },
      { handle: 'b', appId: 'chat', title: 'Chat', output: '', flags: 0 },
    ])
    await render(<RunningApps pinned={['mail', 'chat', 'docs']} info={info} onLaunch={() => {}} />)
    const dots = [...el.querySelectorAll<HTMLElement>('[data-indicator]')]
    expect(dots.map((d) => d.dataset.indicator)).toEqual(['active', 'running'])
    expect(dots[0].className).toContain('w-4'); expect(dots[0].className).toContain('bg-[#18D4F0]')
    expect(dots[1].className).toContain('w-[5px]'); expect(dots[1].className).toContain('bg-[var(--ws-g-muted)]')
    // Pinned, not running: no indicator; the focused app's tile is lit.
    const buttons = [...el.querySelectorAll('button')]
    expect(buttons[2].querySelector('[data-indicator]')).toBeNull()
    expect(buttons[0].className).toContain('bg-white/10')
  })

  it('lets many apps shrink and scroll instead of overlapping the tray', async () => {
    vi.spyOn(panel, 'workspaces').mockResolvedValue({ supported: false, current: 1, count: 1, windows: {} })
    vi.spyOn(panel, 'windows').mockResolvedValue([])
    const pins = Array.from({ length: 24 }, (_, i) => `app${i}`)
    await render(<RunningApps pinned={pins} info={info} onLaunch={() => {}} />)
    const list = el.querySelector<HTMLElement>('[data-testid="taskbar-apps"]')!
    expect(list.className).toMatch(/\bmin-w-0\b/)
    expect(list.className).toMatch(/\boverflow-x-auto\b/)
    expect([...list.querySelectorAll('button')].every((b) => b.className.includes('shrink-0'))).toBe(true)
    // A vertical wheel scrolls the list sideways once it overflows.
    Object.defineProperty(list, 'scrollWidth', { value: 1000 }); Object.defineProperty(list, 'clientWidth', { value: 300 })
    act(() => { list.dispatchEvent(new WheelEvent('wheel', { deltaY: 120, bubbles: true })) })
    expect(list.scrollLeft).toBe(120)
  })
})

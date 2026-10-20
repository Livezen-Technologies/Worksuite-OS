// @vitest-environment jsdom
// The shell's windows get one Windows 11 title bar (issues #15, #33): Minimize, Maximize/Restore and Close at the top
// right, a drag to move, double-click to maximize, edges to resize; minimized windows stay mounted and hidden.
import { act, useState } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeAll, expect, it } from 'vitest'
import { ShellWindowsHost, type ShellWindowActions } from './ShellWindow'
import { closeWin, focusWin, minimizeWin, openWin, setRect, toggleMaxWin, type ShellWins } from '../lib/shellWindows'

beforeAll(() => { ;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true })
let root: Root | null = null
let host: HTMLElement | null = null
afterEach(() => { act(() => root?.unmount()); host?.remove() })

let current: ShellWins = []
function Host({ initial }: { initial: ShellWins }) {
  const [wins, setWins] = useState(initial)
  current = wins
  const actions: ShellWindowActions = {
    focus: (a) => setWins((w) => focusWin(w, a)), close: (a) => setWins((w) => closeWin(w, a)), minimize: (a) => setWins((w) => minimizeWin(w, a)),
    toggleMax: (a) => setWins((w) => toggleMaxWin(w, a)), move: (a, r) => setWins((w) => setRect(w, a, r)),
  }
  return <ShellWindowsHost wins={wins} actions={actions} content={(a) => ({ title: a === 'files' ? 'Files' : 'Settings', icon: 'folder', body: <p>{a} body</p> })} />
}
function mount(initial: ShellWins) {
  host = document.createElement('div'); document.body.appendChild(host)
  root = createRoot(host)
  act(() => root!.render(<Host initial={initial} />))
}
const frame = (a: string) => host!.querySelector<HTMLElement>(`[data-shell-window="${a}"]`)!
const button = (a: string, label: string) => [...frame(a).querySelectorAll('button')].find((b) => b.getAttribute('aria-label') === label)!
const pointer = (el: Element, type: string, x: number, y: number) => {
  const e = new MouseEvent(type, { bubbles: true, clientX: x, clientY: y, button: 0 })
  Object.defineProperty(e, 'pointerId', { value: 1 })
  act(() => { el.dispatchEvent(e) })
}

it('has Minimize, Maximize and Close in that order at the end of the title bar', () => {
  mount(openWin([], 'files'))
  const labels = [...frame('files').querySelectorAll('.ws-win-bar button')].map((b) => b.getAttribute('aria-label'))
  expect(labels).toEqual(['Minimize', 'Maximize', 'Close'])
  expect(frame('files').querySelector('.ws-win-bar')!.textContent).toContain('Files')
})

it('maximizes, shows Restore, restores; double-click on the title bar does the same', () => {
  mount(openWin([], 'files'))
  act(() => button('files', 'Maximize').click())
  expect(frame('files').dataset.maximized).toBe('true')
  expect(button('files', 'Restore')).toBeTruthy()
  // No resize grips while maximized.
  expect(frame('files').querySelectorAll('[data-edge]').length).toBe(0)
  act(() => button('files', 'Restore').click())
  expect(frame('files').dataset.maximized).toBe('false')
  expect(frame('files').querySelectorAll('[data-edge]').length).toBe(8)
  act(() => { frame('files').querySelector('.ws-win-bar span:nth-child(2)')!.dispatchEvent(new MouseEvent('dblclick', { bubbles: true })) })
  expect(frame('files').dataset.maximized).toBe('true')
})

it('minimizes without unmounting, and closes', () => {
  mount(openWin(openWin([], 'files'), 'settings'))
  expect(frame('settings').dataset.active).toBe('true')
  act(() => button('settings', 'Minimize').click())
  expect(frame('settings').hidden).toBe(true)
  expect(frame('settings').textContent).toContain('settings body')
  expect(frame('files').dataset.active).toBe('true')
  act(() => button('files', 'Close').click())
  expect(host!.querySelector('[data-shell-window="files"]')).toBeNull()
})

it('raises a window behind when it is clicked', () => {
  mount(openWin(openWin([], 'files'), 'settings'))
  expect(Number(frame('settings').style.zIndex)).toBeGreaterThan(Number(frame('files').style.zIndex))
  act(() => { frame('files').querySelector('p')!.dispatchEvent(new MouseEvent('pointerdown', { bubbles: true })) })
  expect(Number(frame('files').style.zIndex)).toBeGreaterThan(Number(frame('settings').style.zIndex))
  expect(frame('files').dataset.active).toBe('true')
})

it('moves by the title bar and resizes from a corner, not below the minimum', () => {
  mount(setRect(openWin([], 'files'), 'files', { x: 100, y: 100, w: 800, h: 600 }))
  const bar = frame('files').querySelector('.ws-win-bar')!
  pointer(bar, 'pointerdown', 300, 110); pointer(bar, 'pointermove', 350, 150); pointer(bar, 'pointerup', 350, 150)
  expect(current[0].rect).toMatchObject({ x: 150, y: 140, w: 800, h: 600 })
  const se = frame('files').querySelector('[data-edge="se"]')!
  pointer(se, 'pointerdown', 950, 740); pointer(se, 'pointermove', 0, 0); pointer(se, 'pointerup', 0, 0)
  expect(current[0].rect).toMatchObject({ x: 150, y: 140, w: 640, h: 420 })
})

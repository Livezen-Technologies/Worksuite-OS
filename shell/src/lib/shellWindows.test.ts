// The shell's own windows behave like Windows 11 windows (issues #15, #33): stacking, minimize, maximize, restore,
// move and resize within the work area, never below their minimum size.
import { describe, expect, it } from 'vitest'
import {
  KEEP_VISIBLE, MIN_SIZE, TITLE_BAR, activeWin, anyVisible, clampRect, closeWin, defaultRect, focusWin, minimizeWin, moveRect, openWin, resizeRect, setRect,
  taskbarClick, toggleMaxWin, type ShellWins,
} from './shellWindows'

const area = { w: 1600, h: 848 }

describe('stacking and window states', () => {
  it('opens on top, raises an open window instead of opening it twice, and closes', () => {
    let w: ShellWins = openWin([], 'files')
    w = openWin(w, 'settings')
    expect(w.map((x) => x.app)).toEqual(['files', 'settings'])
    expect(activeWin(w)).toBe('settings')
    w = openWin(w, 'files')
    expect(w.map((x) => x.app)).toEqual(['settings', 'files'])
    expect(activeWin(closeWin(w, 'files'))).toBe('settings')
  })

  it('minimizes to the taskbar, the next window down becomes active, and the taskbar restores it', () => {
    let w: ShellWins = openWin(openWin([], 'files'), 'settings')
    w = minimizeWin(w, 'settings')
    expect(activeWin(w)).toBe('files')
    expect(anyVisible(w)).toBe(true)
    w = minimizeWin(w, 'files')
    expect(activeWin(w)).toBeNull()
    expect(anyVisible(w)).toBe(false)
    w = taskbarClick(w, 'settings')
    expect(activeWin(w)).toBe('settings')
    expect(w.find((x) => x.app === 'settings')!.minimized).toBe(false)
  })

  it('taskbar: the active window minimizes, a window behind is raised', () => {
    let w: ShellWins = openWin(openWin([], 'files'), 'monitor')
    w = taskbarClick(w, 'files')
    expect(activeWin(w)).toBe('files')
    w = taskbarClick(w, 'files')
    expect(w.find((x) => x.app === 'files')!.minimized).toBe(true)
    expect(activeWin(w)).toBe('monitor')
  })

  it('maximizes and restores to the same place, and a move or resize leaves the maximized state', () => {
    let w: ShellWins = openWin([], 'settings')
    w = setRect(w, 'settings', { x: 40, y: 50, w: 900, h: 600 })
    w = toggleMaxWin(w, 'settings')
    expect(w[0].maximized).toBe(true)
    w = toggleMaxWin(w, 'settings')
    expect(w[0]).toMatchObject({ maximized: false, rect: { x: 40, y: 50, w: 900, h: 600 } })
    w = setRect(toggleMaxWin(w, 'settings'), 'settings', { x: 0, y: 0, w: 800, h: 600 })
    expect(w[0].maximized).toBe(false)
  })

  it('focus is a no-op for the active window (no re-render churn)', () => {
    const w: ShellWins = openWin([], 'files')
    expect(focusWin(w, 'files')).toBe(w)
  })
})

describe('geometry', () => {
  it('opens centred, at least the minimum size, cascaded', () => {
    const a = defaultRect('settings', area, 0), b = defaultRect('settings', area, 1)
    expect(a.w).toBeGreaterThanOrEqual(MIN_SIZE.settings.w)
    expect(a.x + a.w / 2).toBeCloseTo(area.w / 2, -1)
    expect(b.x - a.x).toBe(28)
    // A small screen: the window takes the whole work area, never more.
    expect(defaultRect('settings', { w: 600, h: 400 })).toEqual({ x: 0, y: 0, w: 600, h: 400 })
  })

  it('keeps the title bar reachable when dragged off the work area', () => {
    const r = moveRect({ x: 100, y: 100, w: 800, h: 600 }, -5000, -5000, area, MIN_SIZE.files)
    expect(r.y).toBe(0)
    expect(r.x + r.w).toBe(KEEP_VISIBLE)
    const s = moveRect({ x: 100, y: 100, w: 800, h: 600 }, 5000, 5000, area, MIN_SIZE.files)
    expect(s.x).toBe(area.w - KEEP_VISIBLE)
    expect(s.y).toBe(area.h - TITLE_BAR)
  })

  it('resizes from every edge and corner, stops at the minimum and at the work area', () => {
    const start = { x: 200, y: 100, w: 900, h: 600 }
    expect(resizeRect(start, 'e', 100, 0, area, MIN_SIZE.files)).toEqual({ x: 200, y: 100, w: 1000, h: 600 })
    expect(resizeRect(start, 'se', -2000, -2000, area, MIN_SIZE.files)).toEqual({ x: 200, y: 100, w: MIN_SIZE.files.w, h: MIN_SIZE.files.h })
    // West/north keep the right/bottom edge where it was.
    const nw = resizeRect(start, 'nw', 2000, 2000, area, MIN_SIZE.files)
    expect(nw.x + nw.w).toBe(1100)
    expect(nw.y + nw.h).toBe(700)
    expect(nw.w).toBe(MIN_SIZE.files.w)
    expect(resizeRect(start, 'nw', -5000, -5000, area, MIN_SIZE.files)).toEqual({ x: 0, y: 0, w: 1100, h: 700 })
    expect(resizeRect(start, 's', 0, 5000, area, MIN_SIZE.files).h).toBe(area.h - 100)
  })

  it('clamps a remembered size into a smaller screen (resolution or scale change)', () => {
    expect(clampRect({ x: 1500, y: 800, w: 1400, h: 900 }, { w: 1024, h: 700 }, MIN_SIZE.settings)).toEqual({ x: 0, y: 0, w: 1024, h: 700 })
  })
})

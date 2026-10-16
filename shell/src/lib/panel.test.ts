import { describe, expect, it } from 'vitest'
import { ACTIVATED, MINIMIZED, clickAction, onWorkspace, taskbarEntries, updateBadge, type PanelWindow } from './panel'
import type { OsUpdateStatus } from './os'

const w = (handle: string, appId: string, flags = 0, title = appId): PanelWindow => ({ handle, appId, title, output: 'HDMI-A-1', flags })

describe('taskbar entries', () => {
  it('puts windows under their pinned app, then other apps, and hides the shell itself', () => {
    const e = taskbarEntries(['mail', 'firefox', 'terminal'], [w('1', 'foot', ACTIVATED), w('2', 'firefox-esr'), w('3', 'org.gimp.GIMP'), w('4', 'worksuite-shell'), w('5', 'org.gimp.GIMP')])
    expect(e.map((x) => [x.id, x.windows.map((y) => y.handle), x.running, x.active])).toEqual([
      ['mail', [], false, false],
      ['firefox', ['2'], true, false],
      ['terminal', ['1'], true, true],
      ['org.gimp.GIMP', ['3', '5'], true, false],
    ])
  })

  it('a minimized window is not active', () => {
    expect(taskbarEntries(['terminal'], [w('1', 'foot', ACTIVATED | MINIMIZED)])[0].active).toBe(false)
  })
})

describe('click action', () => {
  const entry = (ws: PanelWindow[]) => taskbarEntries(['x'], ws.map((y) => ({ ...y, appId: 'x' })))[0]
  it('launches, minimizes the active window or raises the next one', () => {
    expect(clickAction(entry([]))).toEqual({ kind: 'launch' })
    expect(clickAction(entry([w('1', 'x', ACTIVATED)]))).toEqual({ kind: 'minimize', handle: '1' })
    expect(clickAction(entry([w('1', 'x', MINIMIZED)]))).toEqual({ kind: 'activate', handle: '1' })
    expect(clickAction(entry([w('1', 'x', ACTIVATED), w('2', 'x')]))).toEqual({ kind: 'activate', handle: '2' })
    expect(clickAction(entry([w('1', 'x'), w('2', 'x', ACTIVATED)]))).toEqual({ kind: 'activate', handle: '1' })
  })
})

describe('update badge (WSOS-AUP-011)', () => {
  const s = (state: OsUpdateStatus['state']) => ({ state } as OsUpdateStatus)
  it('maps update states', () => {
    expect(updateBadge(s('available'))).toBe('available')
    expect(updateBadge(s('waiting'))).toBe('available')
    expect(updateBadge(s('installing'))).toBe('downloading')
    expect(updateBadge(s('ready_to_restart'))).toBe('restart')
    expect(updateBadge(s('restart_pending'))).toBe('restart')
    expect(updateBadge(s('failed'))).toBe('failed')
    expect(updateBadge(s('up_to_date'))).toBeNull()
    expect(updateBadge(s('up_to_date'), 3)).toBe('available')
    expect(updateBadge(null)).toBeNull()
  })
})

describe('windows on the current workspace', () => {
  const w = (handle: string): PanelWindow => ({ handle, appId: 'foot', title: handle, output: 'HDMI-A-1', flags: 0 })
  it('keeps only the current workspace when the bridge has workspaces', () => {
    const ws = { supported: true, current: 2, count: 4, windows: { a: 1, b: 2 } }
    expect(onWorkspace([w('a'), w('b'), w('c')], ws).map((x) => x.handle)).toEqual(['b', 'c'])
    expect(onWorkspace([w('a'), w('b')], { ...ws, supported: false }).length).toBe(2)
  })
})

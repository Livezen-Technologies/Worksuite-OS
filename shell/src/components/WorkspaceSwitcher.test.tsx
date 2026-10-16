// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { panel, type Workspaces } from '../lib/panel'
import { RunningApps, WorkspaceSwitcher } from './PanelItems'

const ws: Workspaces = { supported: true, current: 1, count: 4, windows: { w1: 1, w2: 3 } }
let root: ReturnType<typeof createRoot>, el: HTMLDivElement
function render(node: React.ReactNode) {
  el = document.createElement('div'); document.body.append(el)
  root = createRoot(el)
  return act(async () => root.render(node))
}
afterEach(() => { act(() => root.unmount()); el.remove(); vi.restoreAllMocks() })

describe('panel workspace switcher (WSOS-DSK-003)', () => {
  it('shows the bridge workspaces and switches on click', async () => {
    vi.spyOn(panel, 'workspaces').mockResolvedValue(ws)
    const go = vi.fn().mockResolvedValue({ ok: true, value: true })
    panel.activateWorkspace = go
    await render(<WorkspaceSwitcher />)
    const buttons = [...el.querySelectorAll('button')]
    expect(buttons.map((b) => b.textContent)).toEqual(['1', '2', '3', '4'])
    expect(buttons[0].getAttribute('aria-pressed')).toBe('true')
    expect(buttons[2].getAttribute('aria-label')).toBe('Workspace 3, 1 windows')
    act(() => buttons[2].click())
    expect(go).toHaveBeenCalledWith(3)
  })

  it('is hidden where the compositor has no workspaces', async () => {
    vi.spyOn(panel, 'workspaces').mockResolvedValue({ ...ws, supported: false })
    await render(<WorkspaceSwitcher />)
    expect(el.querySelector('button')).toBeNull()
  })

  it('taskbar lists the current workspace and moves a window from its menu', async () => {
    vi.spyOn(panel, 'workspaces').mockResolvedValue(ws)
    vi.spyOn(panel, 'windows').mockResolvedValue([
      { handle: 'w1', appId: 'foot', title: 'Terminal', output: '', flags: 1 },
      { handle: 'w2', appId: 'firefox-esr', title: 'Web', output: '', flags: 0 },
    ])
    const move = vi.fn().mockResolvedValue({ ok: true, value: true })
    panel.moveToWorkspace = move
    await render(<RunningApps pinned={[]} info={() => undefined} onLaunch={() => undefined} />)
    const apps = [...el.querySelectorAll('[role=toolbar] > button')]
    expect(apps.map((b) => b.getAttribute('title'))).toEqual(['Terminal'])
    act(() => { apps[0].dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true })) })
    const items = [...el.querySelectorAll('[role=menuitem]')]
    expect(items.map((b) => b.textContent)).toEqual(['Workspace 2', 'Workspace 3', 'Workspace 4'])
    act(() => (items[1] as HTMLButtonElement).click())
    expect(move).toHaveBeenCalledWith('w1', 3)
  })
})

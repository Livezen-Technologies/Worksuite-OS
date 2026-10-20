// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { AppPermissionsSection, MediaInUseBadge } from './AppPermissions'
import type { AppPermsApi, Grant } from '../../lib/appPermsApi'

const g = globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }
beforeAll(() => { g.IS_REACT_ACT_ENVIRONMENT = true })
let root: Root | null = null
let host: HTMLDivElement | null = null
afterEach(() => { act(() => root?.unmount()); host?.remove(); delete window.worksuiteAppPerms })

function mount(grants: Grant[], inUse = { camera: [] as string[], microphone: [] as string[] }) {
  const api: AppPermsApi = {
    state: vi.fn(async () => ({ ok: true as const, value: { grants, inUse, enforcement: { camera: { mechanism: 'portal', scope: 'sandboxed' as const, stored: true }, clipboard: { mechanism: 'wayland_focus', scope: 'all' as const, stored: false } } } })),
    set: vi.fn(async () => ({ ok: true as const, value: true as const })),
    revoke: vi.fn(async () => ({ ok: true as const, value: true as const })),
    reset: vi.fn(async () => ({ ok: true as const, value: true as const })),
    recent: vi.fn(async () => [{ at: 1, app: 'com.example.Meet', resource: 'camera', action: 'allowed' as const, by: 'app_request' as const }]),
    inUse: vi.fn(async () => inUse),
  }
  window.worksuiteAppPerms = api
  host = document.createElement('div'); document.body.append(host); root = createRoot(host)
  return api
}

describe('Settings › App permissions (issue #21)', () => {
  it('lists grants per app; toggles, ask again and reset call the store', async () => {
    const api = mount([{ resource: 'camera', app: 'com.example.Meet', allowed: true, locked: false }, { resource: 'microphone', app: 'com.example.Meet', allowed: false, locked: false }])
    await act(async () => root!.render(<AppPermissionsSection />))
    expect(host!.textContent).toContain('com.example.Meet')
    expect(host!.textContent).toContain('Camera')
    const sw = host!.querySelector('[role="switch"][aria-label="Camera · com.example.Meet"]') as HTMLButtonElement
    await act(async () => sw.click())
    expect(api.set).toHaveBeenCalledWith('camera', 'com.example.Meet', false)
    await act(async () => ([...host!.querySelectorAll('button')].find((b) => b.textContent === 'Ask again') as HTMLButtonElement).click())
    expect(api.revoke).toHaveBeenCalledWith('camera', 'com.example.Meet')
    await act(async () => ([...host!.querySelectorAll('button')].find((b) => b.textContent === 'Reset app') as HTMLButtonElement).click())
    expect(api.reset).toHaveBeenCalledWith('com.example.Meet')
    expect(host!.textContent).toContain('answered in a prompt')
    expect(host!.textContent).toContain('Only the app you are using can read the clipboard')
  })
  it('organization locks disable the switch; apps in use are shown', async () => {
    mount([{ resource: 'camera', app: 'com.example.Meet', allowed: false, locked: true }], { camera: ['com.example.Meet'], microphone: [] })
    await act(async () => root!.render(<AppPermissionsSection />))
    expect((host!.querySelector('[role="switch"]') as HTMLButtonElement).disabled).toBe(true)
    expect(host!.textContent).toContain('Organization')
    expect(host!.textContent).toContain('com.example.Meet is using the camera now')
  })
  it('taskbar badge while the microphone is in use; nothing otherwise', async () => {
    mount([], { camera: [], microphone: ['com.example.Meet'] })
    await act(async () => root!.render(<MediaInUseBadge pollMs={10_000} />))
    expect(host!.querySelector('[role="status"]')?.textContent).toContain('Microphone on')
    act(() => root!.unmount()); host!.remove()
    mount([])
    await act(async () => root!.render(<MediaInUseBadge pollMs={10_000} />))
    expect(host!.textContent).toBe('')
  })
})

// @vitest-environment jsdom
// WSOS-ARC-004: the desktop is usable with every remote service unreachable. All cloud-backed bridge calls answer
// "offline" (as the Electron main process does when the network is down) and any network request from the renderer
// throws. The desktop, launcher, local apps, Files and Settings must still work and nothing may hang on the network.
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import Desktop from './screens/Desktop'
import Files from './screens/Files'
import Settings from './screens/Settings'
import Lock from './screens/Lock'
import { useNotices } from './lib/useNotices'
import { os } from './lib/os'

const OFFLINE = { ok: false as const, error: 'offline' }
const net: string[] = []

beforeAll(() => {
  ;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true
  window.matchMedia ??= ((q: string) => ({ matches: false, media: q, addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {}, onchange: null, dispatchEvent: () => false })) as unknown as typeof window.matchMedia
  Element.prototype.scrollIntoView ??= function () {}
  HTMLElement.prototype.animate ??= function () { return { cancel() {}, finished: Promise.resolve() } as unknown as Animation }
  // Remote services unreachable: every request fails at once, and is recorded.
  globalThis.fetch = (async (u: RequestInfo | URL) => { net.push(String(u)); throw new TypeError('Failed to fetch (ENETUNREACH)') }) as typeof fetch
  window.WebSocket = class { constructor(u: string) { net.push(u); throw new Error('ENETUNREACH') } } as unknown as typeof WebSocket
  const api = os as unknown as Record<string, unknown>
  Object.assign(api, {
    webApps: async () => OFFLINE, shellPrefs: async () => OFFLINE, setShellPrefs: async () => OFFLINE,
    cloudAccounts: async () => OFFLINE, syncStatus: async () => ({ ok: true, value: { state: 'offline', pending: 3, failed: 0, conflicts: 0, last_sync: null } }),
    syncNow: async () => OFFLINE, syncUnsent: async () => OFFLINE,
    recentFiles: async () => ({ local: [], cloud: { state: 'offline', hits: [] } }),
    search: async (q: string) => ({ query: q, sources: [{ source: 'worksuite', state: 'offline', hits: [] }, { source: 'drive', state: 'offline', hits: [] }], hits: [] }),
    pkgCatalog: async () => OFFLINE, pkgCheckUpdates: async () => OFFLINE,
  })
})

let root: Root | null = null
let host: HTMLElement | null = null
afterEach(() => { act(() => root?.unmount()); host?.remove(); root = null; host = null })

async function render(ui: React.ReactElement) {
  host = document.createElement('div'); document.body.appendChild(host)
  root = createRoot(host)
  await act(async () => { root!.render(ui) })
  await act(async () => { await new Promise((r) => setTimeout(r, 30)) })
  return host
}
const button = (el: HTMLElement, name: string) => [...el.querySelectorAll<HTMLElement>('button')].find((b) => b.getAttribute('aria-label') === name || b.textContent?.trim() === name)

function DesktopHost({ onOpen }: { onOpen: (s: string) => void }) {
  const notes = useNotices(false)
  return <Desktop user="hasarinda" onLock={() => {}} onLogout={() => {}} onOpen={onOpen} notes={notes} />
}

describe('desktop with all remote services unreachable (WSOS-ARC-004)', () => {
  it('desktop, taskbar, clock and launcher work; local and WorkSuite apps are listed and start', async () => {
    const launched = vi.spyOn(os, 'launchApp')
    const opened: string[] = []
    const el = await render(<DesktopHost onOpen={(s) => opened.push(s)} />)
    expect(el.querySelector('nav')).not.toBeNull()
    expect(el.textContent).toMatch(/\d{1,2}:\d{2}/)
    await act(async () => { button(el, 'Open launcher')!.click() })
    await act(async () => { await new Promise((r) => setTimeout(r, 30)) })
    const dlg = el.querySelector('#ws-launcher')!
    expect(dlg).not.toBeNull()
    await act(async () => { button(dlg as HTMLElement, 'All apps')!.click() })
    const names = [...dlg.querySelectorAll('button')].map((b) => b.textContent ?? '')
    expect(names.some((n) => n.includes('Firefox ESR'))).toBe(true)   // installed Linux app (XDG, local)
    expect(names.some((n) => n.includes('Mail'))).toBe(true)          // WorkSuite app (window shows its own sign-in/offline state)
    await act(async () => { [...dlg.querySelectorAll<HTMLElement>('button')].find((b) => b.textContent?.includes('Foot'))!.click() })
    expect(launched).toHaveBeenCalledWith('foot')
  })

  it('Files, Settings and Lock open and render without the network', async () => {
    for (const ui of [<Files onClose={() => {}} />, <Settings onClose={() => {}} />, <Lock user="hasarinda" onUnlock={() => {}} notices={[]} />]) {
      const el = await render(ui)
      expect(el.querySelectorAll('button').length).toBeGreaterThan(0)
      act(() => root?.unmount()); host?.remove(); root = null
    }
  })

  it('the renderer itself never tried to reach a remote host', () => {
    // Relative paths are the dev preview's own stubs (same origin); a remote host would be an absolute URL.
    expect(net.filter((u) => /^(https?|wss?):/i.test(u))).toEqual([])
  })
})

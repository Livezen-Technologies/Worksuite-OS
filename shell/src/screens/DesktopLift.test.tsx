// @vitest-environment jsdom
// The shell's window is always on bottom (Labwc), so its own panels and windows ask to be lifted over the apps while
// they are open, and to go back below them once closed (electron/panelHost.ts shellLift).
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeAll, expect, it, vi } from 'vitest'
import Desktop from './Desktop'
import { panel } from '../lib/panel'
import { useNotices } from '../lib/useNotices'
import { os } from '../lib/os'

beforeAll(() => {
  ;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true
  window.matchMedia ??= ((q: string) => ({ matches: false, media: q, addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {}, onchange: null, dispatchEvent: () => false })) as unknown as typeof window.matchMedia
  Element.prototype.scrollIntoView ??= function () {}
  HTMLElement.prototype.animate ??= function () { return { cancel() {}, finished: Promise.resolve() } as unknown as Animation }
})
let root: Root | null = null
let host: HTMLElement | null = null
afterEach(() => { act(() => root?.unmount()); host?.remove(); vi.restoreAllMocks() })
const settle = () => act(async () => { await new Promise((r) => setTimeout(r, 20)) })

function Host({ open }: { open: boolean }) {
  const notes = useNotices(false)
  return <Desktop user="alex" onLock={() => {}} onLogout={() => {}} onOpen={() => {}} notes={notes}>{open ? <div>Settings</div> : null}</Desktop>
}

it('lifts the shell while the launcher or a shell window is open, and puts it back after', async () => {
  const onTop = vi.spyOn(panel, 'shellOnTop')
  host = document.createElement('div'); document.body.appendChild(host)
  root = createRoot(host)
  await act(async () => { root!.render(<Host open={false} />) })
  await settle()
  expect(onTop).toHaveBeenLastCalledWith(false)
  const start = host.querySelector<HTMLButtonElement>('button[aria-label="Open launcher"]')!
  await act(async () => { start.click() })
  await settle()
  expect(onTop).toHaveBeenLastCalledWith(true)
  await act(async () => { start.click() })
  await settle()
  expect(onTop).toHaveBeenLastCalledWith(false)
  await act(async () => { root!.render(<Host open />) })
  await settle()
  expect(onTop).toHaveBeenLastCalledWith(true)
  await act(async () => { root!.render(<Host open={false} />) })
  await settle()
  expect(onTop).toHaveBeenLastCalledWith(false)
})

it('hands a toast to worksuite-toasts (over the apps) and does not draw it in its own window', async () => {
  vi.spyOn(os, 'toastsAvailable').mockResolvedValue(true)
  const show = vi.spyOn(os, 'toastShow').mockResolvedValue(true)
  const setToast = vi.fn()
  const notes = { notices: [], setNotices: () => {}, toast: { id: 'app-12', tone: 'ok' as const, title: 'Firefox', body: 'Download finished', icon: 'firefox-esr' }, setToast, unread: 1, setUnread: () => {} }
  host = document.createElement('div'); document.body.appendChild(host)
  root = createRoot(host)
  await act(async () => { root!.render(<Desktop user="alex" onLock={() => {}} onLogout={() => {}} onOpen={() => {}} notes={notes as never} />) })
  await settle()
  expect(show).toHaveBeenCalledWith({ key: 'app-12', title: 'Firefox', body: 'Download finished', tone: 'ok', icon: 'firefox-esr' })
  expect(setToast).toHaveBeenCalledWith(null)
  expect(host.textContent).not.toContain('Download finished')
})

it('goes behind an app that took the focus: menus close, a shell window waits until opened again', async () => {
  const onTop = vi.spyOn(panel, 'shellOnTop')
  let behind: () => void = () => undefined
  panel.onShellBehind = (cb) => { behind = cb; return () => { behind = () => undefined } }
  try {
    host = document.createElement('div'); document.body.appendChild(host)
    root = createRoot(host)
    await act(async () => { root!.render(<Host open />) })
    await settle()
    expect(onTop).toHaveBeenLastCalledWith(true)
    const start = host.querySelector<HTMLButtonElement>('button[aria-label="Open launcher"]')!
    await act(async () => { start.click() })
    await settle()
    await act(async () => { behind() })        // Firefox clicked in the taskbar
    await settle()
    expect(onTop).toHaveBeenLastCalledWith(false)
    expect(host.querySelector('input[type="search"], [role="dialog"][aria-label*="aunch"]')).toBeNull()
    await act(async () => { start.click() })  // the launcher again: over the apps again
    await settle()
    expect(onTop).toHaveBeenLastCalledWith(true)
  } finally {
    delete panel.onShellBehind
  }
})

it('puts the shell below the apps while its windows are all minimized, and restores one from the taskbar (#33)', async () => {
  const onTop = vi.spyOn(panel, 'shellOnTop')
  const press = vi.fn()
  function Wins({ minimized }: { minimized: boolean }) {
    const notes = useNotices(false)
    return (
      <Desktop user="alex" onLock={() => {}} onLogout={() => {}} onOpen={() => {}} notes={notes} onShellWindow={press}
        shellWindows={[{ app: 'settings', title: 'Settings', icon: 'settings', minimized, active: !minimized }]}><div>Settings</div></Desktop>
    )
  }
  host = document.createElement('div'); document.body.appendChild(host)
  root = createRoot(host)
  await act(async () => { root!.render(<Wins minimized={false} />) })
  await settle()
  expect(onTop).toHaveBeenLastCalledWith(true)
  await act(async () => { root!.render(<Wins minimized />) })
  await settle()
  expect(onTop).toHaveBeenLastCalledWith(false)
  const task = host.querySelector<HTMLButtonElement>('button[data-shell-task="settings"]')!
  expect(task.getAttribute('aria-label')).toBe('Settings, running')
  await act(async () => { task.click() })
  expect(press).toHaveBeenCalledWith('settings', 'toggle')
})

// @vitest-environment jsdom
// The shell's window is always on bottom (Labwc), so its own panels and windows ask to be lifted over the apps while
// they are open, and to go back below them once closed (electron/panelHost.ts shellLift).
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeAll, expect, it, vi } from 'vitest'
import Desktop from './Desktop'
import { panel } from '../lib/panel'
import { useNotices } from '../lib/useNotices'

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

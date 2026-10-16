// @vitest-environment jsdom
// Files: Undo after Delete puts the items back from the Trash — from the toast and with Ctrl+Z.
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeAll, expect, it, vi } from 'vitest'
import Files from './Files'
import { os } from '../lib/os'

beforeAll(() => {
  ;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true
  window.matchMedia ??= ((q: string) => ({ matches: false, media: q, addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {}, onchange: null, dispatchEvent: () => false })) as unknown as typeof window.matchMedia
  Element.prototype.scrollIntoView ??= function () {}
})
let root: Root | null = null
let host: HTMLElement | null = null
afterEach(() => { act(() => root?.unmount()); host?.remove(); vi.restoreAllMocks() })
const settle = () => act(async () => { await new Promise((r) => setTimeout(r, 20)) })
const key = (el: Element, k: string, ctrl = false) => act(async () => { el.dispatchEvent(new KeyboardEvent('keydown', { key: k, ctrlKey: ctrl, bubbles: true })) })

async function deleteNotes() {
  host = document.createElement('div'); document.body.appendChild(host)
  root = createRoot(host)
  await act(async () => { root!.render(<Files onClose={() => {}} />) })
  await settle()
  const row = [...host.querySelectorAll('button')].find((b) => b.textContent?.includes('Meeting notes.md'))!
  await act(async () => { row.click() })
  await key(document.activeElement && host.contains(document.activeElement) ? document.activeElement : row, 'Delete')
  await settle()
  const dialog = host.querySelector('[role="alertdialog"], [role="dialog"][aria-modal="true"]') ?? host
  const confirm = [...dialog.querySelectorAll('button')].reverse().find((b) => /trash/i.test(b.textContent ?? ''))!
  await act(async () => { confirm.click() })
  await settle()
  return row
}

it('Ctrl+Z restores what Delete moved to the Trash, once', async () => {
  const trash = vi.spyOn(os, 'filesTrash')
  const restore = vi.spyOn(os, 'filesTrashRestore')
  const row = await deleteNotes()
  expect(trash).toHaveBeenCalledWith('home', ['Documents/Meeting notes.md'])
  expect(host!.contains(document.activeElement)).toBe(true)   // focus is back in Files after the dialog
  await key(document.activeElement!, 'z', true)
  await settle()
  expect(restore).toHaveBeenCalledWith(['Meeting notes.md'])
  await key(document.activeElement!, 'z', true)
  await settle()
  expect(restore).toHaveBeenCalledTimes(1)
})

it("the toast's Undo restores from the Trash", async () => {
  const restore = vi.spyOn(os, 'filesTrashRestore')
  await deleteNotes()
  const undo = [...host!.querySelectorAll('button')].find((b) => b.textContent === 'Undo')!
  expect(undo).toBeTruthy()
  await act(async () => { undo.click() })
  await settle()
  expect(restore).toHaveBeenCalledWith(['Meeting notes.md'])
})

it('says that the item is back, or that there was nothing to undo', async () => {
  vi.spyOn(os, 'filesTrashRestore').mockResolvedValueOnce({ ok: true, value: { restored: 1, skipped: 0 } })
  await deleteNotes()
  const undo = [...host!.querySelectorAll('button')].find((b) => b.textContent === 'Undo')!
  await act(async () => { undo.click() })
  await settle()
  expect(host!.textContent).toContain('“Meeting notes.md” is back')
  vi.spyOn(os, 'filesTrashRestore').mockResolvedValueOnce({ ok: true, value: { restored: 0, skipped: 1 } })
  await deleteNotes()
  const again = [...host!.querySelectorAll('button')].filter((b) => b.textContent === 'Undo').at(-1)!
  await act(async () => { again.click() })
  await settle()
  expect(host!.textContent).toContain('Nothing to undo')
})

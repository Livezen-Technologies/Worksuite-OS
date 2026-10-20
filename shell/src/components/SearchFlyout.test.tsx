// @vitest-environment jsdom
// Taskbar search as a floating panel (#29) that closes reliably (#30).
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import SearchFlyout, { flyoutLeft } from './SearchFlyout'
import { os } from '../lib/os'

const g = globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }
beforeAll(() => { g.IS_REACT_ACT_ENVIRONMENT = true })
let root: Root | null = null
let host: HTMLDivElement | null = null
afterEach(() => { act(() => root?.unmount()); host?.remove(); document.body.innerHTML = ''; root = null; host = null; vi.restoreAllMocks() })

async function render(onClose = vi.fn()) {
  vi.spyOn(os, 'search').mockResolvedValue({ query: '', sources: [], hits: [] })
  vi.spyOn(os, 'recentFiles').mockResolvedValue({ local: [], cloud: { state: 'ok', hits: [] } })
  document.body.innerHTML = '<button data-search-toggle id="toggle">Search</button><div id="outside">app</div>'
  host = document.createElement('div'); document.body.append(host)
  root = createRoot(host)
  await act(async () => {
    root!.render(<SearchFlyout anchorLeft={80} toggleSelector="[data-search-toggle]" query="" onQuery={() => {}} apps={[]} settings={[]}
      onLaunchApp={() => {}} onOpenSettings={() => {}} onClose={onClose} />)
  })
  return onClose
}

describe('taskbar search panel', () => {
  it('is a compact, non-modal panel with the field focused at once', async () => {
    await render()
    const dlg = document.getElementById('ws-search')!
    expect(dlg.dataset.compact).toBe('true')
    expect(dlg.getAttribute('aria-modal')).toBeNull()
    expect(dlg.className).toContain('w-[560px]')
    expect(document.activeElement).toBe(dlg.querySelector('input'))
    expect(dlg.querySelector('aside')).toBeNull()
  })

  it('closes on Escape, the Esc button and a click outside, but not on a click inside or on its own control', async () => {
    const onClose = await render()
    const dlg = document.getElementById('ws-search')!
    act(() => { dlg.querySelector('input')!.dispatchEvent(new MouseEvent('mousedown', { bubbles: true })) })
    act(() => { document.getElementById('toggle')!.dispatchEvent(new MouseEvent('mousedown', { bubbles: true })) })
    expect(onClose).not.toHaveBeenCalled()
    act(() => { document.getElementById('outside')!.dispatchEvent(new MouseEvent('mousedown', { bubbles: true })) })
    expect(onClose).toHaveBeenCalledTimes(1)
    act(() => { dlg.querySelector('input')!.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })) })
    expect(onClose).toHaveBeenCalledTimes(2)
    act(() => { dlg.querySelector<HTMLButtonElement>('button[title="Esc"]')!.click() })
    expect(onClose).toHaveBeenCalledTimes(3)
  })

  it('sits over its control and stays on screen', () => {
    expect(flyoutLeft(80, 1920)).toBe(80)
    expect(flyoutLeft(1800, 1920)).toBe(1920 - 560 - 12)
    expect(flyoutLeft(-5, 1920)).toBe(12)
  })
})

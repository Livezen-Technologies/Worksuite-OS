// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { os, type FileEntry, type FileJob } from '../../lib/os'
import { ConflictDialog, DeleteDialog, JobErrorCard, JobsWindow, finishedToast } from './ops'

const g = globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }
beforeAll(() => { g.IS_REACT_ACT_ENVIRONMENT = true })
let root: Root | null = null
let host: HTMLDivElement | null = null
afterEach(() => { act(() => root?.unmount()); host?.remove(); root = null; host = null; vi.restoreAllMocks() })
function render(node: React.ReactNode) { host = document.createElement('div'); document.body.append(host); root = createRoot(host); act(() => root!.render(node)) }
const button = (name: string) => [...host!.querySelectorAll<HTMLButtonElement>('button')].find((b) => b.textContent === name || b.getAttribute('aria-label') === name)!
const radio = (name: RegExp) => [...host!.querySelectorAll<HTMLButtonElement>('[role=radio]')].find((b) => name.test(b.textContent ?? ''))!

const job = (p: Partial<FileJob>): FileJob => ({ id: 'j1', op: 'copy', dest: 'KINGSTON', state: 'running', done: 2, total: 8, bytes_done: 2e6, bytes_total: 8e6, conflict: null, src: '~/Pictures', current: 'a.jpg', free: 5e9, started: 0, error: null, error_name: null, ...p })

describe('file operations (FO1–FO4)', () => {
  it('FO1 lists every job with pause and cancel, and pauses through the job service', () => {
    const spy = vi.spyOn(os, 'filesResolve').mockResolvedValue({ ok: true, value: true })
    render(<JobsWindow jobs={[job({}), job({ id: 'j2', op: 'move', state: 'paused' })]} notify={false} setNotify={() => {}} onMinimize={() => {}} />)
    expect(host!.textContent).toContain('2 operations in progress')
    expect(host!.textContent).toContain('~/Pictures → KINGSTON')
    expect(host!.textContent).toContain('Paused')
    act(() => button('Pause').click())
    expect(spy).toHaveBeenCalledWith('j1', 'pause', false)
    act(() => button('Resume').click())
    expect(spy).toHaveBeenCalledWith('j2', 'resume', false)
  })

  it('FO2 sends the chosen action, for all conflicts when ticked', () => {
    const spy = vi.spyOn(os, 'filesResolve').mockResolvedValue({ ok: true, value: true })
    render(<ConflictDialog job={job({ state: 'conflict', conflict: { name: 'Proposal.docx', incoming: { size: 201_000, modified: 2 }, existing: { size: 184_000, modified: 1 }, remaining: 6, index: 1, count: 7 } })} />)
    expect(host!.textContent).toContain('conflict 1 of 7')
    expect(host!.textContent).toContain('Proposal (2).docx')
    act(() => radio(/^Replace/).click())
    act(() => host!.querySelector<HTMLInputElement>('input[type=checkbox]')!.click())
    act(() => button('Replace all').click())
    expect(spy).toHaveBeenCalledWith('j1', 'replace', true)
  })

  it('FO3 starts in the mode asked for and confirms the chosen one', () => {
    const items: FileEntry[] = [{ name: 'a.txt', dir: false, size: 4000, modified: null, state: 'local', local: true }, { name: 'Old', dir: true, size: null, modified: null, state: 'folder', local: true, items: 311 }]
    const ok = vi.fn()
    render(<DeleteDialog items={items} permanent={false} canTrash onCancel={() => {}} onConfirm={ok} />)
    expect(host!.textContent).toContain('Move 2 items to Trash?')
    expect(host!.textContent).toContain('311 items')
    act(() => radio(/permanently/).click())
    expect(host!.textContent).toContain('Delete 2 items permanently?')
    act(() => button('Delete permanently').click())
    expect(ok).toHaveBeenCalledWith(true)
  })

  it('FO4 explains a stopped job and offers retry, skip and cancel', () => {
    const spy = vi.spyOn(os, 'filesResolve').mockResolvedValue({ ok: true, value: true })
    render(<JobErrorCard job={job({ state: 'error', error: 'busy', error_name: 'report.xlsx' })} />)
    expect(host!.textContent).toContain('“report.xlsx” is open in another app')
    act(() => button('Skip').click())
    expect(spy).toHaveBeenCalledWith('j1', 'skip', false)
    expect(finishedToast(job({ state: 'cancelled' }))).toBeNull()
    expect(finishedToast(job({ state: 'done', done: 1 }))?.text).toBe('1 item copied to KINGSTON')
  })
})

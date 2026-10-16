// @vitest-environment jsdom
// §11.6-d: the report is collected only on request, every section is shown for review, and only kept sections go out.
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { ReportProblem } from './ReportProblem'
import { os, type ProblemReport } from '../../lib/os'

const g = globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }
beforeAll(() => { g.IS_REACT_ACT_ENVIRONMENT = true })
let root: Root | null = null
let host: HTMLDivElement | null = null
afterEach(() => { act(() => root?.unmount()); host?.remove(); root = null; host = null; vi.restoreAllMocks() })
const mount = () => { host = document.createElement('div'); document.body.append(host); root = createRoot(host); act(() => root!.render(<ReportProblem />)); return host }
const click = (el: Element | null | undefined) => act(async () => { (el as HTMLElement).click() })
const byText = (el: Element, s: string) => [...el.querySelectorAll('button')].find((b) => b.textContent === s)

const report: ProblemReport = { id: 'abcdef12-0000', created_at: '2026-10-16T00:00:00Z', sections: [
  { id: 'system', text: 'OS: WorkSuite OS 1.0', available: true },
  { id: 'session_log', text: 'warning: something', available: true },
  { id: 'system_log', text: '', available: false },
] }

describe('ReportProblem', () => {
  it('collects nothing until asked; then shows each section for review', async () => {
    const collect = vi.spyOn(os, 'reportCollect').mockResolvedValue({ ok: true, value: report })
    const el = mount()
    expect(collect).not.toHaveBeenCalled()
    await click(byText(el, 'Collect report'))
    expect(collect).toHaveBeenCalledOnce()
    const boxes = el.querySelectorAll<HTMLInputElement>('input[type=checkbox]')
    expect([...boxes].map((b) => [b.checked, b.disabled])).toEqual([[true, false], [true, false], [false, true]])
    await click(byText(el, 'Show'))
    expect(el.querySelector('pre')!.textContent).toBe('OS: WorkSuite OS 1.0')
  })

  it('sends only the sections left ticked, with the description', async () => {
    vi.spyOn(os, 'reportCollect').mockResolvedValue({ ok: true, value: report })
    const send = vi.spyOn(os, 'reportSend').mockResolvedValue({ ok: true, value: report.id })
    const el = mount()
    await click(byText(el, 'Collect report'))
    await click(el.querySelectorAll('input[type=checkbox]')[1])
    const ta = el.querySelector('textarea')!
    await act(async () => { const set = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!; set.call(ta, 'Wi-Fi drops'); ta.dispatchEvent(new Event('input', { bubbles: true })) })
    await click(byText(el, 'Send to IT'))
    expect(send).toHaveBeenCalledWith(report.id, ['system'], 'Wi-Fi drops')
    expect(el.querySelector('[role=status]')!.textContent).toContain('abcdef12')
  })

  it('offline: says so and offers saving instead; preview has no report at all', async () => {
    vi.spyOn(os, 'reportCollect').mockResolvedValue({ ok: true, value: report })
    vi.spyOn(os, 'reportSend').mockResolvedValue({ ok: false, error: 'offline' })
    const el = mount()
    await click(byText(el, 'Collect report'))
    await click(byText(el, 'Send to IT'))
    expect(el.querySelector('[role=alert]')!.textContent).toMatch(/Save the report to a file/)
    act(() => root?.unmount()); host?.remove()
    vi.spyOn(os, 'reportCollect').mockResolvedValue({ ok: false, error: 'service_unavailable' })
    const el2 = mount()
    await click(byText(el2, 'Collect report'))
    expect(el2.querySelector('[role=alert]')!.textContent).toContain('can’t be collected')
    expect(el2.querySelector('input')).toBeNull()
  })
})

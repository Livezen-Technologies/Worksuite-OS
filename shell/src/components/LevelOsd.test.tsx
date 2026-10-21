// @vitest-environment jsdom
// #62: the Fn-key level shows in the shell when the overlay helper can't draw it, then goes away.
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { beforeAll, describe, expect, it, vi } from 'vitest'
import { LevelOsd, OSD_MS } from './LevelOsd'
import type { OsdLevel } from '../lib/captureApi'

beforeAll(() => { (globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true })

describe('#62 level indicator', () => {
  it('shows volume, brightness and muted, and hides after a moment', () => {
    vi.useFakeTimers()
    let push: (o: OsdLevel) => void = () => undefined
    const api = { onOsd: (cb: (o: OsdLevel) => void) => { push = cb; return () => undefined } }
    const host = document.createElement('div'); document.body.append(host)
    const root = createRoot(host)
    act(() => root.render(<LevelOsd api={api} />))
    expect(host.querySelector('[data-testid="level-osd"]')).toBeNull()
    act(() => push({ kind: 'volume', value: 45, muted: false }))
    expect(host.textContent).toMatch(/Volume.*45%/)
    act(() => push({ kind: 'brightness', value: 80, muted: false }))
    expect(host.textContent).toMatch(/Brightness.*80%/)
    act(() => push({ kind: 'mic', value: 100, muted: true }))
    expect(host.textContent).toMatch(/Microphone.*Muted/)
    act(() => { vi.advanceTimersByTime(OSD_MS + 10) })
    expect(host.querySelector('[data-testid="level-osd"]')).toBeNull()
    act(() => root.unmount()); host.remove(); vi.useRealTimers()
  })
})

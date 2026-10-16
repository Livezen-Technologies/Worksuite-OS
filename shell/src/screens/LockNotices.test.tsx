// @vitest-environment jsdom
// WSOS-INT-007: the lock screen names the app of an app notification, never its summary or body.
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { describe, expect, it } from 'vitest'
import Lock from './Lock'

;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true

describe('lock screen notices', () => {
  it('hides app notification content', () => {
    const host = document.createElement('div'); document.body.append(host)
    const root = createRoot(host)
    act(() => root.render(<Lock user="u" onUnlock={() => {}} notices={[{ id: 'app-1', title: 'Salary details from HR', at: Date.now(), tone: 'ok', app: 'Mail' }]} />))
    expect(host.textContent).toContain('Mail')
    expect(host.textContent).not.toContain('Salary')
    act(() => root.unmount()); host.remove()
  })
})

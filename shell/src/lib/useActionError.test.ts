// @vitest-environment jsdom
// Settings and Quick Settings show why an action failed instead of dropping the result, and Do Not Disturb survives
// a shell restart.
import { describe, expect, it, vi } from 'vitest'
import { failureOf } from './useActionError'

describe('failureOf', () => {
  it('reads Avail and Reply failures, and treats success or nothing as success', () => {
    expect(failureOf({ available: false, reason: 'nmcli_missing' })).toBe('nmcli_missing')
    expect(failureOf({ ok: false, error: 'not_authorized' })).toBe('not_authorized')
    expect(failureOf({ available: false })).toBe('failed')
    expect(failureOf({ available: true, value: true })).toBeNull()
    expect(failureOf(undefined)).toBeNull()
  })
})

describe('do not disturb', () => {
  it('is remembered across a shell restart', async () => {
    localStorage.clear()
    const a = await import('./dnd')
    a.setDnd(true)
    expect(localStorage.getItem('ws.dnd')).toBe('1')
    vi.resetModules()
    const b = await import('./dnd')
    let seen: boolean | null = null
    // The fresh module starts from the stored value.
    window.addEventListener('ws:dnd', (e) => { seen = (e as CustomEvent).detail })
    b.setDnd(false)
    expect(seen).toBe(false)
    expect(localStorage.getItem('ws.dnd')).toBe('0')
  })
})

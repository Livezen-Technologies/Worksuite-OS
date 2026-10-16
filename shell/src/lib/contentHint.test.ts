// @vitest-environment jsdom
import { describe, expect, it } from 'vitest'
import { contentHintFor } from './touch'

const field = (html: string) => { const d = document.createElement('div'); d.innerHTML = html; return d.firstElementChild }

describe('field type for the on-screen keyboard (text-input-v3 purpose/hints)', () => {
  it('maps HTML input types and inputmode', () => {
    expect(contentHintFor(field('<input type="email">')).purpose).toBe(6)
    expect(contentHintFor(field('<input type="url">')).purpose).toBe(5)
    expect(contentHintFor(field('<input type="tel">')).purpose).toBe(4)
    expect(contentHintFor(field('<input inputmode="numeric">')).purpose).toBe(3)
    expect(contentHintFor(field('<input type="password">'))).toEqual({ purpose: 8, hints: 0x40 | 0x80 })
    expect(contentHintFor(field('<input type="password" inputmode="numeric">')).purpose).toBe(9)
    expect(contentHintFor(field('<input type="password" pattern="[0-9]{6,12}">')).purpose).toBe(9)
    expect(contentHintFor(field('<input autocomplete="one-time-code">')).hints & 0x80).toBe(0x80)
    expect(contentHintFor(field('<textarea></textarea>'))).toEqual({ purpose: 0, hints: 0x1 | 0x4 })
  })
})

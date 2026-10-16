import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

describe('shell scrollbars', () => {
  it('styles every scrolling panel (no white native scrollbar in the Settings sidebar)', () => {
    const css = readFileSync(new URL('./index.css', import.meta.url), 'utf8')
    expect(css).toMatch(/\*\s*\{\s*scrollbar-width: thin; scrollbar-color: [^;]+ transparent;/)
    expect(css).toMatch(/\*::-webkit-scrollbar-track[^{]*\{ background: transparent; \}/)
  })
})

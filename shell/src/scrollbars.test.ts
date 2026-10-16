import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

describe('shell scrollbars', () => {
  it('styles every scrolling panel (no white native scrollbar in the Settings sidebar)', () => {
    const css = readFileSync(new URL('./index.css', import.meta.url), 'utf8')
    expect(css).toMatch(/\*\s*\{\s*scrollbar-width: thin; scrollbar-color: [^;]+ transparent;/)
    expect(css).toMatch(/\*::-webkit-scrollbar-track[^{]*\{ background: transparent; \}/)
  })
})

describe('focus ring', () => {
  const css = readFileSync(new URL('./index.css', import.meta.url), 'utf8')
  it('keeps the ring on controls', () => expect(css).toMatch(/:focus-visible \{ outline: 2px solid #7FB2FF;/))
  it('draws no ring on script-focused headings (first run titles)', () => {
    expect(css).toContain('[tabindex="-1"]:focus-visible { outline: none; box-shadow: none; }')
    expect(css).toContain('[data-high-contrast] :focus-visible:not([tabindex="-1"])')
  })
})

describe('password fields in rounded containers (lock, greeter)', () => {
  const css = readFileSync(new URL('./index.css', import.meta.url), 'utf8')
  it('draw no dark halo box on the bare input', () => {
    expect(css).toContain(':is(input, textarea, select).outline-none:focus-visible { box-shadow: none; }')
  })
})

// Dropdowns (#61): the native option list follows the theme with WCAG AA contrast, in every screen.
import { readFileSync, readdirSync, statSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { contrast } from './lib/contrast'

const css = readFileSync(new URL('./index.css', import.meta.url), 'utf8')
const rule = (sel: string) => {
  const i = css.indexOf(`${sel} {`)
  expect(i, sel).toBeGreaterThanOrEqual(0)
  const body = css.slice(i, css.indexOf('}', i))
  return { bg: /background-color: (#[0-9A-Fa-f]{6})/.exec(body)?.[1] ?? '', fg: /[^-]color: (#[0-9A-Fa-f]{6})/.exec(body)?.[1] ?? '' }
}

describe('dropdown option colours (#61)', () => {
  it('sets a colour scheme per theme so Chromium does not draw a white list', () => {
    expect(css).toContain('select { color-scheme: dark; }')
    expect(css).toContain(':root[data-theme="light"] select:not(.ws-dark-zone *) { color-scheme: light; }')
  })
  it.each([
    ['select option, select optgroup'],
    ['select option:checked'],
    [':root[data-theme="light"] select:not(.ws-dark-zone *) :is(option, optgroup)'],
    [':root[data-theme="light"] select:not(.ws-dark-zone *) option:checked'],
    ['[data-high-contrast] select :is(option, optgroup)'],
    ['[data-high-contrast] select option:checked'],
  ])('%s reaches 4.5:1', (sel) => {
    const { bg, fg } = rule(sel)
    expect(contrast(fg, bg)).toBeGreaterThanOrEqual(4.5)
  })
  it('leaves option colours to the theme (no per-option backgrounds in screens)', () => {
    const root = path.dirname(fileURLToPath(import.meta.url))
    const walk = (d: string): string[] => readdirSync(d).flatMap((n) => { const p = path.join(d, n); return statSync(p).isDirectory() ? walk(p) : /\.tsx$/.test(n) && !n.includes('.test.') ? [p] : [] })
    const offenders = walk(root).filter((f) => /<option[^>]*className=/.test(readFileSync(f, 'utf8')))
    expect(offenders).toEqual([])
  })
})

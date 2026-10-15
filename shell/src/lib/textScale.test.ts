// WSOS-ACC-001…006: text size reflows instead of zooming; every px font size used in the shell must scale.
import { readdirSync, readFileSync, statSync } from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'

const src = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..')
function tsx(dir: string): string[] {
  return readdirSync(dir).flatMap((n) => {
    const p = path.join(dir, n)
    return statSync(p).isDirectory() ? tsx(p) : p.endsWith('.tsx') ? [p] : []
  })
}

describe('text scale reflow', () => {
  const css = readFileSync(path.join(src, 'index.css'), 'utf8')
  it('every px text size below display size has a scale rule', () => {
    const sizes = new Set<string>()
    for (const f of tsx(src)) for (const m of readFileSync(f, 'utf8').matchAll(/text-\[([0-9.]+)px\]/g)) sizes.add(m[1])
    const missing = [...sizes].filter((s) => Number(s) < 44 && !css.includes(`.text-\\[${s.replace('.', '\\.')}px\\] { font-size: calc(${s}px * var(--ws-text-scale)); }`))
    expect(missing).toEqual([])
  })
  it('named sizes scale through the theme variables', () => {
    for (const n of ['xs', 'sm', 'base', 'lg', 'xl', '2xl']) expect(css).toMatch(new RegExp(`--text-${n}: calc\\([0-9.]+rem \\* var\\(--ws-text-scale\\)\\)`))
  })
  it('the page is not zoomed', () => {
    expect(readFileSync(path.join(src, 'lib/a11y.ts'), 'utf8')).not.toMatch(/setProperty\('zoom'/)
  })
})

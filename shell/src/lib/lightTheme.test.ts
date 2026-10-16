// WSOS-DSK-014: Settings › Appearance › Light restyles the dark-glass screens.
import { readdirSync, readFileSync, statSync } from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { LIGHT_SURFACES, classRule, lightThemeCss, mapSurface, mapText, parseColor, ratio } from './lightTheme'

const src = 'src'
const files = (d: string): string[] => readdirSync(d).flatMap((n) => { const p = path.join(d, n); return statSync(p).isDirectory() ? files(p) : /\.tsx?$/.test(n) && !/\.test\.tsx?$/.test(n) ? [p] : [] })

describe('light theme for the dark-glass screens', () => {
  const gen = lightThemeCss(files(src).sort().map((f) => readFileSync(f, 'utf8')))
  it('src/theme-light.css is up to date (run node scripts/gen-light-theme.mjs)', () => {
    expect(readFileSync('src/theme-light.css', 'utf8')).toBe(gen.text)
    expect(readFileSync('src/index.css', 'utf8')).toMatch(/@import "\.\/theme-light\.css";/)
  })
  it('every colour class with a variant is handled', () => {
    expect(gen.skipped).toEqual([])
  })
  it('every mapped text colour has at least 4.5:1 on the light surfaces', () => {
    for (const c of gen.classes.filter((x) => /^(?:[a-z-]+:)*text-\[#/.test(x))) {
      const out = mapText(parseColor(/\[(.*)\]/.exec(c)![1])!)
      if (!out) continue
      for (const bg of LIGHT_SURFACES) expect(ratio(out, bg), c).toBeGreaterThanOrEqual(4.5)
    }
  })
  it('dark glass turns light, accents keep their colour, white text stays white on accents', () => {
    expect(mapSurface(parseColor('#0A1A3D')!)![0]).toBeGreaterThan(220)
    expect(mapSurface(parseColor('#1F6BFF')!)).toBeNull()
    const zone = ':not(.ws-dark-zone *, .ws-dark-zone)'
    expect(classRule('text-[#8FA3C8]')).toBe(`:root[data-theme="light"] .text-\\[\\#8FA3C8\\]${zone} { color: #405782; }`)
    expect(classRule('hover:bg-white/[0.07]')).toBe(`:root[data-theme="light"] .hover\\:bg-white\\/\\[0\\.07\\]${zone}:hover { background-color: rgba(15,23,42,0.07); }`)
    expect(gen.text).toMatch(/\.text-white:not\(\.ws-dark-zone \*, \.ws-dark-zone\):not\(:where\([^)]*\.bg-\\\[\\#1F6BFF\\\]/)
  })
  it('the shared inline palettes use theme variables with light values', () => {
    const css = readFileSync('src/index.css', 'utf8')
    for (const f of ['src/components/Dk.tsx', 'src/screens/files/parts.tsx']) {
      const palette = /export const C = \{([\s\S]*?)\n\}/.exec(readFileSync(f, 'utf8'))![1]
      for (const m of palette.matchAll(/var\((--ws-g-[a-z]+)\)/g)) expect(css, m[1]).toMatch(new RegExp(`:root\\[data-theme="light"\\] \\{[^}]*${m[1]}:`))
    }
    const light = /:root\[data-theme="light"\] \{([^}]*)\}/.exec(css)![1]
    const v = (n: string) => parseColor(new RegExp(`--ws-g-${n}: ([^;]+);`).exec(light)![1])!
    for (const n of ['ink', 'soft', 'muted', 'dim', 'link', 'green', 'amber', 'red', 'cyan']) expect(ratio(v(n), v('side')), n).toBeGreaterThanOrEqual(4.5)
  })
})

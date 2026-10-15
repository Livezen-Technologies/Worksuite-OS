// Contrast audit of the shell screens (WSOS-ACC-004). jsdom cannot compute rendered colours, so this test
// (1) scans every className in src/ that sets both an opaque text colour and an opaque background, and
// (2) checks the text colours used on the shell's dark glass surfaces against those surfaces.
import { readdirSync, readFileSync, statSync } from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { contrast, luminance, ratio, parseHex } from './contrast'

const SRC = path.resolve(__dirname, '..')

function files(dir: string): string[] {
  return readdirSync(dir).flatMap((f) => {
    const p = path.join(dir, f)
    return statSync(p).isDirectory() ? files(p) : p.endsWith('.tsx') && !p.endsWith('.test.tsx') ? [p] : []
  })
}

const HEX = '#[0-9a-fA-F]{6}'
/** Large text (≥ 18.66px bold or ≥ 24px) needs 3:1; everything else 4.5:1. */
function minimum(cls: string): number {
  const px = Number(/text-\[(\d+(?:\.\d+)?)px\]/.exec(cls)?.[1] ?? (/\btext-(2xl|3xl|4xl)\b/.test(cls) ? 24 : /\btext-xl\b/.test(cls) ? 20 : 14))
  const bold = /\bfont-(semibold|bold)\b/.test(cls)
  return px >= 24 || (bold && px >= 18.66) ? 3 : 4.5
}

describe('contrast helpers', () => {
  it('match WCAG reference values', () => {
    expect(ratio(parseHex('#000000').rgb, parseHex('#ffffff').rgb)).toBeCloseTo(21, 1)
    expect(contrast('#767676', '#ffffff')).toBeGreaterThanOrEqual(4.5)
    expect(contrast('#777777', '#ffffff')).toBeLessThan(4.5)
    expect(contrast('#ffffff80', '#000000')).toBeCloseTo(contrast('#808080', '#000000'), 0)
  })
})

describe('contrast audit', () => {
  it('opaque text/background pairs in class names meet WCAG AA', () => {
    const failures: string[] = []
    for (const f of files(SRC)) {
      const src = readFileSync(f, 'utf8')
      for (const m of src.matchAll(/className=(?:"([^"]*)"|\{`([^`]*)`\})/g)) {
        // Conditional classes: check each branch of a ternary separately.
        for (const cls of (m[1] ?? m[2]).split(/'\s*:\s*'|\?\s*'/)) {
          const text = new RegExp(`(?<![:\\w-])text-\\[(${HEX})\\]`).exec(cls)?.[1]
          const bg = new RegExp(`(?<![:\\w-])bg-\\[(${HEX})\\]`).exec(cls)?.[1]
          if (!text || !bg) continue
          const r = contrast(text, bg)
          if (r < minimum(cls)) failures.push(`${path.relative(SRC, f)}: ${text} on ${bg} = ${r.toFixed(2)}`)
        }
      }
    }
    expect(failures).toEqual([])
  })

  // Text colours used on the dark shell surfaces (taskbar, notification centre, greeter/lock glass, panels).
  const SURFACES = {
    taskbar: '#06102A',            // rgba(6,14,34,0.82) over the wallpaper's darkest stop
    notifications: '#0A1838',      // rgba(10,24,56,0.94)
    greeterGlass: '#0D1A3A',       // rgba(8,20,48,0.6) over the greeter gradient
    a11yPanel: '#0A1838',
  }
  const TEXT = ['#E8EEFA', '#C9D6EE', '#8FA3C8', '#7FB2FF', '#FFB4A8', '#FFD27A', '#ffffffb3', '#ffffff99']
  for (const [name, bg] of Object.entries(SURFACES)) {
    it(`text on the ${name} surface meets 4.5:1`, () => {
      const low = TEXT.map((t) => [t, contrast(t, bg)] as const).filter(([, r]) => r < 4.5)
      expect(low).toEqual([])
    })
  }

  it('every text colour in the shell is readable on the surface family it is used on', () => {
    // Light text is used on the dark glass surfaces; dark text on the light windows (launcher, Settings, App Center, Files).
    const DARK = Object.values(SURFACES)
    const LIGHT = ['#ffffff', '#f8fafc', '#f1f5f9']
    const used = new Set<string>()
    for (const f of files(SRC)) for (const m of readFileSync(f, 'utf8').matchAll(new RegExp(`text-\\[(${HEX})\\]`, 'g'))) used.add(m[1].toUpperCase())
    const failures = [...used].flatMap((c) => {
      const surfaces = luminance(parseHex(c).rgb) > 0.18 ? DARK : LIGHT
      return surfaces.filter((s) => contrast(c, s) < 4.5).map((s) => `${c} on ${s} = ${contrast(c, s).toFixed(2)}`)
    })
    expect(used.size).toBeGreaterThan(20)
    expect(failures).toEqual([])
  })

  it('high-contrast theme colours exceed 7:1', () => {
    expect(contrast('#ffffff', '#000000')).toBeGreaterThan(7)
    expect(contrast('#000000', '#ffd400')).toBeGreaterThan(7)
    expect(contrast('#ffd400', '#000000')).toBeGreaterThan(7)   // focus ring on black
    expect(contrast('#d4d4d4', '#000000')).toBeGreaterThan(7)   // placeholders, disabled
  })
})

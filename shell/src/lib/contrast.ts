// WCAG 2.x contrast (WSOS-ACC-004): relative luminance and contrast ratio of sRGB hex colours,
// with alpha compositing for translucent surfaces (the shell's glass panels).

export type RGB = [number, number, number]

export function parseHex(hex: string): { rgb: RGB; a: number } {
  let h = hex.replace('#', '')
  if (h.length === 3 || h.length === 4) h = [...h].map((c) => c + c).join('')
  const n = (i: number) => parseInt(h.slice(i, i + 2), 16)
  return { rgb: [n(0), n(2), n(4)], a: h.length === 8 ? n(6) / 255 : 1 }
}

/** Colour `fg` with alpha `a` drawn over opaque `bg`. */
export function over(fg: RGB, a: number, bg: RGB): RGB {
  return [0, 1, 2].map((i) => Math.round(fg[i] * a + bg[i] * (1 - a))) as RGB
}

export function luminance([r, g, b]: RGB): number {
  const c = (v: number) => { const s = v / 255; return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4 }
  return 0.2126 * c(r) + 0.7152 * c(g) + 0.0722 * c(b)
}

export function ratio(a: RGB, b: RGB): number {
  const [x, y] = [luminance(a), luminance(b)].sort((p, q) => q - p)
  return (x + 0.05) / (y + 0.05)
}

/** Contrast of text colour (possibly translucent) on a background (possibly translucent over `base`). */
export function contrast(text: string, bg: string, base = '#000000'): number {
  const b0 = parseHex(base).rgb
  const b = parseHex(bg)
  const bgRgb = over(b.rgb, b.a, b0)
  const t = parseHex(text)
  return ratio(over(t.rgb, t.a, bgRgb), bgRgb)
}

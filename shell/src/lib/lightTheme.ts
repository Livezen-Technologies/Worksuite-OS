// Light theme for the dark-glass screens (WSOS-DSK-014). The boards style most screens with fixed arbitrary colours
// (`text-[#8FA3C8]`, `bg-[rgba(14,32,72,0.6)]`, `bg-white/[0.07]` …). Rather than fork every screen, this maps each
// such colour to its light counterpart by role, and scripts/gen-light-theme.mjs writes the rules to
// src/theme-light.css, applied under <html data-theme="light"> (Settings › Appearance › Light). Shared inline
// palettes (Dk.C, files/parts.C) use the --ws-g-* variables from index.css instead.
// lib/lightTheme.test.ts keeps the generated file in step with the sources and checks text contrast.

export type Rgba = [number, number, number, number]

export function parseColor(s: string): Rgba | null {
  const hex = /^#([0-9a-f]{3}|[0-9a-f]{6}|[0-9a-f]{8})$/i.exec(s)
  if (hex) {
    let h = hex[1]
    if (h.length === 3) h = [...h].map((c) => c + c).join('')
    const n = (i: number) => parseInt(h.slice(i, i + 2), 16)
    return [n(0), n(2), n(4), h.length === 8 ? n(6) / 255 : 1]
  }
  const m = /^rgba?\(([\d.]+),([\d.]+),([\d.]+)(?:,([\d.]+))?\)$/.exec(s.replace(/\s|_/g, ''))
  return m ? [Number(m[1]), Number(m[2]), Number(m[3]), m[4] === undefined ? 1 : Number(m[4])] : null
}

const lin = (c: number) => { const v = c / 255; return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4 }
export const luminance = ([r, g, b]: Rgba) => 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b)
export const ratio = (a: Rgba, b: Rgba) => { const [x, y] = [luminance(a), luminance(b)].sort((p, q) => q - p); return (x + 0.05) / (y + 0.05) }

function toHsl([r, g, b]: Rgba): [number, number, number] {
  const [R, G, B] = [r / 255, g / 255, b / 255]
  const max = Math.max(R, G, B), min = Math.min(R, G, B), l = (max + min) / 2
  if (max === min) return [0, 0, l]
  const d = max - min, s = l > 0.5 ? d / (2 - max - min) : d / (max + min)
  const h = max === R ? (G - B) / d + (G < B ? 6 : 0) : max === G ? (B - R) / d + 2 : (R - G) / d + 4
  return [h * 60, s, l]
}
function fromHsl(h: number, s: number, l: number, a: number): Rgba {
  const k = (n: number) => (n + h / 30) % 12
  const q = s * Math.min(l, 1 - l)
  const f = (n: number) => Math.round(255 * (l - q * Math.max(-1, Math.min(k(n) - 3, 9 - k(n), 1))))
  return [f(0), f(8), f(4), a]
}
export const css = ([r, g, b, a]: Rgba) => (a >= 1 ? `#${[r, g, b].map((x) => x.toString(16).padStart(2, '0')).join('').toUpperCase()}` : `rgba(${r},${g},${b},${+a.toFixed(3)})`)

/** The lightest light-theme surface text sits on, and the darkest (glass over the wallpaper, cards). */
// …and the selected-row tint (accent at 20 % on light glass).
export const LIGHT_SURFACES: Rgba[] = [[255, 255, 255, 1], [222, 228, 241, 1], [194, 212, 249, 1]]
const INK: Rgba = [15, 23, 42, 1]

/** Light text on dark glass → a dark shade of the same hue with at least 4.6:1 on every light surface. */
export function mapText(c: Rgba): Rgba | null {
  if (luminance(c) < 0.3) return null                      // already dark (text on light chips): keep
  const [h, s] = toHsl(c)
  if (s < 0.1) return INK                                   // white/grey text → the light theme's ink
  for (let l = 0.42; l > 0.05; l -= 0.02) {
    const out = fromHsl(h, Math.min(s, 0.85), l, 1)
    if (LIGHT_SURFACES.every((bg) => ratio(out, bg) >= 4.6)) return out
  }
  return INK
}

/** Dark glass surfaces → light glass; accents (saturated mid colours) and light chips keep their colour. */
export function mapSurface(c: Rgba): Rgba | null {
  const [h, s, l] = toHsl(c)
  const L = luminance(c)
  if (L > 0.45) return c[3] < 0.3 && L > 0.8 ? [15, 23, 42, Math.min(0.08, c[3])] : null   // white overlays → ink overlays
  if (s > 0.5 && l > 0.3) return null                                                       // accent (blue, red, green…)
  if (c[3] < 0.3) return [15, 23, 42, Math.min(0.08, c[3])]                                 // faint dark tint → faint ink tint
  return fromHsl(h, Math.min(s, 0.45), Math.min(0.99, 0.88 + Math.min(l, 0.2) * 0.6), Math.max(c[3], 0.94))
}

/** Light hairlines on dark (rgba(127,178,255,0.12)) → ink-blue hairlines on light. */
export function mapLine(c: Rgba): Rgba | null {
  if (luminance(c) < 0.3) return mapSurface(c)
  const [h, s] = toHsl(c)
  if (s > 0.5 && luminance(c) < 0.45 && c[3] >= 1) return null
  return fromHsl(h, Math.min(s, 0.6), 0.35, Math.min(0.5, Math.max(0.16, c[3] * 1.6)))
}

const PROPS: Record<string, { prop: string; role: 'text' | 'surface' | 'line' }> = {
  text: { prop: 'color', role: 'text' }, placeholder: { prop: 'color', role: 'text' }, caret: { prop: 'caret-color', role: 'text' },
  fill: { prop: 'fill', role: 'text' }, stroke: { prop: 'stroke', role: 'text' }, decoration: { prop: 'text-decoration-color', role: 'text' },
  bg: { prop: 'background-color', role: 'surface' },
  border: { prop: 'border-color', role: 'line' }, 'border-t': { prop: 'border-top-color', role: 'line' }, 'border-b': { prop: 'border-bottom-color', role: 'line' },
  'border-l': { prop: 'border-left-color', role: 'line' }, 'border-r': { prop: 'border-right-color', role: 'line' },
  'border-x': { prop: 'border-inline-color', role: 'line' }, 'border-y': { prop: 'border-block-color', role: 'line' },
  divide: { prop: 'border-color', role: 'line' }, ring: { prop: '--tw-ring-color', role: 'line' }, outline: { prop: 'outline-color', role: 'line' },
}
const VARIANTS: Record<string, (sel: string) => string> = {
  hover: (s) => `${s}:hover`, focus: (s) => `${s}:focus`, 'focus-visible': (s) => `${s}:focus-visible`, 'focus-within': (s) => `${s}:focus-within`,
  active: (s) => `${s}:active`, disabled: (s) => `${s}:disabled`, first: (s) => `${s}:first-child`, last: (s) => `${s}:last-child`,
  placeholder: (s) => `${s}::placeholder`, 'group-hover': (s) => `.group:hover ${s}`, 'group-focus': (s) => `.group:focus ${s}`,
  'aria-selected': (s) => `${s}[aria-selected="true"]`, 'aria-pressed': (s) => `${s}[aria-pressed="true"]`, 'aria-checked': (s) => `${s}[aria-checked="true"]`,
  'aria-current': (s) => `${s}[aria-current]`, 'aria-expanded': (s) => `${s}[aria-expanded="true"]`, 'aria-disabled': (s) => `${s}[aria-disabled="true"]`,
}

/** Tailwind classes with a fixed colour this theme maps. */
export const COLOR_CLASS = /(?<![\w-])((?:[a-z-]+:)*)(text|placeholder|caret|fill|stroke|decoration|bg|border-[tblrxy]|border|divide|ring|outline)-(\[(?:#[0-9A-Fa-f]{3,8}|rgba?\([^\]\s]*\))\]|white(?:\/(?:\[[0-9.]+\]|[0-9]+))?)(?![\w\]-])/g

export const escapeClass = (c: string) => c.replace(/[^a-zA-Z0-9_-]/g, (ch) => `\\${ch}`)

/** One class → its light-theme rule, or null (kept as it is, or a variant this theme doesn't handle). */
export function classRule(cls: string, accentBgs: string[] = []): string | null {
  COLOR_CLASS.lastIndex = 0
  const m = COLOR_CLASS.exec(cls)
  if (!m || m[0] !== cls) return null
  const variants = m[1] ? m[1].slice(0, -1).split(':') : []
  const p = PROPS[m[2]]
  if (!p) return null
  let value: Rgba | null
  let raw: Rgba
  if (m[3].startsWith('white')) {
    const a = m[3].includes('/') ? Number(m[3].split('/')[1].replace(/[[\]]/g, '')) : 1
    raw = [255, 255, 255, a > 1 ? a / 100 : a]
  } else {
    const c = parseColor(m[3].slice(1, -1))
    if (!c) return null
    raw = c
  }
  value = p.role === 'text' ? mapText(raw) : p.role === 'surface' ? mapSurface(raw) : mapLine(raw)
  if (!value) return null
  if (p.role === 'text' && raw[3] < 1) value = [value[0], value[1], value[2], Math.max(0.7, raw[3])]
  // .ws-dark-zone: text drawn on the wallpaper (desktop clock) keeps its dark-theme colours.
  let sel = `.${escapeClass(cls)}:not(.ws-dark-zone *, .ws-dark-zone)`
  for (const v of [...variants].reverse()) {
    if (v === 'placeholder' && m[2] === 'text') { sel = VARIANTS.placeholder(sel); continue }
    const f = VARIANTS[v]
    if (!f) return null
    sel = f(sel)
  }
  // White text stays white on accent buttons and chips (their own background is kept).
  if (m[2] === 'text' && m[3].startsWith('white') && accentBgs.length) sel = `${sel}:not(:where(${accentBgs.map((b) => `.${escapeClass(b)}`).join(', ')}, [style*="background"]))`
  return `:root[data-theme="light"] ${sel} { ${p.prop}: ${css(value)}; }`
}

/** Every mapped class in the given sources, sorted, and the CSS for them. */
export function lightThemeCss(sources: string[]): { classes: string[]; skipped: string[]; text: string } {
  const all = new Set<string>()
  for (const s of sources) for (const m of s.matchAll(COLOR_CLASS)) all.add(m[0])
  const classes = [...all].sort()
  // Backgrounds the theme keeps (accents): white text on them stays white.
  const accentBgs = classes.filter((c) => /^bg-\[/.test(c) && classRule(c) === null && (parseColor(c.slice(4, -1))?.[3] ?? 0) >= 0.85)
  const rules: string[] = []
  const skipped: string[] = []
  for (const c of classes) {
    const r = classRule(c, accentBgs)
    if (r) rules.push(r)
    else if (c.includes(':') && !classRule(c.split(':').pop()!)) continue
    else if (c.includes(':')) skipped.push(c)
  }
  const head = '/* Generated by scripts/gen-light-theme.mjs from src/lib/lightTheme.ts: do not edit. Light theme for the dark-glass screens (WSOS-DSK-014). */\n'
  return { classes, skipped, text: head + rules.join('\n') + '\n' }
}

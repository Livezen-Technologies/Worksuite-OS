// Localisation checks (SRS §11.5) that run with the unit tests:
//  1. no hard-coded user-visible text in JSX (text nodes and text attributes) outside the message catalog;
//  2. every key exists in every locale, with the same `{placeholders}`;
//  3. every key used through t('…') exists in the English catalog;
//  4. translated locales say whether they were reviewed (docs/i18n/README.md).
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'
import { describe, expect, it } from 'vitest'
import en from './en'
import si, { review as siReview } from './si'
import ta, { review as taReview } from './ta'

const SRC = join(__dirname, '..')
const ROOT = join(SRC, '..')

function files(dir: string, ext: RegExp): string[] {
  return readdirSync(dir).flatMap((n) => {
    const p = join(dir, n)
    if (statSync(p).isDirectory()) return files(p, ext)
    return ext.test(n) && !/\.test\.tsx?$/.test(n) ? [p] : []
  })
}

/**
 * Text that may stay literal: brand and product names, key caps, sample addresses, language names shown in their own
 * language. `*` allows everything in a file: Installer.tsx is the design mock of the live-ISO installer; the installer
 * people use is Calamares, translated through installer/lang/*.ts.
 */
const ALLOW: Record<string, string[]> = {
  '*': ['WorkSuite OS', 'WorkSuite Cloud', 'worksuite', 'OS', 'SHA-256', 'work.example.com'],
  'src/screens/Installer.tsx': ['*'],
  'src/screens/Desktop.tsx': ['Super', 'Livezen Technologies · Enterprise · Synced 1 min ago'],
  'src/screens/recovery/Menu.tsx': ['English (US)'],
}

const ATTR = /\b(title|placeholder|aria-label|aria-valuetext|label|alt|desc)="([^"]*[A-Za-z][^"]*)"/g
// Text between a closing `>` (not `=>`) and the next tag; no code punctuation, so TypeScript generics don't match.
const TEXT = /(?<![=-])>([^<>{}=;()`]*[A-Za-z]{2}[^<>{}=;()`]*)<(?=[A-Za-z/])/g

function hardcoded(file: string): string[] {
  const rel = relative(ROOT, file)
  const allow = [...ALLOW['*'], ...(ALLOW[rel] ?? [])]
  if (allow.includes('*')) return []
  const src = readFileSync(file, 'utf8').replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '')
  const found: string[] = []
  for (const m of src.matchAll(ATTR)) if (!allow.includes(m[2].trim())) found.push(`${rel}: ${m[1]}="${m[2]}"`)
  for (const m of src.matchAll(TEXT)) {
    const s = m[1].trim()
    if (/^[,:]|\b(case|return|default)\b/.test(s)) continue // code between a generic or JSX expression and a tag
    if (s && !allow.includes(s)) found.push(`${rel}: >${s}<`)
  }
  return found
}

const placeholders = (s: string) => [...s.matchAll(/\{(\w+)\}/g)].map((m) => m[1]).sort()

describe('localisation (SRS §11.5)', () => {
  it('has no hard-coded user-visible JSX text outside the catalog', () => {
    expect(files(SRC, /\.tsx$/).flatMap(hardcoded)).toEqual([])
  })

  it('the scanner finds literal text and attributes', () => {
    const sample = '<button aria-label="Close">Save changes</button><Foo<{ a: 1 }>> x => y < 3'
    expect([...sample.matchAll(ATTR)].map((m) => m[2])).toEqual(['Close'])
    expect([...sample.matchAll(TEXT)].map((m) => m[1])).toEqual(['Save changes'])
  })

  for (const [name, cat] of [['si', si], ['ta', ta]] as const) {
    it(`${name} covers every key with the same placeholders`, () => {
      const missing = Object.keys(en).filter((k) => !(k in cat))
      const unknown = Object.keys(cat).filter((k) => !(k in en))
      const mismatched = Object.entries(cat).filter(([k, v]) => k in en && placeholders(v!).join() !== placeholders(en[k as keyof typeof en]).join()).map(([k]) => k)
      const empty = Object.entries(cat).filter(([, v]) => !v!.trim()).map(([k]) => k)
      expect({ missing, unknown, mismatched, empty }).toEqual({ missing: [], unknown: [], mismatched: [], empty: [] })
    })
  }

  it('every t() key in the shell and app windows exists in English', () => {
    const used = new Set<string>()
    for (const f of [...files(SRC, /\.tsx?$/), ...files(join(ROOT, 'electron'), /\.ts$/)]) {
      for (const m of readFileSync(f, 'utf8').matchAll(/\b(?:t|tr)\('([\w.& ]+)'/g)) used.add(m[1])
    }
    expect([...used].filter((k) => !(k in en))).toEqual([])
  })

  it('marks machine-drafted locales as not reviewed', () => {
    for (const r of [siReview, taReview]) {
      // A locale counts as reviewed only when every key was signed off.
      if (r.reviewed) expect(Object.keys(r.reviewedKeys).length).toBe(Object.keys(en).length)
      for (const k of Object.keys(r.reviewedKeys)) expect(k in en, k).toBe(true)
    }
    expect(siReview.reviewed).toBe(false)
    expect(taReview.reviewed).toBe(false)
  })
})

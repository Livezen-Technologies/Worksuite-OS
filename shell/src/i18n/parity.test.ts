// Locale parity (SRS §11.5): en, si and ta have exactly the same keys, and each key has the same `{placeholders}` in
// all three, so no locale falls back to English for a missing key or drops (or invents) a value t() fills in.
import { describe, expect, it } from 'vitest'
import en from './en'
import si from './si'
import ta from './ta'

const CATALOGS = { en, si, ta } as Record<string, Record<string, string | undefined>>
const placeholders = (s: string) => [...new Set([...s.matchAll(/\{(\w+)\}/g)].map((m) => m[1]))].sort()

describe('locale parity: en, si, ta', () => {
  const keys = Object.fromEntries(Object.entries(CATALOGS).map(([l, c]) => [l, Object.keys(c).sort()]))

  for (const l of ['si', 'ta']) {
    it(`${l} has the same set of keys as en`, () => {
      const mine = new Set(keys[l])
      const theirs = new Set(keys.en)
      expect(keys.en.filter((k) => !mine.has(k)), `missing in ${l}`).toEqual([])
      expect(keys[l].filter((k) => !theirs.has(k)), `only in ${l}`).toEqual([])
    })
  }

  it('every key has the same placeholders in every locale', () => {
    const mismatches: string[] = []
    for (const k of keys.en) {
      const want = placeholders(CATALOGS.en[k] ?? '')
      for (const l of ['si', 'ta']) {
        const v = CATALOGS[l][k]
        if (v === undefined) continue   // reported by the key-set tests above
        const got = placeholders(v)
        if (got.join() !== want.join()) mismatches.push(`${l} ${k}: {${got.join('}, {')}} instead of {${want.join('}, {')}}`)
      }
    }
    expect(mismatches).toEqual([])
  })
})

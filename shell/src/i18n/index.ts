// Lightweight message catalog (SRS §11.5): English source strings, Sinhala and Tamil drafts, `{name}` placeholders,
// English fallback for missing keys, and locale-aware date/number/currency formatting.
import { useSyncExternalStore } from 'react'
import { CATALOGS, LOCALES, REVIEW, TAGS, pickLocale, translate, type Locale, type LocaleReview, type MessageKey } from './core'

export type { Locale, LocaleReview, MessageKey }
export { LOCALES, REVIEW, pickLocale, translate }
const STORE_KEY = 'ws.locale'

function initial(): Locale {
  try {
    const saved = localStorage.getItem(STORE_KEY)
    if (saved && saved in CATALOGS) return saved as Locale
  } catch { /* no storage */ }
  const nav = typeof navigator !== 'undefined' ? navigator.language.slice(0, 2) : 'en'
  return nav in CATALOGS ? (nav as Locale) : 'en'
}

let current: Locale = initial()
const listeners = new Set<() => void>()

export function getLocale(): Locale { return current }

export function setLocale(l: Locale): void {
  if (!(l in CATALOGS) || l === current) return
  current = l
  try { localStorage.setItem(STORE_KEY, l) } catch { /* no storage */ }
  if (typeof document !== 'undefined') document.documentElement.lang = TAGS[l]
  listeners.forEach((fn) => fn())
}

export function t(key: MessageKey, vars?: Record<string, string | number>): string {
  return translate(current, key, vars)
}

/** A lookup table whose values are translated when read (for module-level maps such as error texts). */
export function messages<K extends string>(m: Record<K, MessageKey>): Record<K, string> {
  const o = {} as Record<K, string>
  for (const k of Object.keys(m) as K[]) Object.defineProperty(o, k, { get: () => t(m[k]), enumerable: true })
  return o
}

export const localeTag = (l: Locale = current) => TAGS[l]

export function formatNumber(n: number, l: Locale = current): string {
  return new Intl.NumberFormat(TAGS[l]).format(n)
}

/** Date and time in the current locale (default: medium date, short time). */
export function formatDate(value: Date | number | string, opts: Intl.DateTimeFormatOptions = { dateStyle: 'medium', timeStyle: 'short' }, l: Locale = current): string {
  return new Date(value).toLocaleString(TAGS[l], opts)
}

/** LKR, AED, USD, EUR, GBP per SRS §11.5. */
export function formatCurrency(amount: number, currency: 'LKR' | 'AED' | 'USD' | 'EUR' | 'GBP', l: Locale = current): string {
  return new Intl.NumberFormat(TAGS[l], { style: 'currency', currency }).format(amount)
}

function subscribe(fn: () => void) { listeners.add(fn); return () => { listeners.delete(fn) } }

/** Re-renders the component when the locale changes; returns the bound translator. */
export function useT(): typeof t {
  useSyncExternalStore(subscribe, getLocale, getLocale)
  return t
}

if (typeof document !== 'undefined') document.documentElement.lang = TAGS[current]

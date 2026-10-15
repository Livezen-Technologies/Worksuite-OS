// Lightweight message catalog (SRS §11.5): English source strings, Sinhala and Tamil drafts, `{name}` placeholders,
// English fallback for missing keys, and locale-aware date/number/currency formatting.
import { useSyncExternalStore } from 'react'
import en, { type MessageKey } from './en'
import si from './si'
import ta from './ta'

export type { MessageKey }
export type Locale = 'en' | 'si' | 'ta'
export const LOCALES: { id: Locale; name: string }[] = [
  { id: 'en', name: 'English' },
  { id: 'si', name: 'සිංහල' },
  { id: 'ta', name: 'தமிழ்' },
]
const CATALOGS: Record<Locale, Partial<Record<MessageKey, string>>> = { en, si, ta }
/** BCP 47 tags for Intl formatting (Sri Lanka region by default). */
const TAGS: Record<Locale, string> = { en: 'en-GB', si: 'si-LK', ta: 'ta-LK' }
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

export function translate(locale: Locale, key: MessageKey, vars?: Record<string, string | number>): string {
  const s = CATALOGS[locale][key] ?? en[key] ?? key
  return vars ? s.replace(/\{(\w+)\}/g, (m, k: string) => (k in vars ? String(vars[k]) : m)) : s
}

export function t(key: MessageKey, vars?: Record<string, string | number>): string {
  return translate(current, key, vars)
}

export const localeTag = (l: Locale = current) => TAGS[l]

export function formatNumber(n: number, l: Locale = current): string {
  return new Intl.NumberFormat(TAGS[l]).format(n)
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

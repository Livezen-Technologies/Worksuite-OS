// Framework-free part of the message catalog: locales, lookup with English fallback and `{name}` interpolation.
// The Electron main process (app windows) uses this directly; screens use ./index (reactive locale).
import en, { type LocaleReview, type MessageKey } from './en'
import si, { review as siReview } from './si'
import ta, { review as taReview } from './ta'

export type { LocaleReview, MessageKey } from './en'
export type Locale = 'en' | 'si' | 'ta'
export const LOCALES: { id: Locale; name: string }[] = [
  { id: 'en', name: 'English' },
  { id: 'si', name: 'සිංහල' },
  { id: 'ta', name: 'தமிழ்' },
]
export const CATALOGS: Record<Locale, Partial<Record<MessageKey, string>>> = { en, si, ta }
/** Review status per translated locale; English is the source. */
export const REVIEW: Record<Exclude<Locale, 'en'>, LocaleReview> = { si: siReview, ta: taReview }
/** BCP 47 tags for Intl formatting (Sri Lanka region by default). */
export const TAGS: Record<Locale, string> = { en: 'en-GB', si: 'si-LK', ta: 'ta-LK' }

/** "si_LK.UTF-8", "ta-LK", "en-US" → a supported locale (English otherwise). */
export function pickLocale(tag: string | null | undefined): Locale {
  const l = (tag ?? '').slice(0, 2).toLowerCase()
  return l in CATALOGS ? (l as Locale) : 'en'
}

export function translate(locale: Locale, key: MessageKey, vars?: Record<string, string | number>): string {
  const s = CATALOGS[locale][key] ?? en[key] ?? key
  return vars ? s.replace(/\{(\w+)\}/g, (m, k: string) => (k in vars ? String(vars[k]) : m)) : s
}

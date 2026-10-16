// SRS §11.5 locale formats: dates, times, numbers and currency go through Intl with the session locale
// (en → en-GB, si → si-LK, ta → ta-LK), and no shell code formats them by hand.
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { formatCurrency, formatDate, formatDecimal, formatNumber, formatTime, localeTag, setLocale, type Locale } from '.'

afterEach(() => setLocale('en'))
const LOCALES: [Locale, string][] = [['en', 'en-GB'], ['si', 'si-LK'], ['ta', 'ta-LK']]
const when = new Date(2026, 9, 11, 15, 4)

describe('locale formats follow the chosen locale', () => {
  it.each(LOCALES)('%s uses %s', (l, tag) => {
    setLocale(l)
    expect(localeTag()).toBe(tag)
    expect(formatNumber(1234567.5)).toBe(new Intl.NumberFormat(tag).format(1234567.5))
    expect(formatDecimal(2.5, 1)).toBe(new Intl.NumberFormat(tag, { minimumFractionDigits: 1, maximumFractionDigits: 1 }).format(2.5))
    expect(formatDate(when)).toBe(when.toLocaleString(tag, { dateStyle: 'medium', timeStyle: 'short' }))
    expect(formatTime(when)).toBe(when.toLocaleTimeString(tag, { hour: '2-digit', minute: '2-digit', hour12: false }))
    expect(formatCurrency(1500, 'LKR')).toBe(new Intl.NumberFormat(tag, { style: 'currency', currency: 'LKR' }).format(1500))
  })
  it('English uses en-GB conventions', () => {
    expect(formatNumber(1234567.5)).toBe('1,234,567.5')
    expect(formatDecimal(0.25, 2)).toBe('0.25')
    expect(formatTime(when)).toBe('15:04')
    expect(formatDate(when, { day: 'numeric', month: 'short' })).toBe('11 Oct')
  })
  it('a locale switch changes the output without a reload', () => {
    const en = formatDate(when, { month: 'long' })
    setLocale('ta')
    expect(formatDate(when, { month: 'long' })).not.toBe(en)
  })
})

// Hand-made formatting bypasses the locale. Every display path must use the i18n helpers.
const ROOTS = ['src', 'electron']
const ALLOW: Record<string, RegExp> = {
  'src/lib/power.ts': /toFixed/,          // SVG stroke-dasharray, not text
  'src/lib/monitorApi.ts': /toFixed/,     // SVG polyline points, not text
  'electron/fileops.ts': /trashDate/,     // FreeDesktop trash DeletionDate (machine format)
  'src/screens/Installer.tsx': /Intl\.DateTimeFormat\(\)\.resolvedOptions/, // reads the system time zone
}
function files(dir: string): string[] {
  return readdirSync(dir).flatMap((n) => {
    const p = join(dir, n)
    if (statSync(p).isDirectory()) return n === 'i18n' ? [] : files(p)
    return /\.(ts|tsx)$/.test(n) && !/\.test\.tsx?$/.test(n) ? [p] : []
  })
}
const BAD = [
  /\.toLocale(Date|Time)?String\(\s*(\[\]|undefined)?\s*[,)]/, // locale omitted or empty → system default, not the chosen one
  /\.toFixed\(/,                                               // no locale separators
  /\bIntl\.(NumberFormat|DateTimeFormat)\(\s*\)/,                // default locale
  /getHours\(\)\)?\s*}?:\$?\{?\s*\w*\(?\w*\.getMinutes/,          // hand-built hh:mm
]

describe('no hand-made locale formatting in the shell', () => {
  it('every date, time and number goes through i18n helpers or localeTag()', () => {
    const offenders: string[] = []
    for (const f of ROOTS.flatMap(files)) {
      readFileSync(f, 'utf8').split('\n').forEach((line, i) => {
        if (line.trim().startsWith('//')) return
        for (const re of BAD) if (re.test(line) && !(ALLOW[f]?.test(line))) offenders.push(`${f}:${i + 1}: ${line.trim()}`)
      })
    }
    expect(offenders).toEqual([])
  })
})

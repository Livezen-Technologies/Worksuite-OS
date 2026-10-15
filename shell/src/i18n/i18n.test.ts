import { describe, expect, it } from 'vitest'
import en from './en'
import si from './si'
import ta from './ta'
import { formatCurrency, formatNumber, getLocale, setLocale, t, translate } from '.'

const placeholders = (s: string) => [...s.matchAll(/\{(\w+)\}/g)].map((m) => m[1]).sort()

describe('message catalogs (SRS §11.5)', () => {
  for (const [name, cat] of [['si', si], ['ta', ta]] as const) {
    it(`${name} has only known keys, the same placeholders, and covers the catalog`, () => {
      for (const [k, v] of Object.entries(cat)) {
        expect(k in en, k).toBe(true)
        expect(placeholders(v!), k).toEqual(placeholders(en[k as keyof typeof en]))
        expect(v!.trim(), k).not.toBe('')
      }
      expect(Object.keys(cat).length).toBe(Object.keys(en).length)
    })
  }

  it('interpolates and falls back to English', () => {
    expect(translate('en', 'panel.running', { name: 'Mail' })).toBe('Mail, running')
    expect(translate('ta', 'panel.windows', { name: 'Mail', count: 2 })).toBe('Mail, 2 சாளரங்கள்')
    expect(translate('si', 'panel.workspace', {})).toBe('වැඩ අවකාශය {n}')
  })

  it('switches locale and formats numbers and currencies', () => {
    setLocale('si')
    expect(getLocale()).toBe('si')
    expect(t('greeter.password')).toBe('මුරපදය')
    setLocale('en')
    expect(t('greeter.password')).toBe('Password')
    expect(formatNumber(1234567.5)).toBe('1,234,567.5')
    expect(formatCurrency(1500, 'LKR')).toMatch(/1,500\.00/)
    expect(formatCurrency(10, 'GBP')).toBe('£10.00')
  })
})

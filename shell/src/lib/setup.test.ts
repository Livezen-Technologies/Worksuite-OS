import { describe, expect, it } from 'vitest'
import { DEFAULT_PRIVACY, KEYS, applyAppearance, loadAppearance, readyRows, readJson, writeJson } from './setup'

const mem = () => { const m = new Map<string, string>(); return { getItem: (k: string) => m.get(k) ?? null, setItem: (k: string, v: string) => void m.set(k, v) } }
const throwing = { getItem: () => { throw new Error('blocked') }, setItem: () => { throw new Error('blocked') } }

describe('setup choices', () => {
  it('keeps privacy off by default except security updates', () => {
    expect(DEFAULT_PRIVACY).toEqual({ location: false, updates: true, crash: false, usage: false })
  })
  it('persists appearance and survives broken storage', () => {
    const s = mem()
    expect(loadAppearance(s)).toEqual({ theme: 'Dark', accent: 'Blue' })
    expect(writeJson(KEYS.appearance, { theme: 'Light', accent: 'Pink' }, s)).toBe(true)
    expect(loadAppearance(s)).toEqual({ theme: 'Light', accent: 'Pink' })
    s.setItem(KEYS.appearance, '{"theme":"Neon","accent":"Gold"}')
    expect(loadAppearance(s)).toEqual({ theme: 'Dark', accent: 'Blue' })
    expect(loadAppearance(throwing)).toEqual({ theme: 'Dark', accent: 'Blue' })
    expect(writeJson(KEYS.appearance, {}, throwing)).toBe(false)
    expect(readJson('x', { a: 1 }, null)).toEqual({ a: 1 })
  })
  it('applies theme and accent to the root element', () => {
    const attrs = new Map<string, string>(), props = new Map<string, string>()
    const root = { setAttribute: (k: string, v: string) => void attrs.set(k, v), removeAttribute: (k: string) => void attrs.delete(k), style: { setProperty: (k: string, v: string) => void props.set(k, v) } } as unknown as HTMLElement
    applyAppearance({ theme: 'Light', accent: 'Green' }, root)
    expect(attrs.get('data-theme')).toBe('light')
    expect(props.get('--color-ws-accent')).toBe('#3DBE7F')
    applyAppearance({ theme: 'Auto', accent: 'Blue' }, root)
    expect(attrs.has('data-theme')).toBe(false)
  })
  it('reports chosen apps as queued, never with invented progress', () => {
    const rows = readyRows(['mail', 'docs'])
    expect(rows.map((r) => [r.name, r.label, r.percent])).toEqual([['Docs', 'Queued', 0], ['Mail', 'Queued', 0]])
    expect(readyRows([])).toEqual([])
  })
})

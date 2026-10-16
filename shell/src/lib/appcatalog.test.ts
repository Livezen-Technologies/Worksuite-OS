import { describe, expect, it } from 'vitest'
import { buildApps, catalogNotice, categories, filterApps, SOURCES } from './appcatalog'
import type { AppCatalog, AppImageRecord } from './os'

const catalog: AppCatalog = { state: 'ok', arch: 'arm64', fetched_at: 1, items: [
  { id: 'flatpak:org.gimp.GIMP', source: 'flatpak', name: 'GIMP', arches: ['amd64', 'arm64'], category: 'Graphics', summary: 'Image editor', installed: true, available: true, blocked_reason: null },
  { id: 'apt:inkscape', source: 'apt', name: 'Inkscape', arches: ['amd64', 'arm64'], category: 'Graphics', installed: false, available: true, blocked_reason: 'Not on your organization’s approved list' },
  { id: 'flatpak:com.example.X86', source: 'flatpak', name: 'X86 Only', arches: ['amd64'], installed: false, available: false, blocked_reason: 'Not available for ARM64' },
  { id: 'appimage:pinta', source: 'appimage', name: 'Pinta', arches: ['arm64'], sha256: 'a'.repeat(64), installed: false, available: true, blocked_reason: null },
] }
const rec = (over: Partial<AppImageRecord> = {}): AppImageRecord => ({
  id: '0123456789abcdef', name: 'Pinta', version: '2.1', origin: 'file:///home/u/Downloads/Pinta.AppImage', sha256: 'a'.repeat(64), arch: 'arm64', size: 1,
  signature: { status: 'unsigned' }, approved: false, imported_at: '', approved_at: null, categories: ['Graphics'], ...over,
})
const all = new Set(SOURCES.map((s) => s.id))

describe('App Center catalog', () => {
  it('WorkSuite Office is a built-in row next to the server catalog, only when present', () => {
    expect(buildApps(catalog, [], true).find((a) => a.builtin === 'office')).toMatchObject({ source: 'WorkSuite', installed: true, catalogId: null })
    expect(buildApps(catalog, [], false).some((a) => a.builtin)).toBe(false)
    expect(buildApps(null, [], true).map((a) => a.name)).toEqual(['WorkSuite Office'])
  })

  it('uses only server items and imported AppImages, never built-in sample apps', () => {
    expect(buildApps(null, [])).toEqual([])
    expect(buildApps({ state: 'not_enrolled', arch: 'amd64', items: [], error: 'x' }, [])).toEqual([])
    const apps = buildApps(catalog, [])
    expect(apps.map((a) => a.name)).toEqual(['GIMP', 'Inkscape', 'Pinta', 'X86 Only'])
    expect(apps.find((a) => a.name === 'X86 Only')!.blocked).toBe('Not available for ARM64')
    expect(apps.find((a) => a.name === 'Inkscape')!.blocked).toMatch(/approved list/)
  })

  it('an imported AppImage replaces its catalog entry; checksum is never shown as a verified publisher', () => {
    const apps = buildApps(catalog, [rec()])
    const pinta = apps.filter((a) => a.name === 'Pinta')
    expect(pinta).toHaveLength(1)
    expect(pinta[0].appimageId).toBe('0123456789abcdef')
    expect(pinta[0].needsApproval).toBe(true)
    expect(pinta[0].trust).toMatch(/catalog checksum · publisher not verified/)
    const other = buildApps(catalog, [rec({ sha256: 'b'.repeat(64) })]).find((a) => a.appimageId)!
    expect(other.trust).toBe('Checksum only · publisher not verified')
    const signed = buildApps(null, [rec({ signature: { status: 'signed', fingerprint: 'ABCD'.repeat(10), trusted: true } })])[0]
    expect(signed.trust).toMatch(/^Signed · key .*trusted by your organization/)
  })

  it('filters by source, category, installed, updates and permissions', () => {
    const apps = buildApps(catalog, [rec({ sha256: 'c'.repeat(64), name: 'Local' })])
    expect(categories(apps)).toEqual(['All', 'Graphics', 'Other'])
    const f = (o: Partial<Parameters<typeof filterApps>[1]>) => filterApps(apps, { section: 'discover', sources: all, category: 'All', query: '', updates: new Set(), ...o }).map((a) => a.name)
    expect(f({ sources: new Set(['APT']) })).toEqual(['Inkscape'])
    expect(f({ section: 'installed' })).toEqual(['GIMP', 'Local'])
    expect(f({ section: 'updates', updates: new Set(['flatpak:org.gimp.GIMP']) })).toEqual(['GIMP'])
    expect(f({ section: 'permissions' })).toEqual(['GIMP'])
    expect(f({ query: 'image editor' })).toEqual(['GIMP'])
    expect(f({ category: 'Other' })).toEqual(['Pinta', 'X86 Only'])
  })

  it('has explicit loading, not-enrolled, error and empty states', () => {
    expect(catalogNotice(null, null)?.text).toMatch(/Loading/)
    expect(catalogNotice({ state: 'not_enrolled', arch: 'amd64', items: [], error: 'Not enrolled' }, null)).toEqual({ text: 'Not enrolled', retry: false })
    expect(catalogNotice({ state: 'unreachable', arch: 'amd64', items: [], error: 'Can’t reach' }, null)).toEqual({ text: 'Can’t reach', retry: true })
    expect(catalogNotice(null, 'The package service isn’t running.')?.retry).toBe(true)
    expect(catalogNotice({ ...catalog, items: [] }, null)?.text).toMatch(/hasn’t approved any apps/)
    expect(catalogNotice(catalog, null)).toBeNull()
  })
})

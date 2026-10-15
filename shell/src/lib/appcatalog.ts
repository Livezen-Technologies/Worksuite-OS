// App Center view model: the server catalog (through the package service) plus the user's imported AppImages.
// Pure functions so the filters and states are testable without a window.
import type { AppCatalog, AppImageRecord, CatalogEntry } from './os'

export type Source = 'APT' | 'Flatpak' | 'AppImage'
export const SOURCES: { id: Source; label: string }[] = [
  { id: 'APT', label: 'Debian (APT)' },
  { id: 'Flatpak', label: 'Flatpak (approved remotes)' },
  { id: 'AppImage', label: 'AppImage' },
]
const SOURCE_OF: Record<CatalogEntry['source'], Source> = { apt: 'APT', flatpak: 'Flatpak', appimage: 'AppImage' }

export interface AppView {
  key: string
  /** Package service catalog id ("apt:x" / "flatpak:x" / "appimage:x"). */
  catalogId: string | null
  /** worksuite-appimage id for an imported AppImage. */
  appimageId: string | null
  name: string; publisher: string; summary: string; source: Source; category: string
  installed: boolean
  /** Why it can't be installed here (policy, arch); null when it can. */
  blocked: string | null
  /** Shown on the card: "Signed by …", "Checksum only — publisher not verified", "Approved by your organization (checksum)". */
  trust: string | null
  needsApproval: boolean
  sha256?: string
}

const mark = (fpr: string) => fpr.replace(/(.{4})/g, '$1 ').trim().slice(-24)

export function appImageTrust(r: AppImageRecord, catalogSha?: Set<string>): string {
  if (r.signature.status === 'signed') return `Signed · key ${mark(r.signature.fingerprint)}${r.signature.trusted ? ' (trusted by your organization)' : ''}`
  if (catalogSha?.has(r.sha256)) return 'Matches your organization’s catalog checksum · publisher not verified'
  return 'Checksum only · publisher not verified'
}

export function buildApps(catalog: AppCatalog | null, appimages: AppImageRecord[]): AppView[] {
  const items = catalog?.state === 'ok' ? catalog.items : []
  const catalogSha = new Set(items.filter((i) => i.source === 'appimage' && i.sha256).map((i) => i.sha256!))
  const imported = new Set(appimages.map((a) => a.sha256))
  const fromCatalog: AppView[] = items
    .filter((i) => !(i.source === 'appimage' && i.sha256 && imported.has(i.sha256)))   // shown once, as the imported copy
    .map((i) => ({
      key: i.id, catalogId: i.id, appimageId: null, name: i.name, publisher: i.publisher ?? SOURCES.find((s) => s.id === SOURCE_OF[i.source])!.label,
      summary: i.summary ?? '', source: SOURCE_OF[i.source], category: i.category ?? 'Other', installed: i.installed, blocked: i.blocked_reason,
      trust: i.source === 'appimage' ? 'Import the file you were given; it is checked against the catalog checksum' : null, needsApproval: false, sha256: i.sha256,
    }))
  const fromImports: AppView[] = appimages.map((r) => ({
    key: `appimage-local:${r.id}`, catalogId: null, appimageId: r.id, name: r.name, publisher: r.origin.replace(/^file:\/\//, ''),
    summary: r.version ? `Version ${r.version}` : '', source: 'AppImage', category: r.categories[0] ?? 'Other', installed: true, blocked: null,
    trust: appImageTrust(r, catalogSha), needsApproval: !r.approved, sha256: r.sha256,
  }))
  return [...fromCatalog, ...fromImports].sort((a, b) => a.name.localeCompare(b.name))
}

export function categories(apps: AppView[]): string[] {
  return ['All', ...[...new Set(apps.map((a) => a.category))].sort()]
}

export type Section = 'discover' | 'installed' | 'updates' | 'permissions'

export function filterApps(apps: AppView[], o: { section: Section; sources: Set<Source>; category: string; query: string; updates: Set<string> }): AppView[] {
  const words = o.query.trim().toLowerCase().split(/\s+/).filter(Boolean)
  return apps.filter((a) => {
    if (!o.sources.has(a.source)) return false
    if (o.category !== 'All' && a.category !== o.category) return false
    if (o.section === 'installed' && !a.installed) return false
    if (o.section === 'updates' && !(a.catalogId && o.updates.has(a.catalogId))) return false
    if (o.section === 'permissions' && !(a.installed && a.source === 'Flatpak')) return false
    return !words.length || words.every((w) => `${a.name} ${a.summary} ${a.category} ${a.publisher}`.toLowerCase().includes(w))
  })
}

/** Empty/error state text, or null when the catalog has something to show. */
export function catalogNotice(catalog: AppCatalog | null, loadError: string | null): { text: string; retry: boolean } | null {
  if (loadError) return { text: loadError, retry: true }
  if (!catalog) return { text: 'Loading your organization’s app catalog…', retry: false }
  if (catalog.state !== 'ok') return { text: catalog.error, retry: catalog.state !== 'not_enrolled' }
  if (!catalog.items.length) return { text: 'Your organization hasn’t approved any apps for this device yet.', retry: true }
  return null
}

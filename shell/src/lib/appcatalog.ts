// App Center view model: the server catalog (through the package service) plus the user's imported AppImages.
// Pure functions so the filters and states are testable without a window.
import type { AppCatalog, AppImageRecord, AppRequest, CatalogEntry } from './os'
import { t } from '../i18n'

export type Source = 'WorkSuite' | 'APT' | 'Flatpak' | 'AppImage'
export const SOURCES: { id: Source; label: string }[] = [
  { id: 'WorkSuite', get label() { return t('hw.builtIn') } },
  { id: 'APT', label: 'Debian (APT)' },
  { id: 'Flatpak', get label() { return t('appc.src.flatpak') } },
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
  /** Software Management: not approved here, but the person may ask the organization (policy software_install = request). */
  requestable?: boolean
  /** This person's latest request for it. */
  request?: AppRequest | null
  /** Ships with WorkSuite OS (not from the catalog): opened, never installed or removed here. */
  builtin?: 'office'
  sha256?: string
}

/** Software Management: what the App Center shows for an app the organization hasn't approved here. null when the app
 *  isn't blocked or can't be asked for. A declined request can be asked again (with a reason). */
export function requestStatus(a: Pick<AppView, 'blocked' | 'requestable' | 'request'>): { label: string; hint: string | null; canRequest: boolean } | null {
  if (!a.blocked || (!a.requestable && !a.request)) return null
  const r = a.request
  if (r?.state === 'pending') return { label: t('swr.requested'), hint: t('swr.pending'), canRequest: false }
  if (r?.state === 'approved') return { label: t('swr.approved'), hint: t('swr.approvedHint'), canRequest: false }
  const hint = r?.state === 'rejected' ? (r.note ? t('swr.rejectedNote', { note: r.note }) : t('swr.rejected')) : null
  return { label: t('swr.request'), hint, canRequest: !!a.requestable }
}

const mark = (fpr: string) => fpr.replace(/(.{4})/g, '$1 ').trim().slice(-24)

export function appImageTrust(r: AppImageRecord, catalogSha?: Set<string>): string {
  if (r.signature.status === 'signed') return r.signature.trusted ? t('appc.trust.signedTrusted', { key: mark(r.signature.fingerprint) }) : t('appc.trust.signed', { key: mark(r.signature.fingerprint) })
  if (catalogSha?.has(r.sha256)) return t('appc.trust.catalog')
  return t('appc.trust.checksum')
}

/** WorkSuite Office is part of the OS image, so it is a built-in row, shown only when its desktop entry exists. */
export const OFFICE_ROW: AppView = {
  key: 'builtin:office', catalogId: null, appimageId: null, name: 'WorkSuite Office', publisher: 'Livezen Technologies',
  get summary() { return t('appc.officeSummary') }, source: 'WorkSuite',
  category: 'Office', installed: true, blocked: null, trust: null, needsApproval: false, builtin: 'office',
}

export function buildApps(catalog: AppCatalog | null, appimages: AppImageRecord[], office = false): AppView[] {
  const items = catalog?.state === 'ok' ? catalog.items : []
  const catalogSha = new Set(items.filter((i) => i.source === 'appimage' && i.sha256).map((i) => i.sha256!))
  const imported = new Set(appimages.map((a) => a.sha256))
  const fromCatalog: AppView[] = items
    .filter((i) => !(i.source === 'appimage' && i.sha256 && imported.has(i.sha256)))   // shown once, as the imported copy
    .map((i) => ({
      key: i.id, catalogId: i.id, appimageId: null, name: i.name, publisher: i.publisher ?? SOURCES.find((s) => s.id === SOURCE_OF[i.source])!.label,
      summary: i.summary ?? '', source: SOURCE_OF[i.source], category: i.category ?? 'Other', installed: i.installed, blocked: i.blocked_reason,
      trust: i.source === 'appimage' ? t('appc.trust.import') : null, needsApproval: false, sha256: i.sha256,
      requestable: i.requestable === true, request: i.request ?? null,
    }))
  const fromImports: AppView[] = appimages.map((r) => ({
    key: `appimage-local:${r.id}`, catalogId: null, appimageId: r.id, name: r.name, publisher: r.origin.replace(/^file:\/\//, ''),
    summary: r.version ? t('appc.version', { version: r.version }) : '', source: 'AppImage', category: r.categories[0] ?? 'Other', installed: true, blocked: null,
    trust: appImageTrust(r, catalogSha), needsApproval: !r.approved, sha256: r.sha256,
  }))
  return [...(office ? [OFFICE_ROW] : []), ...fromCatalog, ...fromImports].sort((a, b) => a.name.localeCompare(b.name))
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
  if (!catalog) return { text: t('appc.loadingCatalog'), retry: false }
  if (catalog.state !== 'ok') return { text: catalog.error, retry: catalog.state !== 'not_enrolled' }
  if (!catalog.items.length) return { text: t('appc.noneApproved'), retry: true }
  return null
}

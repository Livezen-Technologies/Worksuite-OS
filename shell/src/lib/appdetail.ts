// App Center card and detail helpers (G08/G09). Pure, so what the screen claims about an app is testable: every
// security line comes from the app's source and the checks the package tools really make, nothing assumed.
import type { InstalledApp } from './os'
import type { AppView, Source } from './appcatalog'
import { t } from '../i18n'

const PALETTE = ['#2E9E6A', '#1F6BFF', '#7A4FE0', '#5E3FB0', '#5E739C', '#0E8FA8', '#D9572B', '#B7791F']
/** A stable tile colour per app name (there are no app icons in the catalog). */
export function appColor(name: string): string {
  let h = 0
  for (const c of name) h = (h * 31 + c.codePointAt(0)!) >>> 0
  return PALETTE[h % PALETTE.length]
}

export function formatLabel(s: Source): string {
  return s === 'APT' ? '.deb' : s === 'WorkSuite' ? t('hw.builtIn') : s
}

/** The hero card: an approved app that isn't installed yet, Flatpak first (sandboxed), then by name. */
export function featuredApp(apps: AppView[]): AppView | null {
  const can = apps.filter((a) => !a.installed && !a.blocked && a.catalogId && a.source !== 'AppImage')
  return can.find((a) => a.source === 'Flatpak') ?? can[0] ?? null
}

/** The desktop entry that starts an installed catalog app: a Flatpak's app id, or an entry named like the package or app. */
export function launchIdFor(a: AppView, installed: InstalledApp[]): string | null {
  if (!a.installed || !a.catalogId) return null
  const [src, pkg] = a.catalogId.split(':') as [string, string]
  const ids = new Set(installed.map((i) => i.id.replace(/\.desktop$/, '')))
  if (src === 'flatpak') return ids.has(pkg) ? pkg : null
  const byId = installed.find((i) => i.id.replace(/\.desktop$/, '') === pkg)
  const byName = installed.find((i) => i.name.toLowerCase() === a.name.toLowerCase())
  return (byId ?? byName)?.id ?? null
}

/** Declared Flatpak permissions one entry per switch: "filesystems=home;xdg-download" → two entries. */
export function expandPermissions(perms: string[], broad: string[]): { perm: string; broad: boolean }[] {
  return perms.flatMap((p) => {
    const i = p.indexOf('=')
    if (i < 0) return []
    const k = p.slice(0, i)
    return p.slice(i + 1).split(';').filter(Boolean).map((v) => ({ perm: `${k}=${v}`, broad: broad.includes(p) }))
  })
}

export interface SecurityLine { title: string; detail: string; tone: 'ok' | 'warn' | 'none'; icon: string }
const SHIELD = 'M12 3l8 3v6c0 5-3.5 8-8 9-4.5-1-8-4-8-9V6z'
const BOXES = 'M4 4h7v7H4zM13 13h7v7h-7z'
const CHECK = 'M5 12.5l4.5 4.5L19 7.5'
const WARN = 'M12 3l10 18H2zM12 10v5'
const INFO = 'M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18zM12 11v5M12 8h.01'

export function detailSecurity(a: AppView, org: string | null): SecurityLine[] {
  const orgName = org ?? t('appc.yourOrg')
  const out: SecurityLine[] = []
  if (a.source === 'Flatpak') {
    out.push({ title: t('appc.sec.sandboxed'), detail: t('appc.sec.sandboxedFlatpak'), tone: 'ok', icon: SHIELD })
    out.push({ title: t('appc.sec.isolated'), detail: t('appc.sec.isolatedDetail', { id: a.catalogId?.split(':')[1] ?? '' }), tone: 'ok', icon: BOXES })
    out.push({ title: t('appc.sec.signed'), detail: t('appc.sec.signedFlatpak', { org: orgName }), tone: 'ok', icon: CHECK })
  } else if (a.source === 'APT') {
    out.push({ title: t('appc.sec.notSandboxed'), detail: t('appc.sec.notSandboxedApt'), tone: 'warn', icon: WARN })
    out.push({ title: t('appc.sec.signed'), detail: t('appc.sec.signedApt', { org: orgName }), tone: 'ok', icon: CHECK })
  } else if (a.source === 'AppImage') {
    out.push({ title: t('appc.sec.notSandboxed'), detail: t('appc.sec.notSandboxedAppImage'), tone: 'warn', icon: WARN })
    out.push({ title: a.trust ?? t('appc.trust.checksum'), detail: a.needsApproval ? t('appc.needsApproval') : t('appc.sec.approvedByYou'), tone: a.needsApproval ? 'warn' : 'ok', icon: a.needsApproval ? WARN : CHECK })
  } else {
    out.push({ title: t('appc.sec.builtin'), detail: t('appc.sec.builtinDetail'), tone: 'ok', icon: CHECK })
  }
  out.push({ title: t('appc.sec.vulnUnknown'), detail: t('appc.sec.vulnUnknownDetail'), tone: 'none', icon: INFO })
  return out
}

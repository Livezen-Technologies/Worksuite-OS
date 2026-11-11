// The applications setup can install, and where each one may come from. Only trusted sources: the packages bundled
// in the signed image (checked against its SHA256SUMS), the signed APT sources the OS already trusts (apt verifies
// the Release signatures; this service never passes --allow-unauthenticated), and Flathub through flatpak (OSTree
// signatures), only when that remote is configured system-wide. Nothing is downloaded from an arbitrary URL.

export type Source =
  | { type: 'bundled'; package: string }
  | { type: 'apt'; package: string }
  | { type: 'flatpak'; remote: 'flathub'; ref: string }

export interface AppDef {
  id: string
  name: string
  group: 'worksuite' | 'third-party'
  /** Tried in order; the first one available on this machine is used. */
  sources: Source[]
  /** Other catalog apps this one needs; installed first. */
  requires?: string[]
  /** Always installed; cannot be deselected or restricted by policy. */
  core?: boolean
}

const deb = (pkg: string): Source[] => [{ type: 'bundled', package: pkg }, { type: 'apt', package: pkg }]

export const CATALOG: readonly AppDef[] = [
  // WorkSuite Desktop's package is "worksuite" (worksuite-desktop is this OS's metapackage).
  { id: 'worksuite-desktop', name: 'WorkSuite Desktop', group: 'worksuite', sources: deb('worksuite'), core: true },
  { id: 'worksuite-office', name: 'WorkSuite Office', group: 'worksuite', sources: deb('worksuite-office') },
  { id: 'worksuite-pos', name: 'WorkSuite POS', group: 'worksuite', sources: deb('worksuite-pos') },
  { id: 'worksuite-desk', name: 'WorkSuite Desk', group: 'worksuite', sources: deb('worksuite-desk') },
  { id: 'worksuite-frameflow', name: 'Worksuite FrameFlow', group: 'worksuite', sources: deb('worksuite-frameflow') },
  { id: 'firefox-esr', name: 'Firefox', group: 'third-party', sources: [{ type: 'apt', package: 'firefox-esr' }] },
  { id: 'vlc', name: 'VLC', group: 'third-party', sources: [{ type: 'apt', package: 'vlc' }, { type: 'flatpak', remote: 'flathub', ref: 'org.videolan.VLC' }] },
  { id: 'gimp', name: 'GIMP', group: 'third-party', sources: [{ type: 'apt', package: 'gimp' }, { type: 'flatpak', remote: 'flathub', ref: 'org.gimp.GIMP' }] },
  { id: 'thunderbird', name: 'Thunderbird', group: 'third-party', sources: [{ type: 'apt', package: 'thunderbird' }, { type: 'flatpak', remote: 'flathub', ref: 'org.mozilla.Thunderbird' }] },
]

export const PACKAGE_RE = /^[a-z0-9][a-z0-9+.-]{0,127}$/
export const FLATPAK_REF_RE = /^[A-Za-z][A-Za-z0-9_-]*(\.[A-Za-z0-9_-]+){2,}$/

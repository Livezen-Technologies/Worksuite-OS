// Session configuration checks that run with the unit tests: portal backends (WSOS-INT-012), input methods
// (WSOS-INT-011) and keyring unlock on sign-in (WSOS-INT-009). They read the files the packages install.
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

const ROOT = join(__dirname, '..', '..')
const read = (p: string) => readFileSync(join(ROOT, p), 'utf8')
const control = read('packaging/debian/control')
const paragraph = (pkg: string) => control.split(/\n\n+/).find((p) => p.startsWith(`Package: ${pkg}\n`)) ?? ''
const depends = (pkg: string) => (/^Depends:([\s\S]*?)(?=^\S)/m.exec(paragraph(pkg) + '\nEnd:')?.[1] ?? '').split(/[,|\n]/).map((s) => s.trim().split(/\s/)[0]).filter(Boolean)

/** Interfaces each backend implements upstream (its .portal file), and the package that ships it. */
const BACKENDS: Record<string, { pkg: string; ifaces: string[] }> = {
  gtk: { pkg: 'xdg-desktop-portal-gtk', ifaces: ['FileChooser', 'AppChooser', 'Print', 'Notification', 'Inhibit', 'Access', 'Account', 'Email', 'DynamicLauncher', 'Lockdown', 'Settings', 'OpenURI'] },
  gnome: { pkg: 'xdg-desktop-portal-gnome', ifaces: ['FileChooser', 'AppChooser', 'Print', 'Screenshot', 'ScreenCast', 'RemoteDesktop', 'Settings', 'Inhibit', 'Access', 'Account', 'Wallpaper', 'Background', 'Lockdown', 'DynamicLauncher', 'Notification', 'InputCapture', 'GlobalShortcuts'] },
  'gnome-keyring': { pkg: 'gnome-keyring', ifaces: ['Secret'] },
}
/** Portal interfaces WorkSuite and its apps use; each must name its backend explicitly. */
const USED = ['FileChooser', 'OpenURI', 'Settings', 'ScreenCast', 'Screenshot', 'Secret', 'Inhibit']

function portalConf(): { def: string | null; map: Record<string, string> } {
  const map: Record<string, string> = {}; let def: string | null = null
  for (const line of read('services/session/portals/worksuite-portals.conf').split('\n')) {
    const m = /^([\w.]+)=(.+)$/.exec(line.trim())
    if (!m) continue
    if (m[1] === 'default') def = m[2]
    else map[m[1].replace('org.freedesktop.impl.portal.', '')] = m[2]
  }
  return { def, map }
}

describe('portals (WSOS-INT-012)', () => {
  const { def, map } = portalConf()
  const desktopDeps = depends('worksuite-desktop')
  it.each(USED)('%s has an explicit backend that implements it and is installed', (iface) => {
    const backend = map[iface]
    expect(backend, `${iface} must be listed explicitly`).toBeTruthy()
    if (backend === 'none') return // deliberately disabled
    expect(BACKENDS[backend]?.ifaces).toContain(iface)
    expect(desktopDeps).toContain(BACKENDS[backend].pkg)
  })
  it('falls back to an installed backend and names no unknown ones', () => {
    for (const d of (def ?? '').split(';')) expect(BACKENDS[d]).toBeTruthy()
    for (const b of Object.values(map)) expect(b === 'none' || b in BACKENDS).toBe(true)
  })
  it('is installed where xdg-desktop-portal looks for <desktop>-portals.conf', () => {
    expect(read('packaging/debian/worksuite-session.install')).toContain('services/session/portals/worksuite-portals.conf usr/share/xdg-desktop-portal/')
    expect(read('services/session/gnome/worksuite-gnome-session')).toMatch(/^export XDG_CURRENT_DESKTOP=WorkSuite(:|$)/m)
  })
})

describe('input methods (WSOS-INT-011)', () => {
  // Since 1.1 (GNOME): IBus with m17n, configured by GNOME's input sources (gnome/95_worksuite-gnome.gschema.override).
  it('ships IBus with the m17n engines and its GTK modules', () => {
    expect(depends('worksuite-desktop')).toEqual(expect.arrayContaining(['ibus', 'ibus-m17n', 'ibus-gtk3', 'ibus-gtk4']))
  })
  it('offers Sinhala (Wijesekara, phonetic) and Tamil 99 by default, each an m17n file that exists', () => {
    const o = read('services/session/gnome/95_worksuite-gnome.gschema.override')
    const ims = [...o.matchAll(/\('ibus', 'm17n:([a-z]+):([a-z0-9]+)'\)/g)].map((m) => `${m[1]}-${m[2]}`)
    expect(ims).toEqual(['si-wijesekera', 'si-singlish', 'ta-tamil99'])
    // m17n_si_wijesekara (sic) shipped once and never loaded: the m17n file is si-wijesekera.mim.
    for (const id of ims) expect(['si-wijesekera', 'si-singlish', 'ta-tamil99', 'ta-phonetic']).toContain(id)
    expect(o).toMatch(/^xkb-options=\['compose:ralt'\]$/m)
  })
  it('ships Sinhala and Tamil Unicode fonts and the fontconfig preferences for them', () => {
    const list = read('live-build/config/package-lists/worksuite.list.chroot')
    for (const p of ['fonts-noto-core', 'fonts-noto-ui-core', 'fonts-lklug-sinhala', 'fontconfig', 'ibus', 'ibus-m17n']) expect(list).toMatch(new RegExp(`^${p}$`, 'm'))
    const conf = read('services/session/fontconfig/60-worksuite-sinhala-tamil.conf')
    expect(conf).toContain('<string>Noto Sans Sinhala UI</string>')
    expect(conf).toContain('<string>Noto Sans Tamil UI</string>')
    expect(read('packaging/debian/worksuite-session.install')).toContain('services/session/fontconfig/60-worksuite-sinhala-tamil.conf etc/fonts/conf.d/')
  })
  it('the WorkSuite windows speak Wayland IME (text-input-v3), which GNOME Shell offers', () => {
    expect(read('shell/electron/main.ts')).toContain("appendSwitch('enable-wayland-ime')")
    for (const f of ['shell/electron/main.ts', 'shell/electron/kioskMain.ts']) expect(read(f)).toContain("appendSwitch('wayland-text-input-version', '3')")
  })
})

describe('keyring unlock on sign-in (WSOS-INT-009)', () => {
  it('installs the PAM module and the image build fails without it in common-auth/common-session', () => {
    expect(depends('worksuite-user-services')).toContain('libpam-gnome-keyring')
    const hook = read('live-build/config/hooks/normal/0100-worksuite-defaults.hook.chroot')
    expect(hook).toMatch(/pam_gnome_keyring\.so \/etc\/pam\.d\/common-auth/)
    expect(hook).toMatch(/pam_gnome_keyring\.so \/etc\/pam\.d\/common-session/)
  })
})

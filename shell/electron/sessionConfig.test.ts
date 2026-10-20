// Session configuration checks that run with the unit tests: portal backends (WSOS-INT-012), input methods
// (WSOS-INT-011) and keyring unlock on sign-in (WSOS-INT-009). They read the files the packages install.
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { INPUT_METHODS, parseFcitxProfile } from './peripherals'

const ROOT = join(__dirname, '..', '..')
const read = (p: string) => readFileSync(join(ROOT, p), 'utf8')
const control = read('packaging/debian/control')
const paragraph = (pkg: string) => control.split(/\n\n+/).find((p) => p.startsWith(`Package: ${pkg}\n`)) ?? ''
const depends = (pkg: string) => (/^Depends:([\s\S]*?)(?=^\S)/m.exec(paragraph(pkg) + '\nEnd:')?.[1] ?? '').split(/[,|\n]/).map((s) => s.trim().split(/\s/)[0]).filter(Boolean)

/** Interfaces each backend implements upstream (its .portal file), and the package that ships it. */
const BACKENDS: Record<string, { pkg: string; ifaces: string[] }> = {
  gtk: { pkg: 'xdg-desktop-portal-gtk', ifaces: ['FileChooser', 'AppChooser', 'Print', 'Notification', 'Inhibit', 'Access', 'Account', 'Email', 'DynamicLauncher', 'Lockdown', 'Settings', 'OpenURI'] },
  wlr: { pkg: 'xdg-desktop-portal-wlr', ifaces: ['Screenshot', 'ScreenCast'] },
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
    expect(def && BACKENDS[def]).toBeTruthy()
    for (const b of Object.values(map)) expect(b === 'none' || b in BACKENDS).toBe(true)
  })
  it('is installed where xdg-desktop-portal looks for <desktop>-portals.conf', () => {
    expect(read('packaging/debian/worksuite-session.install')).toContain('services/session/portals/worksuite-portals.conf usr/share/xdg-desktop-portal/')
    expect(read('services/session/labwc/environment')).toMatch(/^XDG_CURRENT_DESKTOP=WorkSuite(:|$)/m)
  })
})

describe('input methods (WSOS-INT-011)', () => {
  it('ships fcitx5 with the Sinhala/Tamil engines and frontends', () => {
    expect(depends('worksuite-desktop')).toEqual(expect.arrayContaining(['fcitx5', 'fcitx5-m17n', 'fcitx5-frontend-gtk3', 'fcitx5-frontend-gtk4', 'fcitx5-frontend-qt6']))
  })
  it('enables Sinhala and Tamil by default, all offered in Settings', () => {
    const ims = parseFcitxProfile(read('services/session/fcitx5/profile'))
    expect(ims).toEqual(['keyboard-us', 'm17n_si_wijesekera', 'm17n_si_singlish', 'm17n_ta_tamil99'])
    for (const id of ims) expect(INPUT_METHODS).toContain(id)
    expect(read('packaging/debian/worksuite-session.install')).toContain('services/session/fcitx5/profile etc/xdg/fcitx5/')
  })
  it('every default input method exists in m17n-db (the file is <lang>-<name>.mim)', () => {
    // m17n_si_wijesekara (sic) shipped once and never loaded: the m17n file is si-wijesekera.mim.
    const known = ['si-wijesekera', 'si-singlish', 'ta-tamil99', 'ta-phonetic']
    for (const id of INPUT_METHODS.filter((m) => m.startsWith('m17n_'))) expect(known).toContain(id.slice(5).replace('_', '-'))
  })
  it('ships Sinhala and Tamil Unicode fonts and the fontconfig preferences for them', () => {
    const list = read('live-build/config/package-lists/worksuite.list.chroot')
    for (const p of ['fonts-noto-core', 'fonts-noto-ui-core', 'fonts-lklug-sinhala', 'fontconfig']) expect(list).toMatch(new RegExp(`^${p}$`, 'm'))
    const conf = read('services/session/fontconfig/60-worksuite-sinhala-tamil.conf')
    expect(conf).toContain('<string>Noto Sans Sinhala UI</string>')
    expect(conf).toContain('<string>Noto Sans Tamil UI</string>')
    expect(read('packaging/debian/worksuite-session.install')).toContain('services/session/fontconfig/60-worksuite-sinhala-tamil.conf etc/fonts/conf.d/')
    expect(read('shell/src/index.css')).toMatch(/--font-sans: "IBM Plex Sans", "Noto Sans Sinhala UI"/)
  })
  it('starts fcitx5 with the session and sets the IM and compose environment', () => {
    expect(read('services/session/systemd/user/worksuite-session.target')).toMatch(/Wants=.*worksuite-input-method\.service/)
    expect(read('services/session/systemd/user/worksuite-input-method.service')).toMatch(/^ExecStart=\/usr\/bin\/fcitx5\b/m)
    const env = read('services/session/labwc/environment')
    for (const l of ['XMODIFIERS=@im=fcitx', 'QT_IM_MODULE=fcitx', 'XKB_DEFAULT_OPTIONS=compose:ralt']) expect(env).toContain(l)
    expect(read('shell/electron/main.ts')).toContain("appendSwitch('enable-wayland-ime')")
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

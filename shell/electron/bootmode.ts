// Which screen the shell opens. `--recovery` (worksuite-recovery-shell.service), `--installer` (live ISO), or the kernel command
// line flag `worksuite.recovery=1` set by the GRUB "WorkSuite Recovery" entry (SRS §9.2). Nothing else is accepted.
// `--safe`: the session's minimal launcher after repeated shell crashes (worksuite-recovery-launcher.service, WSOS-SES-005).
// Under GNOME (the desktop since 1.1) the shell is not the desktop: `--control-center [section]` opens WorkSuite
// Settings (Updates, Drivers, Date & time, enterprise…) as an ordinary window, and `--setup` the first-run wizard.
export type BootMode = 'recovery' | 'installer' | 'safe' | 'control' | 'setup' | null
/** Settings sections a launcher may ask for (names as Settings' own navigation, letters, spaces and & only). */
export const SECTION_RE = /^[A-Za-z][A-Za-z &]{0,40}$/
export function controlSection(argv: string[]): string | null {
  const i = argv.indexOf('--control-center')
  const s = i >= 0 ? argv[i + 1] : undefined
  return s && !s.startsWith('-') && SECTION_RE.test(s) ? s : null
}

export function cmdlineRecovery(cmdline: string | null): boolean {
  return (cmdline ?? '').trim().split(/\s+/).some((t) => t === 'worksuite.recovery=1' || t === 'systemd.unit=worksuite-recovery.target')
}

export function bootMode(argv: string[], cmdline: string | null): BootMode {
  if (argv.includes('--recovery') || cmdlineRecovery(cmdline)) return 'recovery'
  if (argv.includes('--installer')) return 'installer'
  if (argv.includes('--safe')) return 'safe'
  if (argv.includes('--control-center')) return 'control'
  if (argv.includes('--setup')) return 'setup'
  return null
}

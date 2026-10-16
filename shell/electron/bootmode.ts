// Which screen the shell opens. `--recovery` (recovery launcher unit), `--installer` (live ISO), or the kernel command
// line flag `worksuite.recovery=1` set by the GRUB "WorkSuite Recovery" entry (SRS §9.2). Nothing else is accepted.
// `--safe`: the session's minimal launcher after repeated shell crashes (worksuite-recovery-launcher.service, WSOS-SES-005).
export type BootMode = 'recovery' | 'installer' | 'safe' | null

export function cmdlineRecovery(cmdline: string | null): boolean {
  return (cmdline ?? '').trim().split(/\s+/).some((t) => t === 'worksuite.recovery=1' || t === 'systemd.unit=worksuite-recovery.target')
}

export function bootMode(argv: string[], cmdline: string | null): BootMode {
  if (argv.includes('--recovery') || cmdlineRecovery(cmdline)) return 'recovery'
  if (argv.includes('--installer')) return 'installer'
  if (argv.includes('--safe')) return 'safe'
  return null
}

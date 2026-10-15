// Which screen the shell opens. `--recovery` (recovery launcher unit), `--installer` (live ISO), or the kernel command
// line flag `worksuite.recovery=1` set by the GRUB "WorkSuite Recovery" entry (SRS §9.2). Nothing else is accepted.
export type BootMode = 'recovery' | 'installer' | null

export function cmdlineRecovery(cmdline: string | null): boolean {
  return (cmdline ?? '').trim().split(/\s+/).some((t) => t === 'worksuite.recovery=1' || t === 'systemd.unit=worksuite-recovery.target')
}

export function bootMode(argv: string[], cmdline: string | null): BootMode {
  if (argv.includes('--recovery') || cmdlineRecovery(cmdline)) return 'recovery'
  if (argv.includes('--installer')) return 'installer'
  return null
}

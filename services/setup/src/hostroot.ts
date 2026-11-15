// Which commands change installed packages and so must write /usr, /etc and /opt. The setup service runs with
// ProtectSystem=full (those paths read-only in its namespace); these run in a transient unit instead (main.ts viaHost).
// Everything else (queries, simulations, dpkg --audit, journalctl) stays inside the service's own sandbox.

/** apt-get subcommands that change the system; simulations (-s) and --print-uris only read. */
const APT_WRITES = new Set(['install', 'remove', 'purge', 'update', 'upgrade', 'dist-upgrade', 'full-upgrade', 'autoremove'])

export function hostRoot(cmd: string, args: readonly string[]): boolean {
  if (cmd === 'apt-get') {
    if (args.some((a) => a === '-s' || a === '--simulate' || a === '--dry-run' || a === '--print-uris')) return false
    return args.some((a) => APT_WRITES.has(a))
  }
  if (cmd === 'dpkg') return args.some((a) => /^(-i|--install|-r|--remove|-P|--purge|--configure|-a|--unpack)$/.test(a))
  if (cmd === 'flatpak') return args[0] === 'install' || args[0] === 'uninstall' || args[0] === 'update'
  // Launcher caches live under /usr/share.
  return cmd === 'update-desktop-database'
}

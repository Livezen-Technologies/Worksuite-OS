// WSOS-SYN-010: the local SQLite store lives on encrypted storage when the device uses LUKS. The installer puts
// /home on LUKS when encryption is chosen (installer/modules/partition.conf); this check makes sure the database
// directory really is on a dm-crypt device before the service opens it, and refuses otherwise.
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';

export type Run = (cmd: string, args: string[]) => string | null;
export const realRun: Run = (cmd, args) => {
  try { return execFileSync(cmd, args, { encoding: 'utf8', timeout: 5000, stdio: ['ignore', 'pipe', 'ignore'] }); } catch { return null; }
};

/** True when /etc/crypttab names at least one device (the system was installed with LUKS). */
export function luksEnabled(crypttab: string | null): boolean {
  return (crypttab ?? '').split('\n').some((l) => l.trim() !== '' && !l.trim().startsWith('#'));
}

/** findmnt SOURCE may carry a btrfs subvolume ("/dev/mapper/root[/@home]"). */
export function sourceDevice(findmnt: string): string | null {
  const s = findmnt.trim().split('\n')[0]?.replace(/\[.*\]$/, '') ?? '';
  return s.startsWith('/dev/') ? s : null;
}

/** Whether `dir` sits on a dm-crypt device: null when it cannot be told (e.g. tmpfs, missing tools). */
export function onEncryptedStorage(dir: string, run: Run = realRun): boolean | null {
  const out = run('findmnt', ['-n', '-o', 'SOURCE', '-T', dir]);
  const dev = out ? sourceDevice(out) : null;
  if (!dev) return null;
  // -s walks from the device down to its parents (partition ← crypt ← lvm …).
  const types = run('lsblk', ['-s', '-n', '-o', 'TYPE', dev]);
  if (types === null) return null;
  return types.split('\n').some((t) => t.trim() === 'crypt');
}

export type StorageVerdict = { ok: true; encrypted: boolean | null } | { ok: false; reason: 'storage_unencrypted' };

/** With LUKS enabled the store must be on dm-crypt; an unknown answer is refused too, since it can't be shown safe. */
export function checkStorage(dir: string, crypttab: string | null, run: Run = realRun): StorageVerdict {
  const enc = onEncryptedStorage(dir, run);
  if (!luksEnabled(crypttab)) return { ok: true, encrypted: enc };
  return enc === true ? { ok: true, encrypted: true } : { ok: false, reason: 'storage_unencrypted' };
}

export function readCrypttab(path = '/etc/crypttab'): string | null {
  try { return readFileSync(path, 'utf8'); } catch { return null; }
}

// WSOS-SEC-005: files the user hands to the root package service (local .deb) are first parsed by an unprivileged
// process: a private copy owned by nobody, read by dpkg-deb under setpriv as nobody/nogroup with no groups, no
// capabilities and no_new_privs. Only a file that parses cleanly there is given to apt (which runs as root).
import { chownSync, copyFileSync, mkdtempSync, rmSync, chmodSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Runner } from './service.ts';

export interface Unprivileged { uid: number; gid: number; chown(path: string, uid: number, gid: number): void; tmpDir?: string }
export const NOBODY: Unprivileged = { uid: 65534, gid: 65534, chown: chownSync };

export const dropPrivileges = (u: Unprivileged) =>
  ['setpriv', `--reuid=${u.uid}`, `--regid=${u.gid}`, '--clear-groups', '--no-new-privs', '--inh-caps=-all', '--bounding-set=-all', '--'];

/** Control fields of a .deb, read without root. Output is capped; the caller still validates every field. */
export async function debFieldsUnprivileged(runner: Runner, path: string, fields: string[], u: Unprivileged = NOBODY) {
  const dir = mkdtempSync(join(u.tmpDir ?? tmpdir(), 'ws-untrusted-'));
  try {
    const copy = join(dir, 'package.deb');
    copyFileSync(path, copy);
    chmodSync(copy, 0o400); chmodSync(dir, 0o700);
    u.chown(copy, u.uid, u.gid); u.chown(dir, u.uid, u.gid);
    const [cmd, ...pre] = dropPrivileges(u);
    const r = await runner.run(cmd, [...pre, 'dpkg-deb', '--field', copy, ...fields]);
    return { ...r, stdout: r.stdout.slice(0, 64 * 1024) };
  } finally { rmSync(dir, { recursive: true, force: true }); }
}

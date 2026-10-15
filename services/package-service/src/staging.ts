// Files handed to the root package service by path (local .deb installs, .wsupdate bundles). The service never
// works on the caller's file in place: it opens it without following symlinks, checks ownership/location, and
// copies it into a root-owned spool named by its SHA-256. Every later step uses that copy, so the file the user
// confirmed is the file that gets installed (WSOS-APT-005, WSOS-AUP-010).
import { createHash } from 'node:crypto';
import { closeSync, constants, existsSync, fstatSync, mkdirSync, openSync, readSync, realpathSync, renameSync, rmSync, writeSync } from 'node:fs';
import { join } from 'node:path';
import { ServiceError } from './apt.ts';

export const MAX_DEB_BYTES = 4 * 1024 ** 3;

export interface Staged { path: string; sha256: string; size: number }

/** Copy `src` into `spool/<sha256><ext>` and hash it in one pass. `owner` is the bus caller's UID: a non-root caller
 *  may only hand over files it owns (root can't be tricked into reading someone else's file for them). */
export function stageFile(src: string, owner: number, spool: string, ext: string, maxBytes = MAX_DEB_BYTES): Staged {
  if (typeof src !== 'string' || !src.startsWith('/') || src.includes('\0')) throw new ServiceError('InvalidArgs', 'absolute path required');
  if (!src.toLowerCase().endsWith(ext)) throw new ServiceError('InvalidArgs', `not a ${ext} file`);
  let fd: number;
  try { fd = openSync(src, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK); }
  catch { throw new ServiceError('InvalidArgs', 'file not found or is a link'); }
  try {
    const st = fstatSync(fd);
    if (!st.isFile()) throw new ServiceError('InvalidArgs', 'not a regular file');
    if (owner !== 0 && st.uid !== owner) throw new ServiceError('NotAuthorized', 'the file must belong to you');
    if (st.size > maxBytes) throw new ServiceError('InvalidArgs', 'file too large');
    mkdirSync(spool, { recursive: true, mode: 0o700 });
    const tmp = join(spool, `.incoming-${process.pid}-${Date.now()}`);
    const out = openSync(tmp, 'w', 0o600);
    const hash = createHash('sha256');
    const buf = Buffer.alloc(1 << 20);
    let size = 0;
    try {
      for (let n; (n = readSync(fd, buf, 0, buf.length, null)) > 0;) {
        size += n;
        if (size > maxBytes) throw new ServiceError('InvalidArgs', 'file too large');
        hash.update(buf.subarray(0, n)); writeSync(out, buf, 0, n);
      }
    } catch (e) { closeSync(out); rmSync(tmp, { force: true }); throw e; }
    closeSync(out);
    const sha256 = hash.digest('hex');
    const path = join(spool, sha256 + ext);
    renameSync(tmp, path);
    return { path, sha256, size };
  } finally { closeSync(fd); }
}

/** A previously staged copy, re-hashed so a confirmation token always names exactly the bytes that were previewed. */
export function stagedCopy(spool: string, sha256: string, ext: string): string | null {
  if (!/^[0-9a-f]{64}$/.test(sha256)) return null;
  const path = join(spool, sha256 + ext);
  if (!existsSync(path)) return null;
  return sha256File(path) === sha256 ? path : null;
}

export function sha256File(path: string, start = 0, end?: number): string {
  const fd = openSync(path, 'r');
  try {
    const hash = createHash('sha256');
    const buf = Buffer.alloc(1 << 20);
    let pos = start;
    const stop = end ?? fstatSync(fd).size;
    while (pos < stop) {
      const n = readSync(fd, buf, 0, Math.min(buf.length, stop - pos), pos);
      if (n <= 0) break;
      hash.update(buf.subarray(0, n)); pos += n;
    }
    return hash.digest('hex');
  } finally { closeSync(fd); }
}

/** Offline bundles come from removable media or the caller's home (WSOS-AUP-010). */
export const BUNDLE_ROOTS = ['/media/', '/run/media/', '/mnt/', '/home/'];

export function bundlePath(src: string, roots = BUNDLE_ROOTS): string {
  if (typeof src !== 'string' || !src.startsWith('/') || src.includes('\0') || !src.endsWith('.wsupdate')) throw new ServiceError('InvalidArgs', 'choose a .wsupdate file');
  let real: string;
  try { real = realpathSync(src); } catch { throw new ServiceError('InvalidArgs', 'file not found'); }
  if (!roots.some((r) => real.startsWith(r))) throw new ServiceError('InvalidArgs', 'bundles are read from removable media or your home folder');
  return real;
}

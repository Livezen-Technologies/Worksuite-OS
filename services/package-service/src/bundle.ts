// Offline update bundles (.wsupdate, WSOS-AUP-010). A bundle is a plain POSIX tar holding:
//   manifest.json   a release manifest signed with the release key (same format and key as the online manifest),
//                   plus bundle.files = [{ name, sha256, size }] for every package in pool/
//   pool/<name>.deb the packages to install
// Nothing else is allowed. The signature covers the file list, so every .deb is bound to the release key. Packages
// are extracted to a root-owned directory and re-hashed there, so what is installed is what was verified, whatever
// happens to the USB stick in between.
import { closeSync, fstatSync, mkdirSync, openSync, readSync, rmSync, writeSync } from 'node:fs';
import { join } from 'node:path';
import type { KeyObject } from 'node:crypto';
import { ServiceError } from './apt.ts';
import { sha256File } from './staging.ts';
import { compareVersions, verifyManifest, type Manifest } from './updates.ts';

export interface BundleFile { name: string; sha256: string; size: number }
export type BundleManifest = Manifest & { bundle: { files: BundleFile[] } };
interface Entry { name: string; offset: number; size: number; type: string }

const MAX_MANIFEST = 1024 * 1024;
const POOL = /^pool\/[a-z0-9][a-z0-9+.~_-]{0,200}\.deb$/;

function octal(b: Buffer) {
  const s = b.toString('latin1').replace(/\0.*$/s, '').trim();
  if (!/^[0-7]*$/.test(s)) throw new ServiceError('Failed', 'not a .wsupdate bundle');
  return s ? parseInt(s, 8) : 0;
}

/** ustar/GNU tar member list (regular files and directories only). */
export function listTar(fd: number): Entry[] {
  const size = fstatSync(fd).size;
  const out: Entry[] = [];
  const h = Buffer.alloc(512);
  let pos = 0;
  while (pos + 512 <= size) {
    if (readSync(fd, h, 0, 512, pos) !== 512) break;
    if (h.every((x) => x === 0)) break;                         // end-of-archive
    let sum = 0;
    for (let i = 0; i < 512; i++) sum += i >= 148 && i < 156 ? 32 : h[i];
    if (sum !== octal(h.subarray(148, 156))) throw new ServiceError('Failed', 'not a .wsupdate bundle (bad tar header)');
    const name = h.subarray(0, 100).toString('utf8').replace(/\0.*$/s, '');
    const prefix = h.subarray(257, 263).toString('latin1').startsWith('ustar') ? h.subarray(345, 500).toString('utf8').replace(/\0.*$/s, '') : '';
    const type = String.fromCharCode(h[156] || 48);
    const len = octal(h.subarray(124, 136));
    const full = (prefix ? `${prefix}/${name}` : name).replace(/^\.\//, '');
    if (type !== '0' && type !== '5') throw new ServiceError('Failed', `bundle member ${full} is not a plain file`);
    if (pos + 512 + len > size) throw new ServiceError('Failed', 'bundle is truncated');
    if (type === '0') out.push({ name: full, offset: pos + 512, size: len, type });
    pos += 512 + Math.ceil(len / 512) * 512;
  }
  return out;
}

export interface OpenBundleOptions {
  keys: (id: string) => KeyObject | undefined;
  arch: string;
  installed: string;
}

/** Read and verify the manifest; returns the member table. Throws SignatureInvalid for anything unsigned or altered. */
export function inspectBundle(path: string, o: OpenBundleOptions): { manifest: BundleManifest; entries: Entry[] } {
  const fd = openSync(path, 'r');
  try {
    const entries = listTar(fd);
    const names = entries.map((e) => e.name);
    if (new Set(names).size !== names.length) throw new ServiceError('Failed', 'bundle has duplicate members');
    const me = entries.find((e) => e.name === 'manifest.json');
    if (!me || me.size > MAX_MANIFEST) throw new ServiceError('Failed', 'bundle has no manifest');
    const buf = Buffer.alloc(me.size);
    readSync(fd, buf, 0, me.size, me.offset);
    let m: unknown;
    try { m = JSON.parse(buf.toString('utf8')); } catch { throw new ServiceError('Failed', 'bundle manifest is not valid'); }
    if (!verifyManifest(m, o.keys)) throw new ServiceError('SignatureInvalid', 'bundle is not signed with the WorkSuite release key');
    const bm = m as BundleManifest;
    const files = bm.bundle?.files;
    if (!Array.isArray(files) || !files.length) throw new ServiceError('Failed', 'bundle lists no packages');
    if (bm.arch !== o.arch) throw new ServiceError('ArchMismatch', `bundle is for ${bm.arch}; this device is ${o.arch}`);
    if (bm.state === 'pulled') throw new ServiceError('PreconditionFailed', 'this release was pulled');
    const cmp = compareVersions(bm.version, o.installed);
    if (cmp === 0) throw new ServiceError('PreconditionFailed', `version ${bm.version} is already installed`);
    if (cmp < 0 && bm.rollback_directive?.from_version !== o.installed) throw new ServiceError('PreconditionFailed', 'refused a downgrade without a signed rollback directive');
    // The signed list and the archive must match exactly: nothing missing, nothing extra.
    const pool = entries.filter((e) => e.name !== 'manifest.json');
    const listed = new Map(files.map((f) => [`pool/${f.name}`, f]));
    for (const e of pool) {
      if (!POOL.test(e.name)) throw new ServiceError('Failed', `unexpected bundle member ${e.name}`);
      const f = listed.get(e.name);
      if (!f) throw new ServiceError('SignatureInvalid', `${e.name} is not in the signed manifest`);
      if (f.size !== e.size || !/^[0-9a-f]{64}$/.test(f.sha256) || sha256File(path, e.offset, e.offset + e.size) !== f.sha256) throw new ServiceError('SignatureInvalid', `${e.name} does not match the signed manifest`);
    }
    if (pool.length !== listed.size) throw new ServiceError('SignatureInvalid', 'bundle is missing packages listed in its manifest');
    return { manifest: bm, entries: pool };
  } finally { closeSync(fd); }
}

/** Copy every package to `dir`, then re-hash the copy against the signed manifest. Returns the absolute .deb paths. */
export function extractBundle(path: string, dir: string, o: OpenBundleOptions): { manifest: BundleManifest; debs: string[] } {
  const { manifest, entries } = inspectBundle(path, o);
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const fd = openSync(path, 'r');
  const debs: string[] = [];
  try {
    const buf = Buffer.alloc(1 << 20);
    for (const e of entries) {
      const dest = join(dir, e.name.slice('pool/'.length));
      const out = openSync(dest, 'wx', 0o600);
      try {
        for (let done = 0; done < e.size;) {
          const n = readSync(fd, buf, 0, Math.min(buf.length, e.size - done), e.offset + done);
          if (n <= 0) throw new ServiceError('Failed', 'bundle is truncated');
          writeSync(out, buf, 0, n); done += n;
        }
      } finally { closeSync(out); }
      const want = manifest.bundle.files.find((f) => `pool/${f.name}` === e.name)!.sha256;
      if (sha256File(dest) !== want) { rmSync(dir, { recursive: true, force: true }); throw new ServiceError('SignatureInvalid', `${e.name} failed its checksum`); }
      debs.push(dest);
    }
  } finally { closeSync(fd); }
  // Sorted, so apt gets the same command line whatever order the archive lists its members in.
  return { manifest, debs: debs.sort() };
}

// Test fixtures: signed manifests, .wsupdate tars, and minimal type 2 AppImages (ELF64 runtime header + SquashFS).
import { execFileSync } from 'node:child_process';
import { createHash, generateKeyPairSync, sign, type KeyObject } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { canonical } from '../src/updates.ts';

export const tmp = (p = 'ws-test-') => mkdtempSync(join(tmpdir(), p));

export function releaseKey(id = 'ws-test') {
  const { publicKey, privateKey } = generateKeyPairSync('ed25519');
  const signFlat = <T extends Record<string, unknown>>(body: T) => {
    const { signature: _s, ...rest } = body;
    return { ...rest, signature: `${id}:${sign(null, Buffer.from(canonical(rest)), privateKey).toString('base64')}` };
  };
  return { id, publicKey, keys: (k: string): KeyObject | undefined => (k === id ? publicKey : undefined), signFlat };
}

export const sha256 = (b: Buffer | string) => createHash('sha256').update(b).digest('hex');

/** A .wsupdate tar built with the system tar (ustar), with a signed manifest over the listed files. */
export function makeBundle(dir: string, opts: { sign: (m: Record<string, unknown>) => Record<string, unknown>; version?: string; arch?: string;
  debs?: Record<string, string>; tamper?: (root: string) => void; manifest?: Record<string, unknown> }): string {
  const root = join(dir, 'bundle-src');
  mkdirSync(join(root, 'pool'), { recursive: true });
  const debs = opts.debs ?? { 'worksuite-desktop_1.1.0_amd64.deb': 'deb one', 'worksuite-shell_1.1.0_amd64.deb': 'deb two' };
  for (const [n, c] of Object.entries(debs)) writeFileSync(join(root, 'pool', n), c);
  const files = Object.entries(debs).map(([name, c]) => ({ name, sha256: sha256(c), size: Buffer.byteLength(c) }));
  const m = opts.sign({ release_id: 'rel-1.1.0', version: opts.version ?? '1.1.0', min_version: '1.0.0', ring: 'stable', arch: opts.arch ?? 'amd64',
    bundle: { files }, ...opts.manifest });
  writeFileSync(join(root, 'manifest.json'), JSON.stringify(m));
  opts.tamper?.(root);
  const out = join(dir, 'update.wsupdate');
  execFileSync('tar', ['--format=ustar', '-cf', out, '-C', root, 'manifest.json', 'pool']);
  return out;
}

/** Minimal type 2 AppImage: ELF64 header, .sha256_sig/.sig_key/.shstrtab sections, section table, then SquashFS. */
export function makeAppImage(dir: string, o: { machine?: number; name?: string; version?: string; squash?: boolean } = {}): string {
  const names = Buffer.from('\0.sha256_sig\0.sig_key\0.shstrtab\0', 'latin1');
  const SIG = 1024, KEY = 8192;
  const dataOff = 64, sigOff = dataOff, keyOff = sigOff + SIG, strOff = keyOff + KEY, shoff = strOff + names.length + (8 - (names.length % 8)) % 8;
  const shnum = 4;
  const head = Buffer.alloc(shoff + 64 * shnum);
  head.writeUInt32BE(0x7f454c46, 0); head[4] = 2; head[5] = 1; head[6] = 1;
  head[8] = 0x41; head[9] = 0x49; head[10] = 2;
  head.writeUInt16LE(2, 16); head.writeUInt16LE(o.machine ?? 62, 18); head.writeUInt32LE(1, 20);
  head.writeBigUInt64LE(BigInt(shoff), 0x28); head.writeUInt16LE(64, 0x34); head.writeUInt16LE(64, 0x3a); head.writeUInt16LE(shnum, 0x3c); head.writeUInt16LE(3, 0x3e);
  names.copy(head, strOff);
  const sec = (i: number, name: number, off: number, size: number) => {
    head.writeUInt32LE(name, shoff + i * 64); head.writeUInt32LE(1, shoff + i * 64 + 4);
    head.writeBigUInt64LE(BigInt(off), shoff + i * 64 + 0x18); head.writeBigUInt64LE(BigInt(size), shoff + i * 64 + 0x20);
  };
  sec(1, 1, sigOff, SIG); sec(2, names.indexOf('.sig_key'), keyOff, KEY); sec(3, names.indexOf('.shstrtab'), strOff, names.length);
  let payload = Buffer.alloc(0);
  if (o.squash !== false) {
    const sq = join(dir, 'sq'); mkdirSync(sq, { recursive: true });
    writeFileSync(join(sq, 'app.desktop'), `[Desktop Entry]\nType=Application\nName=${o.name ?? 'Pinta'}\nExec=pinta %F\nIcon=pinta\nCategories=Graphics;\nX-AppImage-Version=${o.version ?? '2.1'}\n`);
    writeFileSync(join(sq, 'pinta.png'), Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.from('fake png')]));
    writeFileSync(join(sq, 'AppRun'), '#!/bin/sh\necho hi\n');
    const img = join(dir, 'payload.squashfs');
    execFileSync('mksquashfs', [sq, img, '-noappend', '-quiet', '-all-root']);
    payload = readFileSync(img);
  }
  const out = join(dir, `${o.name ?? 'Pinta'}-${o.version ?? '2.1'}.AppImage`);
  writeFileSync(out, Buffer.concat([head, payload]));
  return out;
}

export const SIG_OFFSET = 64, KEY_OFFSET = 64 + 1024;

/** Sign like appimagetool: detached armored signature over the hex SHA-256 (signature sections still zero). */
export function signAppImage(file: string, gpgHome: string) {
  const buf = readFileSync(file);
  const digestFile = join(gpgHome, 'digest');
  writeFileSync(digestFile, sha256(buf));
  const sig = execFileSync('gpg', ['--homedir', gpgHome, '--batch', '--yes', '--armor', '--detach-sign', '--output', '-', digestFile]);
  const key = execFileSync('gpg', ['--homedir', gpgHome, '--batch', '--armor', '--export']);
  sig.copy(buf, SIG_OFFSET); key.copy(buf, KEY_OFFSET);
  writeFileSync(file, buf);
}

export function gpgKey(uid: string): { home: string; fingerprint: string } {
  const home = tmp('ws-gpg-');
  execFileSync('gpg', ['--homedir', home, '--batch', '--passphrase', '', '--quick-gen-key', uid, 'ed25519', 'sign', 'never'], { stdio: 'ignore' });
  const out = execFileSync('gpg', ['--homedir', home, '--batch', '--with-colons', '--fingerprint'], { encoding: 'utf8' });
  return { home, fingerprint: /^fpr:+([0-9A-F]+):/m.exec(out)![1] };
}

export const has = (cmd: string) => { try { execFileSync('sh', ['-c', `command -v ${cmd}`], { stdio: 'ignore' }); return true; } catch { return false; } };

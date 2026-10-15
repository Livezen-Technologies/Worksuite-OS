// AppImage management (SRS §6 WSOS-AIM-001…004, WSOS-ARM-005). Runs as the user (AppImages live in the user's home),
// through the worksuite-appimage CLI that the shell calls with fixed arguments.
//
//   import   copy into ~/.local/share/worksuite/appimages/<id>/, record origin, SHA-256, version, arch and signature,
//            and write a desktop entry and icon. The file is stored NOT executable.
//   approve  explicit first-run approval (WSOS-AIM-002); re-checks hash, arch and policy, then marks it executable.
//   run      what the desktop entry calls: refuses unapproved, tampered, wrong-arch or policy-blocked AppImages.
//   update   replace with a newer file only when it is signed by the same key (WSOS-AIM-004); otherwise
//            "Manual update required".
//   remove   delete the AppImage, its desktop entry and icon (the app's own settings in ~/.config are left alone).
//
// Nothing extracts or executes the AppImage to read its metadata: the desktop file and icon are read from the
// embedded SquashFS with unsquashfs at the runtime's end offset. Signatures (WSOS-AIM-003) are the AppImage type 2
// embedded GPG signature: .sha256_sig holds a detached signature over the hex SHA-256 of the file with the
// .sha256_sig and .sig_key sections zeroed, .sig_key the signer's public key. A file without one is shown as
// "checksum only", never as a verified publisher.
import { createHash } from 'node:crypto';
import { chmodSync, closeSync, copyFileSync, existsSync, fstatSync, lstatSync, mkdirSync, mkdtempSync, openSync, readdirSync, readFileSync, readSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import type { Runner } from './service.ts';

export type Arch = 'amd64' | 'arm64';
export type SignatureState =
  | { status: 'signed'; fingerprint: string; trusted: boolean }   // trusted: fingerprint is in policy appimage_trusted_keys
  | { status: 'unsigned' }
  | { status: 'invalid'; reason: string };

export interface AppImageRecord {
  id: string; name: string; version: string | null; origin: string; sha256: string; arch: Arch; size: number;
  signature: SignatureState; approved: boolean; imported_at: string; approved_at: string | null;
  file: string; desktop_entry: string; icon: string | null; categories: string[];
}

export interface AppImageEnv {
  home: string;
  arch: Arch;
  /** Device policy (readable copy from the device agent); null on unmanaged devices. */
  policy(): { appimages?: 'allow' | 'block'; appimage_trusted_keys?: string[] } | null;
  runner: Runner;
  /** Start the approved AppImage (detached). */
  exec(file: string, args: string[]): void;
  now(): number;
  /** The launcher the desktop entry calls. */
  launcher?: string;
}

export class AppImageError extends Error {
  readonly code: string;
  constructor(code: 'PolicyBlocked' | 'ArchMismatch' | 'NotAppImage' | 'SignatureInvalid' | 'NotApproved' | 'Tampered' | 'NotFound' | 'ManualUpdateRequired' | 'InvalidArgs', message: string) {
    super(message); this.code = code;
  }
}

const ARCH: Record<number, Arch> = { 62: 'amd64', 183: 'arm64' };
const LABEL: Record<Arch, string> = { amd64: 'x86-64', arm64: 'ARM64' };

export interface ElfInfo { type: 1 | 2; arch: Arch | null; machine: number; payloadOffset: number; sections: Map<string, { offset: number; size: number }> }

/** Parse the ELF64 runtime header of an AppImage (no execution). */
export function inspectElf(fd: number): ElfInfo {
  const size = fstatSync(fd).size;
  const h = Buffer.alloc(64);
  if (readSync(fd, h, 0, 64, 0) !== 64 || h.readUInt32BE(0) !== 0x7f454c46) throw new AppImageError('NotAppImage', 'not an AppImage (not an ELF file)');
  if (h[8] !== 0x41 || h[9] !== 0x49 || (h[10] !== 1 && h[10] !== 2)) throw new AppImageError('NotAppImage', 'not an AppImage (no AppImage magic)');
  if (h[4] !== 2 || h[5] !== 1) throw new AppImageError('NotAppImage', 'only 64-bit little-endian AppImages are supported');
  const machine = h.readUInt16LE(18);
  const shoff = Number(h.readBigUInt64LE(0x28));
  const shentsize = h.readUInt16LE(0x3a), shnum = h.readUInt16LE(0x3c), shstrndx = h.readUInt16LE(0x3e);
  const payloadOffset = shoff + shentsize * shnum;
  if (shentsize !== 64 || shnum === 0 || shnum > 4096 || payloadOffset > size) throw new AppImageError('NotAppImage', 'AppImage runtime header is damaged');
  const sht = Buffer.alloc(shentsize * shnum);
  readSync(fd, sht, 0, sht.length, shoff);
  const sec = (i: number) => ({ name: sht.readUInt32LE(i * 64), offset: Number(sht.readBigUInt64LE(i * 64 + 0x18)), size: Number(sht.readBigUInt64LE(i * 64 + 0x20)) });
  const sections = new Map<string, { offset: number; size: number }>();
  if (shstrndx < shnum) {
    const strtab = sec(shstrndx);
    if (strtab.offset + strtab.size <= size && strtab.size < 1 << 20) {
      const names = Buffer.alloc(strtab.size);
      readSync(fd, names, 0, strtab.size, strtab.offset);
      for (let i = 0; i < shnum; i++) {
        const s = sec(i);
        const end = names.indexOf(0, s.name);
        const name = names.subarray(s.name, end < 0 ? undefined : end).toString('latin1');
        if (name && s.offset + s.size <= size) sections.set(name, { offset: s.offset, size: s.size });
      }
    }
  }
  return { type: h[10] as 1 | 2, arch: ARCH[machine] ?? null, machine, payloadOffset, sections };
}

function readSection(fd: number, s: { offset: number; size: number } | undefined): Buffer {
  if (!s || s.size === 0 || s.size > 1 << 20) return Buffer.alloc(0);
  const b = Buffer.alloc(s.size);
  readSync(fd, b, 0, s.size, s.offset);
  const end = b.indexOf(0);
  return end < 0 ? b : b.subarray(0, end);
}

/** SHA-256 of the whole file, and the signing digest (signature and key sections read as zeros). */
export function digests(fd: number, zero: { offset: number; size: number }[]): { sha256: string; signed: string } {
  const all = createHash('sha256'), signed = createHash('sha256');
  const buf = Buffer.alloc(1 << 20);
  const size = fstatSync(fd).size;
  for (let pos = 0; pos < size;) {
    const n = readSync(fd, buf, 0, Math.min(buf.length, size - pos), pos);
    if (n <= 0) break;
    const chunk = buf.subarray(0, n);
    all.update(chunk);
    const masked = Buffer.from(chunk);
    for (const z of zero) {
      const a = Math.max(z.offset, pos), b = Math.min(z.offset + z.size, pos + n);
      if (a < b) masked.fill(0, a - pos, b - pos);
    }
    signed.update(masked);
    pos += n;
  }
  return { sha256: all.digest('hex'), signed: signed.digest('hex') };
}

export class AppImages {
  private env: AppImageEnv;
  constructor(env: AppImageEnv) { this.env = env; }

  get root() { return join(this.env.home, '.local/share/worksuite/appimages'); }
  private appsDir() { return join(this.env.home, '.local/share/applications'); }
  private iconsDir() { return join(this.env.home, '.local/share/icons/hicolor'); }
  private desktopPath(id: string) { return join(this.appsDir(), `worksuite-appimage-${id}.desktop`); }

  private checkPolicy() {
    if (this.env.policy()?.appimages === 'block') throw new AppImageError('PolicyBlocked', 'Your organization does not allow AppImages on this device');
  }

  /** Inspect a file: arch, hashes and the embedded signature. */
  async inspect(path: string): Promise<{ elf: ElfInfo; sha256: string; size: number; signature: SignatureState }> {
    const fd = openSync(path, 'r');
    try {
      const st = fstatSync(fd);
      if (!st.isFile()) throw new AppImageError('NotAppImage', 'not a regular file');
      const elf = inspectElf(fd);
      if (elf.type !== 2) throw new AppImageError('NotAppImage', 'only type 2 AppImages are supported');
      const sigSec = elf.sections.get('.sha256_sig'), keySec = elf.sections.get('.sig_key');
      const zero = [sigSec, keySec].filter((s): s is { offset: number; size: number } => !!s);
      const d = digests(fd, zero);
      const sig = readSection(fd, sigSec), key = readSection(fd, keySec);
      const signature = sig.length ? await this.verify(sig, key, d.signed) : { status: 'unsigned' as const };
      return { elf, sha256: d.sha256, size: st.size, signature };
    } finally { closeSync(fd); }
  }

  /** Verify the embedded detached signature with the embedded key in a throwaway keyring. */
  private async verify(sig: Buffer, key: Buffer, digestHex: string): Promise<SignatureState> {
    if (!key.length) return { status: 'invalid', reason: 'signature present but no signing key embedded' };
    const dir = mkdtempSync(join(tmpdir(), 'ws-appimage-'));
    try {
      chmodSync(dir, 0o700);
      writeFileSync(join(dir, 'key.asc'), key); writeFileSync(join(dir, 'sig.asc'), sig); writeFileSync(join(dir, 'digest'), digestHex);
      const gpg = (args: string[]) => this.env.runner.run('gpg', ['--homedir', dir, '--batch', '--no-tty', '--no-auto-key-locate', ...args]);
      const imp = await gpg(['--import', join(dir, 'key.asc')]);
      if (imp.code !== 0) return { status: 'invalid', reason: 'embedded signing key is not readable' };
      const v = await gpg(['--status-fd', '1', '--verify', join(dir, 'sig.asc'), join(dir, 'digest')]);
      const fpr = /^\[GNUPG:\] VALIDSIG ([0-9A-F]{40,64})/m.exec(v.stdout)?.[1];
      if (v.code !== 0 || !fpr) return { status: 'invalid', reason: /BADSIG/.test(v.stdout) ? 'the file was changed after it was signed' : 'signature could not be verified' };
      const trusted = (this.env.policy()?.appimage_trusted_keys ?? []).map((k) => k.replace(/\s/g, '').toUpperCase()).includes(fpr);
      return { status: 'signed', fingerprint: fpr, trusted };
    } finally { rmSync(dir, { recursive: true, force: true }); }
  }

  private checkArch(arch: Arch | null, machine: number) {
    if (arch !== this.env.arch) throw new AppImageError('ArchMismatch', `This AppImage is built for ${arch ? LABEL[arch] : `machine type ${machine}`}; this device is ${LABEL[this.env.arch]}`);
  }

  async import(src: string, origin: string): Promise<AppImageRecord> {
    this.checkPolicy();
    if (!src.startsWith('/') || !/\.appimage$/i.test(src)) throw new AppImageError('InvalidArgs', 'choose an .AppImage file');
    if (origin.length > 2000 || /[\r\n]/.test(origin)) throw new AppImageError('InvalidArgs', 'origin');
    const info = await this.inspect(src);
    this.checkArch(info.elf.arch, info.elf.machine);
    if (info.signature.status === 'invalid') throw new AppImageError('SignatureInvalid', `Signature check failed: ${info.signature.reason}`);
    const id = info.sha256.slice(0, 16);
    const dir = join(this.root, id);
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    const file = join(dir, 'app.AppImage');
    copyFileSync(src, file + '.tmp');
    chmodSync(file + '.tmp', 0o600);                  // not executable until approved (WSOS-AIM-002)
    renameSync(file + '.tmp', file);
    // Re-hash the copy: what was inspected is what is stored.
    const copied = await this.inspect(file);
    if (copied.sha256 !== info.sha256) { rmSync(dir, { recursive: true, force: true }); throw new AppImageError('Tampered', 'the file changed while it was being imported'); }
    const meta = await this.metadata(file, info.elf.payloadOffset);
    const name = clean(meta.name ?? basename(src).replace(/\.appimage$/i, '')) || 'AppImage';
    const icon = meta.icon ? this.installIcon(id, meta.icon) : null;
    const rec: AppImageRecord = {
      id, name, version: meta.version, origin: origin || `file://${src}`, sha256: info.sha256, arch: info.elf.arch!, size: info.size,
      signature: info.signature, approved: false, imported_at: new Date(this.env.now()).toISOString(), approved_at: null,
      file, desktop_entry: this.desktopPath(id), icon, categories: meta.categories,
    };
    this.writeDesktop(rec);
    this.save(rec);
    return rec;
  }

  /** Desktop file and icon from the SquashFS payload, without running anything from the AppImage. */
  private async metadata(file: string, offset: number): Promise<{ name: string | null; version: string | null; categories: string[]; icon: { data: Buffer; ext: 'png' | 'svg' } | null }> {
    const out = mkdtempSync(join(tmpdir(), 'ws-appimage-x-'));
    const dest = join(out, 'root');
    try {
      const r = await this.env.runner.run('unsquashfs', ['-q', '-n', '-no-xattrs', '-o', String(offset), '-d', dest, file, '*.desktop', '.DirIcon', '*.png', '*.svg']);
      if (r.code !== 0 || !existsSync(dest)) return { name: null, version: null, categories: [], icon: null };
      const regular = (f: string) => { try { return lstatSync(join(dest, f)).isFile(); } catch { return false; } };
      const desk = readdirSync(dest).find((f) => f.endsWith('.desktop') && regular(f));
      const entry = desk ? parseDesktop(readFileSync(join(dest, desk), 'utf8')) : {};
      const iconName = entry.Icon && /^[A-Za-z0-9._-]{1,100}$/.test(entry.Icon) ? entry.Icon : null;
      // Only regular files from the top of the image; links are never followed.
      const pick = [iconName && `${iconName}.svg`, iconName && `${iconName}.png`, '.DirIcon'].find((f): f is string => !!f && regular(f));
      let icon: { data: Buffer; ext: 'png' | 'svg' } | null = null;
      if (pick) {
        const data = readFileSync(join(dest, pick));
        if (data.length <= 4 << 20) {
          if (data.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) icon = { data, ext: 'png' };
          else if (/<svg[\s>]/.test(data.subarray(0, 4096).toString('utf8'))) icon = { data, ext: 'svg' };
        }
      }
      return { name: entry.Name ?? null, version: entry['X-AppImage-Version'] ?? null, categories: (entry.Categories ?? '').split(';').filter((c) => /^[A-Za-z0-9-]{1,40}$/.test(c)), icon };
    } finally { rmSync(out, { recursive: true, force: true }); }
  }

  private installIcon(id: string, icon: { data: Buffer; ext: 'png' | 'svg' }): string {
    const dir = join(this.iconsDir(), icon.ext === 'svg' ? 'scalable/apps' : '256x256/apps');
    mkdirSync(dir, { recursive: true });
    const dest = join(dir, `worksuite-appimage-${id}.${icon.ext}`);
    writeFileSync(dest, icon.data, { mode: 0o644 });
    return dest;
  }

  private writeDesktop(rec: AppImageRecord) {
    mkdirSync(this.appsDir(), { recursive: true });
    const launcher = this.env.launcher ?? '/usr/bin/worksuite-appimage';
    const lines = [
      '[Desktop Entry]', 'Type=Application', `Name=${rec.name}`, `Comment=AppImage${rec.version ? ` ${clean(rec.version)}` : ''}${rec.signature.status === 'signed' ? '' : ' (checksum only, publisher not verified)'}`,
      `Exec=${launcher} run ${rec.id} %U`, `Icon=${rec.icon ? `worksuite-appimage-${rec.id}` : 'application-x-executable'}`,
      `Categories=${rec.categories.length ? rec.categories.join(';') + ';' : 'Utility;'}`, 'Terminal=false', `X-WorkSuite-AppImage=${rec.id}`, '',
    ];
    writeFileSync(rec.desktop_entry, lines.join('\n'), { mode: 0o644 });
  }

  private metaPath(id: string) { return join(this.root, id, 'metadata.json'); }
  private save(rec: AppImageRecord) { writeFileSync(this.metaPath(rec.id) + '.tmp', JSON.stringify(rec, null, 2), { mode: 0o600 }); renameSync(this.metaPath(rec.id) + '.tmp', this.metaPath(rec.id)); }

  get(id: string): AppImageRecord {
    if (!/^[0-9a-f]{16}$/.test(id)) throw new AppImageError('InvalidArgs', 'id');
    try { return JSON.parse(readFileSync(this.metaPath(id), 'utf8')) as AppImageRecord; } catch { throw new AppImageError('NotFound', 'no such AppImage'); }
  }

  list(): AppImageRecord[] {
    if (!existsSync(this.root)) return [];
    return readdirSync(this.root).filter((d) => /^[0-9a-f]{16}$/.test(d)).flatMap((d) => { try { return [this.get(d)]; } catch { return []; } })
      .sort((a, b) => a.name.localeCompare(b.name));
  }

  /** Hash, arch and policy, checked every time before the file may run. */
  private async check(rec: AppImageRecord) {
    this.checkPolicy();
    const now = await this.inspect(rec.file);
    if (now.sha256 !== rec.sha256) throw new AppImageError('Tampered', `${rec.name} was changed since it was imported; remove and import it again`);
    this.checkArch(now.elf.arch, now.elf.machine);
  }

  /** WSOS-AIM-002: the explicit "Allow this AppImage to run" step. */
  async approve(id: string): Promise<AppImageRecord> {
    const rec = this.get(id);
    await this.check(rec);
    chmodSync(rec.file, 0o700);
    const next = { ...rec, approved: true, approved_at: new Date(this.env.now()).toISOString() };
    this.save(next);
    return next;
  }

  async run(id: string, args: string[]): Promise<void> {
    const rec = this.get(id);
    if (!rec.approved) throw new AppImageError('NotApproved', `${rec.name} hasn’t been approved to run yet. Open App Center › Installed to review and allow it.`);
    await this.check(rec);
    this.env.exec(rec.file, args);
  }

  remove(id: string): { removed: string } {
    const rec = this.get(id);
    rmSync(rec.desktop_entry, { force: true });
    if (rec.icon) rmSync(rec.icon, { force: true });
    rmSync(join(this.root, id), { recursive: true, force: true });
    return { removed: rec.name };
  }

  /** WSOS-AIM-004: the only update adapter is "same signing key". Unsigned AppImages always need a manual update. */
  async update(id: string, candidate: string): Promise<AppImageRecord> {
    this.checkPolicy();
    const rec = this.get(id);
    const manual = (why: string) => new AppImageError('ManualUpdateRequired', `Manual update required: ${why}. Remove ${rec.name} and import the new version.`);
    if (rec.signature.status !== 'signed') throw manual('the installed version is not signed, so the new file can’t be authenticated');
    const info = await this.inspect(candidate);
    if (info.elf.arch !== rec.arch) throw manual(`the new file is not built for ${LABEL[rec.arch]}`);
    if (info.signature.status !== 'signed') throw manual(info.signature.status === 'invalid' ? `its signature is not valid (${info.signature.reason})` : 'the new file is not signed');
    if (info.signature.fingerprint !== rec.signature.fingerprint) throw manual('the new file is signed by a different key');
    if (info.sha256 === rec.sha256) return rec;
    const tmp = rec.file + '.new';
    copyFileSync(candidate, tmp);
    const copied = await this.inspect(tmp);
    if (copied.sha256 !== info.sha256) { rmSync(tmp, { force: true }); throw new AppImageError('Tampered', 'the file changed while it was being copied'); }
    chmodSync(tmp, rec.approved ? 0o700 : 0o600);
    renameSync(tmp, rec.file);
    const meta = await this.metadata(rec.file, copied.elf.payloadOffset);
    const next: AppImageRecord = { ...rec, sha256: info.sha256, size: info.size, version: meta.version ?? rec.version, signature: info.signature };
    this.writeDesktop(next);
    this.save(next);
    return next;
  }
}

/** [Desktop Entry] keys we use; localized keys and other groups are ignored. */
export function parseDesktop(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  let inEntry = false;
  for (const line of text.split('\n')) {
    const l = line.trim();
    if (l.startsWith('[')) { inEntry = l === '[Desktop Entry]'; continue; }
    const m = inEntry && /^([A-Za-z0-9-]+)\s*=\s*(.*)$/.exec(l);
    if (m && !(m[1] in out)) out[m[1]] = m[2];
  }
  return out;
}

/** Strip control characters and desktop-entry field codes from text we write into a .desktop file. */
function clean(s: string) { return s.replace(/[\x00-\x1f\x7f]/g, ' ').replace(/%/g, '').trim().slice(0, 100); }

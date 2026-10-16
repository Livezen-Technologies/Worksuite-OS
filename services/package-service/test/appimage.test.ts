import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { existsSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { AppImages, type AppImageEnv } from '../src/appimage.ts';
import type { RunResult } from '../src/service.ts';
import { gpgKey, has, makeAppImage, signAppImage, tmp } from './helpers.ts';

const run = (cmd: string, args: string[]) => new Promise<RunResult>((resolve) => execFile(cmd, args, (e, stdout, stderr) => resolve({ code: e ? 1 : 0, stdout, stderr })));
const tools = has('mksquashfs') && has('unsquashfs');
const withGpg = tools && has('gpg');

function world(over: Partial<AppImageEnv> = {}) {
  const home = tmp('ws-home-');
  const execs: string[] = [];
  const env: AppImageEnv = { home, arch: 'amd64', policy: () => null, runner: { run }, exec: (f, a) => { execs.push([f, ...a].join(' ')); }, now: () => Date.parse('2026-10-15T10:00:00Z'), launcher: '/usr/bin/worksuite-appimage', ...over };
  return { m: new AppImages(env), home, execs, env };
}

test('import records origin, SHA-256, version and desktop entry; stays non-executable; checksum only is not a publisher', { skip: !tools }, async () => {
  const w = world();
  const file = makeAppImage(tmp());
  const rec = await w.m.import(file, 'https://example.org/pinta');
  assert.equal(rec.name, 'Pinta');
  assert.equal(rec.version, '2.1');
  assert.equal(rec.origin, 'https://example.org/pinta');
  assert.match(rec.sha256, /^[0-9a-f]{64}$/);
  assert.equal(rec.arch, 'amd64');
  assert.deepEqual(rec.signature, { status: 'unsigned' });
  assert.equal(rec.approved, false);
  assert.ok(rec.file.startsWith(join(w.home, '.local/share/worksuite/appimages', rec.id)));
  assert.equal(statSync(rec.file).mode & 0o111, 0, 'not executable before approval');
  const desk = readFileSync(rec.desktop_entry, 'utf8');
  assert.match(desk, new RegExp(`^Exec=/usr/bin/worksuite-appimage run ${rec.id} %U$`, 'm'), 'desktop entry goes through the approval check');
  assert.match(desk, /checksum only, publisher not verified/);
  assert.match(desk, /^Categories=Graphics;$/m);
  assert.ok(rec.icon && existsSync(rec.icon) && rec.icon.endsWith('.png'));
  assert.ok(JSON.parse(readFileSync(join(w.home, '.local/share/worksuite/appimages', rec.id, 'metadata.json'), 'utf8')).sha256 === rec.sha256);
  assert.deepEqual(w.m.list().map((r) => r.id), [rec.id]);
});

test('first run needs approval; tampering after import is caught; remove cleans up', { skip: !tools }, async () => {
  const w = world();
  const rec = await w.m.import(makeAppImage(tmp()), '');
  await assert.rejects(w.m.run(rec.id, []), { code: 'NotApproved' });
  assert.equal(w.execs.length, 0);
  await w.m.approve(rec.id);
  assert.notEqual(statSync(rec.file).mode & 0o100, 0);
  await w.m.run(rec.id, ['/tmp/a.png']);
  assert.deepEqual(w.execs, [`${rec.file} /tmp/a.png`]);
  const b = readFileSync(rec.file); b[b.length - 1] ^= 1; writeFileSync(rec.file, b);
  await assert.rejects(w.m.run(rec.id, []), { code: 'Tampered' });
  assert.equal(w.execs.length, 1);
  w.m.remove(rec.id);
  assert.ok(!existsSync(rec.file) && !existsSync(rec.desktop_entry) && !existsSync(rec.icon!));
});

test('policy may forbid AppImages; arch is checked before import and before every run (WSOS-ARM-005)', { skip: !tools }, async () => {
  let policy: { appimages?: 'allow' | 'block' } | null = { appimages: 'block' };
  const w = world({ policy: () => policy });
  await assert.rejects(w.m.import(makeAppImage(tmp()), ''), { code: 'PolicyBlocked' });
  policy = null;
  await assert.rejects(w.m.import(makeAppImage(tmp(), { machine: 183 }), ''), (e: Error & { code: string }) => e.code === 'ArchMismatch' && /ARM64.*x86-64/.test(e.message));
  const arm = world({ arch: 'arm64' });
  await assert.rejects(arm.m.import(makeAppImage(tmp()), ''), (e: Error & { code: string }) => e.code === 'ArchMismatch' && /x86-64; this device is ARM64/.test(e.message));
  const rec = await w.m.import(makeAppImage(tmp()), '');
  await w.m.approve(rec.id);
  policy = { appimages: 'block' };
  await assert.rejects(w.m.run(rec.id, []), { code: 'PolicyBlocked' }, 'a later policy stops approved AppImages too');
});

test('not an AppImage: plain files and ELF without the AppImage magic are refused', async () => {
  const w = world();
  const d = tmp();
  writeFileSync(join(d, 'x.AppImage'), 'hello');
  await assert.rejects(w.m.import(join(d, 'x.AppImage'), ''), { code: 'NotAppImage' });
  const f = makeAppImage(d, { squash: false, name: 'NoMagic' });
  const b = readFileSync(f); b[8] = 0; writeFileSync(f, b);
  await assert.rejects(w.m.import(f, ''), { code: 'NotAppImage' });
});

test('embedded signatures are verified with gpg; a changed file fails; updates need the same key (WSOS-AIM-003/004)', { skip: !withGpg, timeout: 120_000 }, async () => {
  const alice = gpgKey('Alice Publisher <alice@example.org>');
  const mallory = gpgKey('Mallory <m@example.org>');
  const w = world({ policy: () => ({ appimage_trusted_keys: [alice.fingerprint] }) });
  const v1 = makeAppImage(tmp(), { version: '2.1' });
  signAppImage(v1, alice.home);
  const rec = await w.m.import(v1, '');
  assert.deepEqual(rec.signature, { status: 'signed', fingerprint: alice.fingerprint, trusted: true });
  assert.doesNotMatch(readFileSync(rec.desktop_entry, 'utf8'), /checksum only/);

  // Bit flip in the payload after signing: signature check fails, import refused.
  const bad = makeAppImage(tmp(), { version: '2.1' });
  signAppImage(bad, alice.home);
  const b = readFileSync(bad); b[b.length - 3] ^= 0xff; writeFileSync(bad, b);
  await assert.rejects(w.m.import(bad, ''), { code: 'SignatureInvalid' });

  await w.m.approve(rec.id);
  const foreign = makeAppImage(tmp(), { version: '2.2' });
  signAppImage(foreign, mallory.home);
  await assert.rejects(w.m.update(rec.id, foreign), (e: Error & { code: string }) => e.code === 'ManualUpdateRequired' && /different key/.test(e.message));
  const unsigned = makeAppImage(tmp(), { version: '2.2' });
  await assert.rejects(w.m.update(rec.id, unsigned), { code: 'ManualUpdateRequired' });
  const v2 = makeAppImage(tmp(), { version: '2.2' });
  signAppImage(v2, alice.home);
  const up = await w.m.update(rec.id, v2);
  assert.equal(up.version, '2.2');
  assert.equal(up.approved, true);
  assert.notEqual(up.sha256, rec.sha256);
  await w.m.run(rec.id, []);
  assert.equal(w.execs.length, 1, 'updated file passes the run-time hash check');
});

test('unsigned installs always need a manual update', { skip: !tools }, async () => {
  const w = world();
  const rec = await w.m.import(makeAppImage(tmp()), '');
  await assert.rejects(w.m.update(rec.id, makeAppImage(tmp(), { version: '3.0' })), (e: Error & { code: string }) => e.code === 'ManualUpdateRequired' && /not signed/.test(e.message));
});

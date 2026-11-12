// tools/release/make-wsupdate.mjs (the release side) against bundle.ts (the device side): what the tool builds is
// exactly what a device accepts, and nothing the device would refuse slips through the tool.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync, type KeyObject } from 'node:crypto';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { extractBundle, inspectBundle } from '../src/bundle.ts';
import { tmp } from './helpers.ts';
// @ts-expect-error plain JavaScript tool without types
import { makeBundle, parseArgs } from '../../../tools/release/make-wsupdate.mjs';

function setup() {
  const dir = tmp('ws-mkupd-');
  const { publicKey, privateKey } = generateKeyPairSync('ed25519');
  const key = join(dir, 'release.pem');
  writeFileSync(key, privateKey.export({ type: 'pkcs8', format: 'pem' }));
  const debs = ['worksuite-desktop_1.0.1_all.deb', 'worksuite-shell_1.0.1_amd64.deb'].map((n, i) => { const p = join(dir, n); writeFileSync(p, `package ${i}`); return p; });
  const keys = (id: string): KeyObject | undefined => (id === 'ws-release-1' ? publicKey : undefined);
  return { dir, key, debs, keys };
}

test('make-wsupdate: a device accepts the bundle and installs exactly the signed packages', () => {
  const s = setup();
  const out = join(s.dir, 'u.wsupdate');
  const r = makeBundle(parseArgs(['--key', s.key, '--key-id', 'ws-release-1', '--version', '1.0.1', '--min-version', '1.0.0', '--out', out, ...s.debs]));
  assert.equal(r.manifest.download_bytes, 18);
  const { manifest, entries } = inspectBundle(out, { keys: s.keys, arch: 'amd64', installed: '1.0.0' });
  assert.equal(manifest.version, '1.0.1');
  assert.deepEqual(entries.map((e) => e.name).sort(), ['pool/worksuite-desktop_1.0.1_all.deb', 'pool/worksuite-shell_1.0.1_amd64.deb']);
  const { debs } = extractBundle(out, join(s.dir, 'x'), { keys: s.keys, arch: 'amd64', installed: '1.0.0' });
  assert.equal(debs.length, 2);
  // Debian ~ ordering: an rc2 bundle updates an rc1 device.
  const rc = join(s.dir, 'rc.wsupdate');
  makeBundle(parseArgs(['--key', s.key, '--key-id', 'ws-release-1', '--version', '1.0.0~rc2', '--min-version', '1.0.0~rc1', '--out', rc, ...s.debs]));
  assert.equal(inspectBundle(rc, { keys: s.keys, arch: 'amd64', installed: '1.0.0~rc1' }).manifest.version, '1.0.0~rc2');
});

test('make-wsupdate: a key the device does not ship, the wrong arch or an older version is refused on the device', () => {
  const s = setup();
  const out = join(s.dir, 'u.wsupdate');
  makeBundle(parseArgs(['--key', s.key, '--key-id', 'ws-other', '--version', '1.0.1', '--min-version', '1.0.0', '--out', out, ...s.debs]));
  assert.throws(() => inspectBundle(out, { keys: s.keys, arch: 'amd64', installed: '1.0.0' }), { code: 'SignatureInvalid' });
  makeBundle(parseArgs(['--key', s.key, '--key-id', 'ws-release-1', '--arch', 'arm64', '--version', '1.0.1', '--min-version', '1.0.0', '--out', out, ...s.debs]));
  assert.throws(() => inspectBundle(out, { keys: s.keys, arch: 'amd64', installed: '1.0.0' }), { code: 'ArchMismatch' });
  makeBundle(parseArgs(['--key', s.key, '--key-id', 'ws-release-1', '--version', '1.0.1', '--min-version', '1.0.0', '--out', out, ...s.debs]));
  assert.throws(() => inspectBundle(out, { keys: s.keys, arch: 'amd64', installed: '1.0.2' }), /downgrade/);
});

test('make-wsupdate: refuses bad input before writing anything', () => {
  const s = setup();
  const base = ['--key', s.key, '--key-id', 'ws-release-1', '--min-version', '1.0.0', '--out', join(s.dir, 'o.wsupdate')];
  assert.throws(() => parseArgs([...base, '--version', '1.0.1']), /no \.deb/);
  assert.throws(() => parseArgs([...base, '--version', '1.0.1; rm', ...s.debs]), /versions/);
  const odd = join(s.dir, 'Evil Name.deb'); writeFileSync(odd, 'x');
  assert.throws(() => makeBundle(parseArgs([...base, '--version', '1.0.1', odd])), /lower-case/);
  assert.throws(() => makeBundle(parseArgs([...base, '--version', '1.0.1', s.debs[0], s.debs[0]])), /twice/);
  const rsa = join(s.dir, 'rsa.pem');
  writeFileSync(rsa, generateKeyPairSync('rsa', { modulusLength: 1024 }).privateKey.export({ type: 'pkcs8', format: 'pem' }));
  assert.throws(() => makeBundle(parseArgs([...base, '--version', '1.0.1', '--key', rsa, ...s.debs])), /Ed25519/);
});

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildSbom, parseArgs, parseNpmLock, parsePackageList } from './spdx.mjs';

test('package lists from live-build and dpkg-query parse with arch', () => {
  const p = parsePackageList('libc6:amd64\t2.41-12\nbase-files 13.8\n\n# junk\nlibgtk-3-0t64:arm64 3.24.49-3\n', 'amd64');
  assert.deepEqual(p.map((x) => `${x.name} ${x.version} ${x.arch}`), ['libc6 2.41-12 amd64', 'base-files 13.8 amd64', 'libgtk-3-0t64 3.24.49-3 arm64']);
});

test('npm lockfile: runtime packages only, scoped names kept', () => {
  const lock = JSON.stringify({ packages: { '': { name: 'x', version: '1.0.0' }, 'node_modules/react': { version: '19.3.1', license: 'MIT' },
    'node_modules/@types/node': { version: '22.0.0', dev: true }, 'node_modules/a/node_modules/@scope/b': { version: '2.0.0' } } });
  const n = parseNpmLock(lock);
  assert.deepEqual(n.map((x) => `${x.name}@${x.version}${x.dev ? ' dev' : ''}`), ['react@19.3.1', '@types/node@22.0.0 dev', '@scope/b@2.0.0']);
});

test('SPDX 2.3 document: purls, DESCRIBES relationships, no dev deps, unique ids', () => {
  const doc = buildSbom({
    name: 'worksuite-os-1.0.0-amd64', arch: 'amd64', created: '2026-10-15T00:00:00Z', namespaceId: 'fixed',
    debian: parsePackageList('libc6\t2.41-12\nlibc6\t2.41-12\n', 'amd64'),
    worksuite: [{ name: 'worksuite-shell', version: '1.0.0', arch: 'amd64', ns: 'worksuite', sha256: 'ab'.repeat(32) }],
    npm: parseNpmLock(JSON.stringify({ packages: { 'node_modules/@scope/b': { version: '2.0.0', license: 'MIT' }, 'node_modules/vite': { version: '8.0.0', dev: true } } })),
  });
  assert.equal(doc.spdxVersion, 'SPDX-2.3');
  assert.equal(doc.dataLicense, 'CC0-1.0');
  assert.equal(doc.packages.length, 3);
  const purls = doc.packages.map((p) => p.externalRefs[0].referenceLocator);
  assert.deepEqual(purls, ['pkg:deb/worksuite/worksuite-shell@1.0.0?arch=amd64', 'pkg:deb/debian/libc6@2.41-12?arch=amd64&distro=debian-13', 'pkg:npm/%40scope/b@2.0.0']);
  assert.equal(new Set(doc.packages.map((p) => p.SPDXID)).size, 3);
  for (const p of doc.packages) assert.match(p.SPDXID, /^SPDXRef-[A-Za-z0-9.-]+$/);
  assert.equal(doc.relationships.length, 3);
  assert.equal(doc.packages[0].checksums[0].algorithm, 'SHA256');
});

test('argument parsing', () => {
  const o = parseArgs(['--name', 'n', '--arch', 'arm64', '--deb', 'a.deb', 'b.deb', '--npm', 'l.json', '--packages', 'p']);
  assert.deepEqual([o.name, o.arch, o.deb, o.npm, o.packages], ['n', 'arm64', ['a.deb', 'b.deb'], ['l.json'], ['p']]);
  assert.throws(() => parseArgs(['--bogus']));
});

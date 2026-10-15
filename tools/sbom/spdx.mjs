#!/usr/bin/env node
// SPDX 2.3 JSON SBOM for a WorkSuite OS release (WSOS-SEC-011). Dependency-free; runs on Node >= 18.
//   node tools/sbom/spdx.mjs --name worksuite-os-1.0.0-amd64 --arch amd64 \
//     --packages live-build/out/worksuite-os-1.0.0-dev-amd64.packages \   # image package list ("name\tversion" per line, from lb)
//     --deb packaging/out/*.deb \                                          # WorkSuite .debs (control fields via dpkg-deb)
//     --npm shell/package-lock.json --npm services/package-service/package-lock.json \
//     > worksuite-os-amd64.spdx.json
// Every package gets a purl (pkg:deb/debian/…, pkg:deb/worksuite/…, pkg:npm/…) so scanners can match CVEs.
import { execFileSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { basename } from 'node:path';

export function parseArgs(argv) {
  const o = { name: 'worksuite-os', arch: 'amd64', packages: [], deb: [], npm: [], created: undefined };
  for (let i = 0; i < argv.length; i++) {
    const k = argv[i];
    const v = () => { const x = argv[++i]; if (x === undefined) throw new Error(`${k} needs a value`); return x; };
    if (k === '--name') o.name = v();
    else if (k === '--arch') o.arch = v();
    else if (k === '--packages') o.packages.push(v());
    else if (k === '--deb') { while (argv[i + 1] && !argv[i + 1].startsWith('--')) o.deb.push(argv[++i]); }
    else if (k === '--npm') o.npm.push(v());
    else if (k === '--created') o.created = v();
    else throw new Error(`unknown argument ${k}`);
  }
  return o;
}

/** lb's *.packages / `dpkg-query -W` output: "name[:arch]<TAB or space>version". */
export function parsePackageList(text, arch) {
  const out = [];
  for (const line of text.split('\n')) {
    const m = /^([a-z0-9][a-z0-9+.-]*)(?::([a-z0-9-]+))?\s+(\S+)/.exec(line.trim());
    if (m) out.push({ name: m[1], version: m[3], arch: m[2] ?? arch, ns: 'debian' });
  }
  return out;
}

export function parseNpmLock(text) {
  const lock = JSON.parse(text);
  const out = [];
  for (const [path, p] of Object.entries(lock.packages ?? {})) {
    if (!path || !p.version || p.link) continue;
    const name = p.name ?? path.slice(path.lastIndexOf('node_modules/') + 'node_modules/'.length);
    out.push({ name, version: p.version, dev: !!p.dev, integrity: p.integrity, license: p.license });
  }
  return out;
}

const spdxId = (s) => 'SPDXRef-' + s.replace(/[^A-Za-z0-9.-]/g, '-');
const purlDeb = (p) => `pkg:deb/${p.ns}/${encodeURIComponent(p.name)}@${encodeURIComponent(p.version)}?arch=${p.arch}${p.ns === 'debian' ? '&distro=debian-13' : ''}`;
const purlNpm = (p) => `pkg:npm/${p.name.startsWith('@') ? '%40' + p.name.slice(1) : p.name}@${encodeURIComponent(p.version)}`;
const lic = (l) => (typeof l === 'string' && /^[A-Za-z0-9.+ ()-]+$/.test(l) ? l : 'NOASSERTION');

export function buildSbom({ name, arch, debian = [], worksuite = [], npm = [], created = new Date().toISOString(), namespaceId = randomUUID() }) {
  const packages = [];
  const rels = [];
  const seen = new Set();
  const add = (id, pkg) => {
    if (seen.has(id)) return;
    seen.add(id);
    packages.push({ SPDXID: id, downloadLocation: 'NOASSERTION', filesAnalyzed: false, copyrightText: 'NOASSERTION', ...pkg });
    rels.push({ spdxElementId: 'SPDXRef-DOCUMENT', relationshipType: 'DESCRIBES', relatedSpdxElement: id });
  };
  for (const p of [...worksuite, ...debian]) {
    add(spdxId(`deb-${p.ns}-${p.name}-${p.version}-${p.arch}`), {
      name: p.name, versionInfo: p.version, supplier: p.ns === 'worksuite' ? 'Organization: WorkSuite' : 'Organization: Debian',
      licenseConcluded: 'NOASSERTION', licenseDeclared: 'NOASSERTION',
      ...(p.sha256 ? { checksums: [{ algorithm: 'SHA256', checksumValue: p.sha256 }] } : {}),
      externalRefs: [{ referenceCategory: 'PACKAGE-MANAGER', referenceType: 'purl', referenceLocator: purlDeb(p) }],
    });
  }
  // Electron is a devDependency of the shell build but ships inside worksuite-shell.
  for (const p of npm.filter((x) => !x.dev || x.name === 'electron')) {
    add(spdxId(`npm-${p.name}-${p.version}`), {
      name: p.name, versionInfo: p.version, supplier: 'NOASSERTION', licenseConcluded: 'NOASSERTION', licenseDeclared: lic(p.license),
      externalRefs: [{ referenceCategory: 'PACKAGE-MANAGER', referenceType: 'purl', referenceLocator: purlNpm(p) }],
    });
  }
  return {
    spdxVersion: 'SPDX-2.3', dataLicense: 'CC0-1.0', SPDXID: 'SPDXRef-DOCUMENT', name,
    documentNamespace: `https://download.worksuitecloud.com/os/sbom/${encodeURIComponent(name)}-${namespaceId}`,
    creationInfo: { created, creators: ['Tool: worksuite-spdx.mjs', 'Organization: WorkSuite'] },
    packages, relationships: rels,
  };
}

function debInfo(path) {
  const f = (field) => execFileSync('dpkg-deb', ['-f', path, field], { encoding: 'utf8' }).trim();
  return { name: f('Package'), version: f('Version'), arch: f('Architecture'), ns: 'worksuite', sha256: createHash('sha256').update(readFileSync(path)).digest('hex') };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const o = parseArgs(process.argv.slice(2));
  const debian = o.packages.flatMap((p) => parsePackageList(readFileSync(p, 'utf8'), o.arch));
  const worksuite = o.deb.filter((d) => !basename(d).includes('-dbgsym_')).map(debInfo);
  const ws = new Set(worksuite.map((p) => p.name));
  const npm = o.npm.flatMap((p) => parseNpmLock(readFileSync(p, 'utf8')));
  process.stdout.write(JSON.stringify(buildSbom({ name: o.name, arch: o.arch, debian: debian.filter((p) => !ws.has(p.name)), worksuite, npm, created: o.created }), null, 2) + '\n');
}

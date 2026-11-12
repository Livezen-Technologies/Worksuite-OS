#!/usr/bin/env node
// Build an offline update bundle (.wsupdate, WSOS-AUP-010) for "Update from a USB drive" (Settings › Updates).
// No dependencies; Node 20+ and the system tar.
//
//   node tools/release/make-wsupdate.mjs --key release.key.pem --key-id ws-release-1 \
//     --version 1.0.1 --min-version 1.0.0 [--ring stable] [--arch amd64] [--release-id rel-1.0.1] \
//     [--critical] [--security] [--notes "text"] --out worksuite-os-1.0.1-amd64.wsupdate  pool/*.deb
//
// The bundle is a plain ustar archive: manifest.json (the release manifest signed with the Ed25519 release key, in the
// same canonical form the device verifies) and pool/<name>.deb. The signature covers every package's name, size and
// SHA-256, so the device installs only what the release key approved, whatever happens to the USB drive in between.
// The key id must match a public key the device ships in /usr/share/worksuite/keys/release/<key-id>.pem.
// Copy the file to the top level of a USB drive; the Updates page finds it there.
import { execFileSync } from 'node:child_process';
import { createHash, createPrivateKey, createPublicKey, sign, verify } from 'node:crypto';
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join, resolve } from 'node:path';

// Same canonical JSON as services/package-service/src/updates.ts (sorted keys, undefined dropped).
export function canonical(v) {
  if (v === null || typeof v !== 'object') return JSON.stringify(v);
  if (Array.isArray(v)) return `[${v.map(canonical).join(',')}]`;
  return `{${Object.keys(v).sort().filter((k) => v[k] !== undefined).map((k) => `${JSON.stringify(k)}:${canonical(v[k])}`).join(',')}}`;
}

const POOL = /^[a-z0-9][a-z0-9+.~_-]{0,200}\.deb$/;
const VERSION = /^[0-9][A-Za-z0-9.+~-]{0,63}$/;

export function parseArgs(argv) {
  const o = { ring: 'stable', arch: 'amd64', debs: [], critical: false, security: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i], v = () => { const x = argv[++i]; if (x === undefined) throw new Error(`${a} needs a value`); return x; };
    if (a === '--key') o.key = v();
    else if (a === '--key-id') o.keyId = v();
    else if (a === '--version') o.version = v();
    else if (a === '--min-version') o.minVersion = v();
    else if (a === '--ring') o.ring = v();
    else if (a === '--arch') o.arch = v();
    else if (a === '--release-id') o.releaseId = v();
    else if (a === '--notes') o.notes = v();
    else if (a === '--critical') o.critical = true;
    else if (a === '--security') o.security = true;
    else if (a === '--out') o.out = v();
    else if (a.startsWith('--')) throw new Error(`unknown option ${a}`);
    else o.debs.push(a);
  }
  for (const k of ['key', 'keyId', 'version', 'minVersion', 'out']) if (!o[k]) throw new Error(`--${k.replace(/[A-Z]/g, (c) => `-${c.toLowerCase()}`)} is required`);
  if (!VERSION.test(o.version) || !VERSION.test(o.minVersion)) throw new Error('versions look like 1.0.1 or 1.0.0~rc2');
  if (!['development', 'pilot', 'stable'].includes(o.ring)) throw new Error('--ring is development, pilot or stable');
  if (!['amd64', 'arm64'].includes(o.arch)) throw new Error('--arch is amd64 or arm64');
  if (!/^[A-Za-z0-9._-]{1,64}$/.test(o.keyId)) throw new Error('bad --key-id');
  if (!o.debs.length) throw new Error('no .deb files given');
  o.releaseId ??= `rel-${o.version}`;
  return o;
}

const sha256 = (p) => createHash('sha256').update(readFileSync(p)).digest('hex');

/** The signed manifest for these packages (pure apart from reading the files). */
export function buildManifest(o, privateKey) {
  const names = new Set();
  const files = o.debs.map((p) => {
    const name = basename(p);
    if (!POOL.test(name)) throw new Error(`${name}: package file names are lower-case name_version_arch.deb`);
    if (names.has(name)) throw new Error(`${name} is given twice`);
    names.add(name);
    return { name, sha256: sha256(p), size: statSync(p).size };
  });
  const body = {
    release_id: o.releaseId, version: o.version, min_version: o.minVersion, ring: o.ring, arch: o.arch,
    critical: o.critical || undefined, security: o.security || undefined, notes: o.notes,
    download_bytes: files.reduce((n, f) => n + f.size, 0), bundle: { files },
  };
  const signature = `${o.keyId}:${sign(null, Buffer.from(canonical(body)), privateKey).toString('base64')}`;
  // Check our own signature with the public half before anything is written.
  if (!verify(null, Buffer.from(canonical(body)), createPublicKey(privateKey), Buffer.from(signature.split(':')[1], 'base64'))) throw new Error('signature check failed');
  return { ...JSON.parse(JSON.stringify(body)), signature };
}

export function makeBundle(o) {
  const key = createPrivateKey(readFileSync(o.key));
  if (key.asymmetricKeyType !== 'ed25519') throw new Error('the release key must be Ed25519');
  const manifest = buildManifest(o, key);
  const work = mkdtempSync(join(tmpdir(), 'wsupdate-'));
  try {
    mkdirSync(join(work, 'pool'));
    for (const p of o.debs) copyFileSync(p, join(work, 'pool', basename(p)));
    writeFileSync(join(work, 'manifest.json'), JSON.stringify(manifest));
    const out = resolve(o.out);
    // Plain files only, no owners: the device refuses links, devices and anything not in the manifest.
    execFileSync('tar', ['--format=ustar', '--owner=0', '--group=0', '--numeric-owner', '--mode=a+r,u+w,go-w', '-cf', out, '-C', work, 'manifest.json', 'pool'], { stdio: ['ignore', 'ignore', 'inherit'] });
    return { out, manifest };
  } finally { rmSync(work, { recursive: true, force: true }); }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  try {
    const { out, manifest } = makeBundle(parseArgs(process.argv.slice(2)));
    console.log(`${out}: WorkSuite OS ${manifest.version} (${manifest.arch}), ${manifest.bundle.files.length} packages, ${manifest.download_bytes} bytes, signed by ${manifest.signature.split(':')[0]}`);
  } catch (e) { console.error(`make-wsupdate: ${e.message}`); process.exit(1); }
}

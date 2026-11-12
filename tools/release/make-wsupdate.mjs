#!/usr/bin/env node
// Build an offline update bundle (.wsupdate, WSOS-AUP-010) for "Update from a USB drive" (Settings › Updates).
// No dependencies; Node 20+ and the system tar.
//
//   node tools/release/make-wsupdate.mjs --key release.key.pem --key-id ws-release-1 \
//     --version 1.0.1 --min-version 1.0.0 [--ring stable] [--arch amd64] [--release-id rel-1.0.1] \
//     [--critical] [--security] [--notes "text"] [--baseline installed.txt] --out worksuite-os-1.0.1-amd64.wsupdate  pool/*.deb
//
// --baseline: the packages of the oldest release this bundle must update, as `dpkg-query -W -f='${Package} ${Version}\n'`
// prints them on such a system. Every Depends/Pre-Depends of every package must then be met by the bundle itself or by
// that list, or nothing is written: an offline update cannot download what it lacks (power-profiles-daemon, added to
// worksuite-desktop in 1.0.0~rc2, made an rc3 bundle uninstallable on rc1 systems). Add the missing .deb files.
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
    else if (a === '--baseline') o.baseline = v();
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

const control = (deb) => {
  const f = {};
  for (const k of ['Package', 'Version', 'Architecture', 'Depends', 'Pre-Depends']) {
    try { f[k] = execFileSync('dpkg-deb', ['-f', deb, k], { encoding: 'utf8' }).trim(); } catch { f[k] = ''; }
  }
  return f;
};
const versionOk = (have, op, want) => {
  if (!op) return true;
  const deb = { '<<': 'lt', '<=': 'le', '=': 'eq', '>=': 'ge', '>>': 'gt' }[op];
  try { execFileSync('dpkg', ['--compare-versions', have, deb, want]); return true; } catch { return false; }
};

/** Dependencies of the bundle's packages that neither the bundle nor the baseline (Map name → version) satisfies. */
export function unmetDependencies(debs, baseline) {
  const pkgs = debs.map(control);
  const have = new Map(baseline);
  for (const p of pkgs) have.set(p.Package, p.Version);   // the bundle wins over the baseline
  const unmet = [];
  for (const p of pkgs) {
    for (const clause of [p['Pre-Depends'], p.Depends].filter(Boolean).join(',').split(',').map((x) => x.trim()).filter(Boolean)) {
      const ok = clause.split('|').some((alt) => {
        const m = /^([a-z0-9][a-z0-9+.-]*)(?::[a-z0-9-]+)?\s*(?:\((<<|<=|=|>=|>>)\s*([^)\s]+)\))?/.exec(alt.trim());
        if (!m) return false;
        const v = have.get(m[1]);
        return v !== undefined && versionOk(v, m[2], m[3]);
      });
      if (!ok) unmet.push(`${p.Package}: ${clause}`);
    }
  }
  return [...new Set(unmet)];
}

export function readBaseline(path) {
  const m = new Map();
  for (const line of readFileSync(path, 'utf8').split('\n')) {
    const [name, version] = line.trim().split(/\s+/);
    if (name && version) m.set(name.replace(/:[a-z0-9-]+$/, ''), version);
  }
  return m;
}

export function makeBundle(o) {
  if (o.baseline) {
    const unmet = unmetDependencies(o.debs, readBaseline(o.baseline));
    if (unmet.length) throw new Error(`these dependencies are neither in the bundle nor on ${o.baseline}; add their .deb files:\n  ${unmet.join('\n  ')}`);
  }
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

// Offline bundle checks for the updater on the live USB (worksuite-offline-update, "Update WorkSuite OS" in the boot
// menu): the same verification as Settings › Updates (bundle.ts), against the release keys and version of the
// installed system being updated, not the live system's.
//
//   node bundle-cli.ts inspect --keys DIR --arch amd64|arm64 --installed VERSION FILE
//   node bundle-cli.ts extract --keys DIR --arch amd64|arm64 --installed VERSION FILE DEST
//
// Prints one JSON object: inspect → {version, release_id, packages, bytes, critical}; extract → {version, debs: [...]}.
// On a refused bundle: {error, code} on stdout and exit status 1. Usage errors exit 2.
import { createPublicKey, type KeyObject } from 'node:crypto';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { extractBundle, inspectBundle } from './bundle.ts';

export function loadKeys(dir: string): (id: string) => KeyObject | undefined {
  const m = new Map<string, KeyObject>();
  if (existsSync(dir)) for (const f of readdirSync(dir)) if (f.endsWith('.pem')) m.set(f.slice(0, -4), createPublicKey(readFileSync(join(dir, f))));
  return (id) => m.get(id);
}

export function run(argv: string[]): { code: number; out: unknown } {
  const [cmd, ...rest] = argv;
  const opt: Record<string, string> = {};
  const pos: string[] = [];
  for (let i = 0; i < rest.length; i++) {
    if (rest[i].startsWith('--')) opt[rest[i].slice(2)] = rest[++i] ?? '';
    else pos.push(rest[i]);
  }
  const usage = { code: 2, out: { error: 'usage: bundle-cli.ts inspect|extract --keys DIR --arch ARCH --installed VERSION FILE [DEST]' } };
  if (!['inspect', 'extract'].includes(cmd) || !opt.keys || !opt.arch || !opt.installed || !pos[0] || (cmd === 'extract' && !pos[1])) return usage;
  const o = { keys: loadKeys(opt.keys), arch: opt.arch, installed: opt.installed };
  try {
    if (cmd === 'inspect') {
      const { manifest } = inspectBundle(pos[0], o);
      return { code: 0, out: { version: manifest.version, release_id: manifest.release_id, packages: manifest.bundle.files.length,
        bytes: manifest.bundle.files.reduce((n, f) => n + f.size, 0), critical: !!manifest.critical } };
    }
    const { manifest, debs } = extractBundle(pos[0], pos[1], o);
    return { code: 0, out: { version: manifest.version, debs } };
  } catch (e) {
    return { code: 1, out: { error: (e as Error).message, code: (e as { code?: string }).code ?? 'Failed' } };
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const r = run(process.argv.slice(2));
  process.stdout.write(JSON.stringify(r.out) + '\n');
  process.exit(r.code);
}

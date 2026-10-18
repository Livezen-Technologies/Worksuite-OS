// The ring mapping lives in tools/release/rings.mjs. Every other list of ring names or suites in the repository must
// say the same thing, so a ring cannot be renamed or added in one place only.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { CI_RINGS, RING_NAMES, RINGS, canonicalRing, ciRing, suiteFor } from './rings.mjs';

const root = join(import.meta.dirname, '../..');
const read = (p) => readFileSync(join(root, p), 'utf8');
const RING_LIST = "'development', 'pilot', 'stable'";

test('canonical names, aliases and suites', () => {
  assert.deepEqual(RING_NAMES, ['development', 'pilot', 'stable']);
  assert.equal(canonicalRing('canary'), 'development');
  assert.equal(canonicalRing('DEV'), 'development');
  assert.equal(canonicalRing('beta'), 'pilot');
  assert.equal(canonicalRing('Stable'), 'stable');
  assert.throws(() => canonicalRing('nightly'), /unknown ring/);
  assert.equal(suiteFor('beta'), 'trixie-pilot');
  assert.deepEqual(CI_RINGS, ['development', 'pilot']);
  assert.throws(() => ciRing('stable'), /promote to stable/);
});

test('the CLI the image workflow calls', () => {
  const cli = (...a) => execFileSync(process.execPath, [join(import.meta.dirname, 'rings.mjs'), ...a], { encoding: 'utf8' }).trim();
  assert.equal(cli('ci-suite', 'canary'), 'trixie-dev');
  assert.equal(cli('ci-suite', 'pilot'), 'trixie-pilot');
  assert.throws(() => cli('ci-suite', 'stable'));
  assert.match(read('.github/workflows/image.yml'), /suite=\$\(node tools\/release\/rings\.mjs ci-suite "\$RING"\)/);
});

test('every other ring list matches rings.mjs', () => {
  // Server (manifests, promotion, policy validation) and device agent policy type.
  assert.ok(read('services/server/src/admin.ts').includes(`const RINGS = [${RING_LIST}] as const;`));
  assert.ok(read('services/server/src/api.ts').includes(`const RINGS = new Set([${RING_LIST}]);`));
  assert.ok(read('services/server/src/policy.ts').includes("update_ring: (v) => v === 'development' || v === 'pilot' || v === 'stable',"));
  assert.ok(read('services/device-agent/src/state.ts').includes("update_ring?: 'development' | 'pilot' | 'stable';"));
  // Package service: ring type, ring → suite map, allowed suites.
  const updates = read('services/package-service/src/updates.ts');
  assert.ok(updates.includes("export type Ring = 'development' | 'pilot' | 'stable';"));
  const coord = read('services/package-service/src/coordinator.ts');
  const suites = Object.fromEntries(RING_NAMES.map((r) => [r, RINGS[r].suite]));
  assert.ok(coord.includes(`const SUITE: Record<Ring, string> = { ${RING_NAMES.map((r) => `${r}: '${suites[r]}'`).join(', ')} };`), 'coordinator SUITE');
  assert.ok(coord.includes(`const RINGS: Ring[] = [${RING_LIST}];`));
  for (const s of Object.values(suites)) assert.match(read('services/package-service/src/apt.ts'), new RegExp(`OK_SUITES = .*[|(]${s.replace('trixie', '')}[|)]`));
  assert.match(read('tools/repo/publish.sh'), new RegExp(`case "\\$suite" in ${Object.values(suites).join('\\|')}\\)`));
  // API contract and the shell.
  assert.ok(read('api-contracts/openapi.yaml').includes(`Ring: { type: string, enum: [${RING_NAMES.join(', ')}] }`));
  assert.ok(read('shell/src/lib/os.ts').includes("ring?: 'development' | 'pilot' | 'stable'"));
  for (const f of ['shell/src/screens/Updates.tsx', 'shell/src/screens/UpdatesOffline.tsx'])
    assert.ok(read(f).includes("messages({ development: 'upd.ring.development', pilot: 'upd.ring.pilot', stable: 'upd.ring.stable' })"), f);
  // The console's ring picker.
  assert.ok(read('services/server/src/console-ui.ts').includes("sel('update_ring', [['stable', 'Stable'], ['pilot', 'Pilot'], ['development', 'Development']])"));
  // The documentation table.
  const doc = read('docs/release-channels.md');
  for (const r of RING_NAMES) assert.match(doc, new RegExp(`\\| \`${r}\` \\| ${RINGS[r].aliases.map((a) => `\`${a}\``).join(', ') || '—'} \\| ${RINGS[r].updateCenterChannel} \\| \`${RINGS[r].suite}\` \\|`), `docs row ${r}`);
});

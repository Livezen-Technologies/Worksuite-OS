#!/usr/bin/env node
// WorkSuite OS release rings: the one mapping between the OS's ring names, the APT suites and the Update Center's
// channel names (docs/release-channels.md). Devices, policies, manifests and the server use the canonical ring names
// only; the Update Center also accepts the aliases (canary, dev, beta) and shows its channels as DEV / BETA / STABLE.
// tools/release/rings.test.mjs checks that every other list of ring names in the repository matches this file.
//
//   node tools/release/rings.mjs canonical <ring|alias>   → development | pilot | stable
//   node tools/release/rings.mjs suite <ring|alias>       → trixie-dev | trixie-pilot | trixie-stable
//   node tools/release/rings.mjs ci-suite <ring|alias>    → as suite, but only rings CI may publish to
// No dependencies (runs on Debian trixie's nodejs in the image workflow).

export const RINGS = Object.freeze({
  development: Object.freeze({ suite: 'trixie-dev', updateCenterChannel: 'DEV', aliases: Object.freeze(['canary', 'dev']) }),
  pilot: Object.freeze({ suite: 'trixie-pilot', updateCenterChannel: 'BETA', aliases: Object.freeze(['beta']) }),
  stable: Object.freeze({ suite: 'trixie-stable', updateCenterChannel: 'STABLE', aliases: Object.freeze([]) }),
});

/** Promotion order: development → pilot → stable. */
export const RING_NAMES = Object.freeze(Object.keys(RINGS));
/** CI publishes to these only; stable is reached by promotion in the Update Center. */
export const CI_RINGS = Object.freeze(['development', 'pilot']);

/** A ring name or alias (any case) → the canonical ring name; throws on anything else. */
export function canonicalRing(name) {
  const n = String(name ?? '').trim().toLowerCase();
  for (const [ring, r] of Object.entries(RINGS)) if (n === ring || r.aliases.includes(n)) return ring;
  throw new Error(`unknown ring "${name}": use ${RING_NAMES.map((r) => [r, ...RINGS[r].aliases].join('/')).join(', ')}`);
}

export function ciRing(name) {
  const ring = canonicalRing(name);
  if (!CI_RINGS.includes(ring)) throw new Error('CI publishes to development (canary) or pilot (beta); promote to stable in the Update Center');
  return ring;
}

export const suiteFor = (name) => RINGS[canonicalRing(name)].suite;

if (import.meta.url === `file://${process.argv[1]}`) {
  const [cmd, name] = process.argv.slice(2);
  try {
    if (cmd === 'canonical') console.log(canonicalRing(name));
    else if (cmd === 'suite') console.log(suiteFor(name));
    else if (cmd === 'ci-suite') console.log(RINGS[ciRing(name)].suite);
    else throw new Error('usage: rings.mjs canonical|suite|ci-suite <ring>');
  } catch (e) { console.error(e.message); process.exit(2); }
}

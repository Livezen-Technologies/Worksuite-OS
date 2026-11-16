#!/usr/bin/env node
// npm audit gate for CI: fails on high/critical advisories in the package in the current directory, except for the
// packages accepted below, which are reported as warnings. Each acceptance names why; remove it once the fix lands.
// Usage (from a package directory): node ../../tools/ci/npm-audit.mjs
import { execFileSync } from 'node:child_process';

const ACCEPTED = {
  // Electron 38 has no patched release; the fixes are in Electron 45+, a major upgrade of the shell's runtime that
  // needs its own change and testing. extract-zip is Electron's download helper (npm install time only).
  electron: 'fixed only in Electron 45 (major upgrade, tracked separately)',
  'extract-zip': 'Electron install-time download helper; fixed only with Electron 45',
  // dbus-next's optional native "usocket" (abstract socket support) pulls in node-gyp 7 and its request/tar chain.
  // They run only while npm builds usocket at install time, never in the shipped services; dbus-next has no release
  // without them.
  usocket: 'optional native dependency of dbus-next; build-time only',
  'node-gyp': 'build tool for usocket (dbus-next optional dependency); build-time only',
  request: 'node-gyp 7 dependency (usocket build); build-time only',
  tar: 'node-gyp 7 dependency (usocket build); build-time only',
  'form-data': 'request dependency (usocket build); build-time only',
};
const BLOCKING = new Set(['high', 'critical']);

let out;
try {
  out = execFileSync('npm', ['audit', '--json'], { encoding: 'utf8', maxBuffer: 64 << 20 });
} catch (e) {
  out = e.stdout; // npm audit exits non-zero when it finds anything
}
const report = JSON.parse(out);
if (report.error) {
  console.error(`npm audit failed: ${report.error.summary ?? JSON.stringify(report.error)}`);
  process.exit(2);
}

let failed = 0;
for (const [name, v] of Object.entries(report.vulnerabilities ?? {})) {
  if (!BLOCKING.has(v.severity)) continue;
  if (ACCEPTED[name]) {
    console.log(`::warning::npm audit: ${name} (${v.severity}) accepted: ${ACCEPTED[name]}`);
    continue;
  }
  const via = v.via.map((x) => (typeof x === 'string' ? x : x.title)).join('; ');
  console.log(`::error::npm audit: ${name} (${v.severity}): ${via}`);
  failed++;
}
console.log(failed ? `${failed} blocking advisories` : 'npm audit: no blocking high/critical advisories');
process.exit(failed ? 1 : 0);

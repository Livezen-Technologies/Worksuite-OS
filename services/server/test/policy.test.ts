// One policy validator (src/policy.ts) for the admin console and the CLI's policy-set.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDb } from '../src/db.ts';
import { validatePolicy } from '../src/policy.ts';
import { validatePolicy as consoleValidatePolicy } from '../src/console.ts';

const main = join(import.meta.dirname, '../src/main.ts');

test('the console uses the shared validator', () => {
  assert.equal(consoleValidatePolicy, validatePolicy);
});

test('policy-set refuses what the console refuses, and stores what it accepts', () => {
  const dir = mkdtempSync(join(tmpdir(), 'ws-policy-cli-'));
  try {
    const dbPath = join(dir, 'db');
    const cli = (file: string) => execFileSync(process.execPath, ['--no-warnings', main, 'policy-set', '--db', dbPath, '--org', '1', file], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
    execFileSync(process.execPath, ['--no-warnings', main, 'init', '--db', dbPath, '--org', 'Org A'], { encoding: 'utf8' });
    const write = (name: string, body: unknown) => { const p = join(dir, name); writeFileSync(p, JSON.stringify(body)); return p; };

    for (const [name, body, field] of [
      ['unknown.json', { update_rings: 'pilot' }, /update_rings: unknown policy field/],
      ['ring.json', { update_ring: 'nightly' }, /update_ring: invalid value/],
      ['lock.json', { lock_timeout_max_s: 5 }, /lock_timeout_max_s: invalid value/],
      ['kiosk.json', { kiosk: { enabled: true, user: 'root' } }, /kiosk/],
    ] as const) {
      assert.throws(() => cli(write(name, body)), (e: { stderr: string }) => field.test(e.stderr), name);
    }
    assert.equal(openDb(dbPath).prepare('SELECT COUNT(*) AS n FROM policies').get()!.n, 0, 'nothing stored on refusal');

    const out = JSON.parse(cli(write('ok.json', { update_ring: 'pilot', usb_storage: 'block', bluetooth: null, version: 9 })));
    assert.equal(out.version, 1);
    const row = openDb(dbPath).prepare('SELECT body FROM policies WHERE org_id = 1').get() as { body: string };
    assert.deepEqual(JSON.parse(row.body), { update_ring: 'pilot', usb_storage: 'block' }, 'cleared and signed fields dropped, as in the console');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

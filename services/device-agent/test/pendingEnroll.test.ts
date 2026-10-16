// Enrollment from the installer (WSOS-INS-006).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, existsSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ApiError } from '../src/api.ts';
import { applyPendingEnrollment } from '../src/pendingEnroll.ts';

const TOKEN = 'wse_installer-Token_99';
function setup(body: unknown = { server: 'https://ws.example.com/', enrollment_token: TOKEN }, mode = 0o600) {
  const path = join(mkdtempSync(join(tmpdir(), 'ws-pending-')), 'enroll-pending.json');
  writeFileSync(path, typeof body === 'string' ? body : JSON.stringify(body), { mode });
  chmodSync(path, mode);
  const audits: [string, Record<string, unknown>][] = [];
  const calls: string[][] = [];
  return { path, audits, calls, deps: (enroll: () => Promise<unknown> = async () => 'dev_1', enrolled = false) => ({
    path, uid: process.getuid!(), enrolled: () => enrolled, audit: (e: string, d: Record<string, unknown>) => { audits.push([e, d]); },
    enroll: async (u: string, t: string) => { calls.push([u, t]); return enroll(); },
  }) };
}

test('enrolls on first boot, removes the file, never audits the token', async () => {
  const s = setup();
  assert.equal(await applyPendingEnrollment(s.deps()), 'enrolled');
  assert.deepEqual(s.calls, [['https://ws.example.com/', TOKEN]]);
  assert.equal(existsSync(s.path), false);
  assert.deepEqual(s.audits, [['installer_enrollment_done', { server: 'ws.example.com' }]]);
  assert.ok(!JSON.stringify(s.audits).includes(TOKEN));
  assert.equal(await applyPendingEnrollment(s.deps()), 'none');
});

test('no network: kept for the next try; rejected token: dropped', async () => {
  const s = setup();
  assert.equal(await applyPendingEnrollment(s.deps(async () => { throw new TypeError('fetch failed'); })), 'retry');
  assert.equal(existsSync(s.path), true);
  assert.equal(await applyPendingEnrollment(s.deps(async () => { throw new ApiError(401, 'TOKEN_EXPIRED'); })), 'dropped');
  assert.equal(existsSync(s.path), false);
  assert.deepEqual(s.audits.at(-1), ['installer_enrollment_dropped', { reason: 'rejected', server: 'ws.example.com', code: 'TOKEN_EXPIRED' }]);
});

test('already enrolled, malformed or readable by others: dropped without enrolling', async () => {
  for (const [body, mode, enrolled, reason] of [
    [undefined, 0o600, true, 'already_enrolled'],
    ['{not json ' + TOKEN, 0o600, false, 'malformed'],
    [{ server: 'http://ws.example.com/', enrollment_token: TOKEN }, 0o600, false, 'malformed'],
    [undefined, 0o644, false, 'unsafe_file'],
  ] as const) {
    const s = setup(body, mode);
    assert.equal(await applyPendingEnrollment(s.deps(undefined, enrolled)), 'dropped');
    assert.deepEqual(s.calls, []);
    assert.equal(s.audits[0][1].reason, reason);
    assert.equal(existsSync(s.path), false);
    assert.ok(!JSON.stringify(s.audits).includes(TOKEN));
  }
});

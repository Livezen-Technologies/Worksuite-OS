import { test } from 'node:test';
import assert from 'node:assert/strict';
import { appendFileSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { forwardPackageAudit, readAuditLog, type AuditCursor, type AuditEvent } from '../src/auditForward.ts';

const line = (event: string, f: Record<string, unknown> = {}, service = 'worksuite-package-service') =>
  JSON.stringify({ ts: '2026-10-16T10:00:00.000Z', service, event, ...f }) + '\n';

test('WSOS-SEC-008: package changes in the audit log are forwarded once, noise and foreign lines are not', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'ws-audit-'));
  const log = join(dir, 'package-service-audit.log');
  writeFileSync(log, line('started', { state: 'idle' }) + line('installed', { caller: 1000, source: 'flatpak', name: 'org.x.App' }) +
    'garbage\n' + line('installed', {}, 'evil-service') + line('removed', { caller: 1000, source: 'apt', name: 'vim' }) + '{"partial":');
  const sent: AuditEvent[][] = [];
  let cursor: AuditCursor = { offset: 0 };
  const run = () => forwardPackageAudit({ path: log, cursor, send: async (e) => { sent.push(e); }, save: (c) => { cursor = c; } });
  assert.equal(await run(), 2);
  assert.deepEqual(sent.flat().map((e) => e.type), ['package.installed', 'package.removed']);
  assert.deepEqual(sent[0][0].data, { caller: 1000, source: 'flatpak', name: 'org.x.App' });
  // Nothing new: nothing sent. The half-written last line is picked up once it is complete.
  assert.equal(await run(), 0);
  appendFileSync(log, '"x"}\n' + line('updated', { caller: 0, upgraded: 3 }));
  assert.equal(await run(), 1);
  assert.equal(sent.flat().at(-1)!.type, 'package.updated');
  rmSync(dir, { recursive: true, force: true });
});

test('a failed send keeps the cursor; ids are stable so the retry is deduplicated by the server', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'ws-audit-'));
  const log = join(dir, 'a.log');
  writeFileSync(log, line('repaired', { caller: 0, ok: true }));
  let cursor: AuditCursor = { offset: 0 };
  await assert.rejects(forwardPackageAudit({ path: log, cursor, send: async () => { throw new Error('NETWORK'); }, save: (c) => { cursor = c; } }));
  assert.equal(cursor.offset, 0);
  const a = readAuditLog(log, cursor).events[0].id;
  assert.equal(readAuditLog(log, { offset: 0 }).events[0].id, a);
  rmSync(dir, { recursive: true, force: true });
});

test('a rotated (shorter) log is read from the start; a missing log sends nothing', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'ws-audit-'));
  const log = join(dir, 'a.log');
  writeFileSync(log, line('installed', { name: 'a' }).repeat(5));
  const first = readAuditLog(log, { offset: 0 });
  writeFileSync(log, line('removed', { name: 'b' }));
  const after = readAuditLog(log, first.next);
  assert.deepEqual(after.events.map((e) => e.type), ['package.removed']);
  assert.deepEqual(readAuditLog(join(dir, 'missing'), { offset: 3 }), { events: [], next: { offset: 3 } });
  rmSync(dir, { recursive: true, force: true });
});

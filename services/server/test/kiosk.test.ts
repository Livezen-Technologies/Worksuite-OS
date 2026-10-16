// Kiosk policy (WSOS-AUTH-002): validation, exit PIN kept only as a verifier, admin API redaction.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { scryptSync, timingSafeEqual } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as admin from '../src/admin.ts';
import { openDb } from '../src/db.ts';
import { createHandler } from '../src/main.ts';
import { policyFor } from '../src/api.ts';
import { validatePolicy } from '../src/console.ts';
import { normalizeKiosk, pinVerifier, redactKiosk, VERIFIER, kioskUrlPattern } from '../src/kiosk.ts';

const base = { enabled: true, user: 'kiosk', devices: ['dev_1'], app: { type: 'url', url: 'https://visitors.example.com/check-in' } };
const bad = (v: unknown, field: RegExp) => assert.throws(() => normalizeKiosk(v), (e: Error & { details?: unknown }) => field.test(JSON.stringify(e) + e.message));

test('a complete kiosk policy is accepted and normalised', () => {
  const k = normalizeKiosk({ ...base, allowed_urls: ['https://*.example.com/assets/', 'https://cdn.example.net'], idle_reset_minutes: 5, show_on_screen_keyboard: true });
  assert.deepEqual(k, { ...base, allowed_urls: ['https://*.example.com/assets/', 'https://cdn.example.net'], idle_reset_minutes: 5, show_on_screen_keyboard: true });
  assert.deepEqual(normalizeKiosk({ ...base, app: { type: 'module', id: 'calendar' } }).app, { type: 'module', id: 'calendar' });
  assert.deepEqual(normalizeKiosk({ ...base, app: { type: 'desktop', id: 'org.example.Viewer.desktop' } }).app, { type: 'desktop', id: 'org.example.Viewer.desktop' });
  assert.deepEqual(normalizeKiosk({ enabled: false }), { enabled: false });
});

test('kiosk orientation and nightly screen-off', () => {
  const k = normalizeKiosk({ ...base, orientation: 'portrait', screen_off: { from: '22:00', until: '07:00' } });
  assert.equal(k.orientation, 'portrait');
  assert.deepEqual(k.screen_off, { from: '22:00', until: '07:00' });
  assert.equal(normalizeKiosk({ ...base, orientation: null, screen_off: null }).screen_off, undefined);
  bad({ ...base, orientation: 'sideways' }, /kiosk.orientation/);
  bad({ ...base, screen_off: { from: '22:00' } }, /kiosk.screen_off/);
  bad({ ...base, screen_off: { from: '24:00', until: '07:00' } }, /kiosk.screen_off/);
  bad({ ...base, screen_off: { from: '07:00', until: '07:00' } }, /kiosk.screen_off/);
  bad({ ...base, screen_off: { from: '22:00', until: '07:00', cmd: 'x' } }, /kiosk.screen_off/);
});

test('kiosk policy rejects unsafe or incomplete values', () => {
  bad({ ...base, user: 'root' }, /kiosk.user/);
  bad({ ...base, user: 'wsadmin' }, /kiosk.user/);
  bad({ ...base, user: 'Bad User' }, /kiosk.user/);
  bad({ ...base, user: undefined }, /kiosk.user/);
  bad({ ...base, devices: [] }, /kiosk.devices/);
  bad({ ...base, app: { type: 'url', url: 'http://insecure.example.com' } }, /kiosk.app/);
  bad({ ...base, app: { type: 'url', url: 'https://u:p@example.com' } }, /kiosk.app/);
  bad({ ...base, app: { type: 'url', url: 'javascript:alert(1)' } }, /kiosk.app/);
  bad({ ...base, app: { type: 'module', id: 'terminal' } }, /kiosk.app/);
  bad({ ...base, app: { type: 'desktop', id: '../../bin/sh' } }, /kiosk.app/);
  bad({ ...base, app: { type: 'desktop', id: 'xterm' } }, /kiosk.app/);
  bad({ ...base, allowed_urls: ['http://example.com'] }, /allowed_urls/);
  bad({ ...base, allowed_urls: ['https://*'] }, /allowed_urls/);
  bad({ ...base, allowed_urls: ['https://example.com/?q=1'] }, /allowed_urls/);
  bad({ ...base, idle_reset_minutes: -1 }, /idle_reset/);
  bad({ ...base, idle_reset_minutes: 1.5 }, /idle_reset/);
  bad({ ...base, show_on_screen_keyboard: 'yes' }, /keyboard/);
  bad({ ...base, run: 'sh' }, /kiosk.run/);
  bad({ ...base, allow_exit_pin: true }, /exit_pin/);
  bad({ ...base, allow_exit_pin: true, exit_pin: '12ab56' }, /exit_pin/);
  bad({ ...base, allow_exit_pin: true, exit_pin: '12345' }, /exit_pin/);
  bad({ ...base, allow_exit_pin: true, exit_pin: '111111' }, /exit_pin/);
  bad({ ...base, allow_exit_pin: true, exit_pin: '123456' }, /exit_pin/);
  // A client cannot plant its own verifier.
  bad({ ...base, allow_exit_pin: true, exit_pin_verifier: pinVerifier('482915') }, /exit_pin_verifier/);
  assert.equal(kioskUrlPattern('https://example.com:8443/a/b'), true);
});

test('the exit PIN is kept only as a salted scrypt verifier', () => {
  const k = normalizeKiosk({ ...base, allow_exit_pin: true, exit_pin: '482915' });
  assert.ok(!JSON.stringify(k).includes('482915'));
  assert.match(k.exit_pin_verifier!, VERIFIER);
  const [, n, r, p, salt, hash] = k.exit_pin_verifier!.split('$');
  const got = scryptSync('482915', Buffer.from(salt, 'base64'), 32, { N: Number(n), r: Number(r), p: Number(p), maxmem: 64 << 20 });
  assert.ok(timingSafeEqual(got, Buffer.from(hash, 'base64')));
  assert.notEqual(normalizeKiosk({ ...base, allow_exit_pin: true, exit_pin: '482915' }).exit_pin_verifier, k.exit_pin_verifier, 'fresh salt each time');
  // Saved again without a new PIN: the stored verifier is kept.
  assert.equal(normalizeKiosk({ ...base, allow_exit_pin: true, exit_pin_set: true }, k).exit_pin_verifier, k.exit_pin_verifier);
  // PIN turned off: the verifier goes.
  assert.equal(normalizeKiosk({ ...base, allow_exit_pin: false, exit_pin_set: true }, k).exit_pin_verifier, undefined);
  assert.deepEqual(redactKiosk(k), { ...base, allow_exit_pin: true, exit_pin_set: true });
});

test('validatePolicy routes kiosk through the kiosk validator', () => {
  assert.throws(() => validatePolicy({ kiosk: { ...base, user: 'root' } }));
  const p = validatePolicy({ usb_storage: 'block', kiosk: { ...base, allow_exit_pin: true, exit_pin: '482915' } });
  assert.match((p.kiosk as { exit_pin_verifier: string }).exit_pin_verifier, VERIFIER);
});

let dir: string, server: Server, url: string, db: ReturnType<typeof openDb>, org: number;
before(async () => {
  dir = mkdtempSync(join(tmpdir(), 'ws-kiosk-'));
  db = openDb(join(dir, 'db'));
  org = admin.createOrg(db, 'Kiosk Org');
  admin.addUser(db, org, 'ana@k.test', 'Ana', 'ana-password', 'admin');
  server = createServer(createHandler(db, { publicUrl: 'https://ws.test/' }));
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/admin/api/`;
});
after(() => { server.close(); rmSync(dir, { recursive: true, force: true }); });

test('admin API: kiosk saved, signed for devices with the verifier, shown to admins without it', async () => {
  const req = async (method: string, path: string, body?: unknown, cookie?: string) => {
    const r = await fetch(url + path, { method, headers: { 'x-ws-admin': '1', ...(cookie ? { cookie } : {}), ...(body ? { 'content-type': 'application/json' } : {}) }, body: body ? JSON.stringify(body) : undefined });
    return { status: r.status, body: await r.json().catch(() => null), cookie: r.headers.get('set-cookie')?.split(';')[0] };
  };
  const c = (await req('POST', 'login', { email: 'ana@k.test', password: 'ana-password' })).cookie!;
  assert.equal((await req('PUT', 'policy', { policy: { kiosk: { ...base, user: 'root' } } }, c)).status, 400);
  assert.equal((await req('PUT', 'policy', { policy: { usb_storage: 'allow', kiosk: { ...base, allow_exit_pin: true, exit_pin: '482915' } } }, c)).status, 200);
  const shown = (await req('GET', 'policy', undefined, c)).body.policy;
  assert.equal(shown.kiosk.exit_pin_set, true);
  assert.equal(shown.kiosk.exit_pin_verifier, undefined);
  const signed = policyFor(db, org) as unknown as { kiosk: { exit_pin_verifier: string } };
  assert.match(signed.kiosk.exit_pin_verifier, VERIFIER);
  // The console sends back what it showed (exit_pin_set): the verifier survives an unrelated policy change.
  assert.equal((await req('PUT', 'policy', { policy: { ...shown, usb_storage: 'block' } }, c)).status, 200);
  assert.equal((policyFor(db, org) as unknown as typeof signed).kiosk.exit_pin_verifier, signed.kiosk.exit_pin_verifier);
});

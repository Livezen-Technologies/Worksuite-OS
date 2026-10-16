// Kiosk session config writer (src/kiosk.ts): what the kiosk session, PAM check and exit helper read.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { activeKiosk, kioskFiles, KIOSK_PATHS, KIOSK_RC_XML, publicPolicy } from '../src/kiosk.ts';
import { policyEnforcement } from '../src/enforce.ts';
import type { Policy } from '../src/state.ts';

const V = 'scrypt$32768$8$1$AAAAAAAAAAAAAAAAAAAAAA==$' + 'B'.repeat(43) + '=';
const pol = (kiosk: Record<string, unknown>): Policy => ({ version: '1', signature: 'x', kiosk });
const K = { enabled: true, user: 'kiosk', devices: ['dev-1'], app: { type: 'url', url: 'https://visitors.example.com/check-in' }, allowed_urls: ['https://*.example.com/'], idle_reset_minutes: 10, show_on_screen_keyboard: true, allow_exit_pin: true, exit_pin_verifier: V };

test('kiosk applies only when enabled and this device is listed', () => {
  assert.equal(activeKiosk(null, 'dev-1'), null);
  assert.equal(activeKiosk(pol({ ...K, enabled: false }), 'dev-1'), null);
  assert.equal(activeKiosk(pol(K), 'dev-2'), null);
  assert.equal(activeKiosk(pol(K), undefined), null);
  assert.equal(activeKiosk(pol(K), 'dev-1')?.user, 'kiosk');
});

test('unsafe values turn kiosk mode off or are dropped (defence in depth on top of the signature)', () => {
  for (const user of ['root', 'wsadmin', 'a b', 'x;reboot', 'kiosk\nKIOSK_USER=root']) assert.equal(activeKiosk(pol({ ...K, user }), 'dev-1'), null, user);
  for (const app of [{ type: 'url', url: 'http://x.example.com' }, { type: 'url', url: 'file:///etc/shadow' }, { type: 'module', id: 'terminal' }, { type: 'desktop', id: '../x.desktop' }, { type: 'exec', cmd: 'sh' }])
    assert.equal(activeKiosk(pol({ ...K, app }), 'dev-1'), null, JSON.stringify(app));
  const k = activeKiosk(pol({ ...K, allowed_urls: ['https://ok.example.com', 'http://no.example.com', 'javascript:1'], idle_reset_minutes: '5; reboot', exit_pin_verifier: 'plain-1234' }), 'dev-1')!;
  assert.deepEqual(k.allowed_urls, ['https://ok.example.com']);
  assert.equal(k.idle_reset_minutes, 0);
  assert.equal(k.exit_pin, false);
  assert.equal(k.verifier, null);
});

test('session config: kiosk.json, session.env, locked labwc rc.xml and environment', () => {
  const { files, secret } = kioskFiles(activeKiosk(pol(K), 'dev-1'));
  const cfg = JSON.parse(files[KIOSK_PATHS.config]!);
  assert.deepEqual(cfg, { user: 'kiosk', app: K.app, allowed_urls: K.allowed_urls, idle_reset_minutes: 10, show_on_screen_keyboard: true, exit_pin: true });
  assert.match(files[KIOSK_PATHS.sessionEnv]!, /^KIOSK_USER=kiosk$/m);
  assert.match(files[KIOSK_PATHS.sessionEnv]!, /^KIOSK_IDLE_RESET_S=600$/m);
  assert.match(files[KIOSK_PATHS.sessionEnv]!, /^KIOSK_OSK=1$/m);
  assert.equal(secret[KIOSK_PATHS.exitVerifier], V + '\n');
  // The only keybinding is the exit gesture; Super, Alt+Tab, Alt+F4, workspaces and the root menu do not exist.
  const binds = [...KIOSK_RC_XML.matchAll(/<keybind key="([^"]+)"/g)].map((m) => m[1]);
  assert.deepEqual(binds, ['C-A-S-k']);
  assert.doesNotMatch(KIOSK_RC_XML, /ShowMenu|NextWindow|Close|GoToDesktop|Super|<default\s*\/>/);
  assert.match(KIOSK_RC_XML, /<mousebind /, 'own mousebinds so Labwc loads none of its defaults');
  assert.match(files[KIOSK_PATHS.labwcEnv]!, /^XKB_DEFAULT_OPTIONS=srvrkeys:none$/m);
  const off = kioskFiles(null);
  assert.ok(Object.values(off.files).every((v) => v === null));
  assert.equal(off.secret[KIOSK_PATHS.exitVerifier], null);
});

test('enforcement: kiosk forces USB storage off and names the account', () => {
  const e = policyEnforcement({ ...pol(K), usb_storage: 'allow' }, 'dev-1');
  assert.equal(e.usb_storage, 'block');
  assert.equal(e.kiosk_user, 'kiosk');
  assert.equal(policyEnforcement(null).kiosk_user, null);
});

test('published policy carries no exit PIN verifier', () => {
  const p = publicPolicy(pol(K));
  assert.ok(!JSON.stringify(p).includes('scrypt'));
  assert.equal((p.kiosk as Record<string, unknown>).exit_pin_set, true);
  const plain: Policy = { version: '1', signature: 'x' };
  assert.equal(publicPolicy(plain), plain);
});

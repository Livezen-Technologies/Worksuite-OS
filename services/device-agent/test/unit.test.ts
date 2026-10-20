// The systemd unit (ProtectSystem=strict) and the AppArmor profile must allow every file the agent writes.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { basename, dirname } from 'node:path';
import { ENFORCED_PATHS } from '../src/enforce.ts';
import { VPN_KEYFILE } from '../src/vpn.ts';
import { FIREWALL_RULES, FRESHCLAM_ENV } from '../src/security.ts';
import { DNS_BLOCKLIST, DNS_MODE_CONF, GUARD_CONF, ONACCESS_CONF } from '../src/protection.ts';

const root = new URL('../../../', import.meta.url);
const unit = readFileSync(new URL('services/device-agent/systemd/worksuite-device-agent.service', root), 'utf8');
const profile = readFileSync(new URL('security/apparmor/worksuite-device-agent', root), 'utf8');
const WRITTEN = [...Object.values(ENFORCED_PATHS), VPN_KEYFILE, FIREWALL_RULES, FRESHCLAM_ENV, ONACCESS_CONF, GUARD_CONF, DNS_BLOCKLIST, DNS_MODE_CONF];

test('every enforced path is inside ReadWritePaths', () => {
  assert.match(unit, /^ProtectSystem=strict$/m);
  const rw = [...unit.matchAll(/^ReadWritePaths=(.*)$/gm)].flatMap((m) => m[1].trim().split(/\s+/)).map((p) => p.replace(/^-/, ''));
  for (const p of WRITTEN) assert.ok(rw.some((d) => p.startsWith(d.endsWith('/') ? d : d + '/')), `${p} not in ReadWritePaths`);
});

test('every enforced path is writable in the AppArmor profile', () => {
  const rules = profile.split('\n').filter((l) => /\brw,\s*$/.test(l));
  for (const p of WRITTEN) {
    assert.ok(rules.some((l) => l.includes(dirname(p) + '/') && l.includes(basename(p).replace(/\.[^.]+$/, ''))), `${p} not writable in AppArmor profile`);
  }
});

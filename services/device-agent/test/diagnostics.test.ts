import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DIAGNOSTIC_PROFILES, diagnosticProfiles, stripUserinfo, type DiagnosticIo } from '../src/diagnostics.ts';

const FILES: Record<string, string> = {
  '/etc/os-release': 'PRETTY_NAME="WorkSuite OS"',
  '/etc/resolv.conf': 'nameserver 10.0.0.1',
  '/etc/worksuite/updates.json': JSON.stringify({ update_host: 'https://ci:hunter2@mirror.example/os', update_ring: 'pilot', token: 'nope' }),
  '/run/worksuite-package-service/update-status.json': JSON.stringify({ state: 'available', ring: 'pilot', version: '1.2.0', installed: '1.1.0', last_check: 1, update_host: 'https://u:p@mirror.example' }),
  '/etc/apt/sources.list.d/worksuite.list': 'deb https://u:p@mirror.example/os/apt trixie-pilot main',
};

function io() {
  const calls: string[] = [];
  const x: DiagnosticIo = {
    async run(cmd, args) { calls.push([cmd, ...args].join(' ')); if (cmd === 'nmcli' && args[0] === 'networking') return 'full\n'; return `${cmd} out`; },
    read: (p) => FILES[p] ?? '',
    async lookup(h) { calls.push(`lookup ${h}`); return ['192.0.2.1']; },
  };
  return { x, calls };
}

test('every profile the console offers is implemented', () => {
  const { x } = io();
  assert.deepEqual(Object.keys(diagnosticProfiles(x, '6.12')).sort(), [...DIAGNOSTIC_PROFILES].sort());
});

test('network: interfaces, routes, DNS and connectivity; never connection files or secrets', async () => {
  const { x, calls } = io();
  const n = await diagnosticProfiles(x, '6.12').network();
  assert.equal(n.connectivity, 'full');
  assert.equal(n['dns mirror.example'], '192.0.2.1');
  assert.equal(n['resolv.conf'], 'nameserver 10.0.0.1');
  assert.ok(calls.includes('ip -j address show') && calls.includes('ip -j route show table all'));
  assert.ok(!calls.some((c) => /show-secrets|-s\b|connection show/.test(c)), calls.join('\n'));
  assert.doesNotMatch(JSON.stringify(n), /hunter2/);
});

test('update: status, channel, last check, config and package-service logs, without URL credentials', async () => {
  const { x, calls } = io();
  const u = await diagnosticProfiles(x, '6.12').update();
  const status = JSON.parse(u.status);
  assert.equal(status.ring, 'pilot');
  assert.equal(status.last_check, 1);
  assert.deepEqual(JSON.parse(u.config), { update_host: 'https://mirror.example/os', update_ring: 'pilot', update_mode: null });
  assert.match(u['apt-source'], /deb https:\/\/mirror\.example\/os\/apt trixie-pilot/);
  assert.ok(calls.some((c) => c.startsWith('journalctl') && c.includes('-u worksuite-package-service.service')));
  assert.doesNotMatch(JSON.stringify(u), /hunter2|u:p@|nope/);
});

test('a failing program is reported, not thrown', async () => {
  const x: DiagnosticIo = { run: async () => { throw new Error('ip: not found'); }, read: () => '', lookup: async () => { throw new Error('ENOTFOUND'); } };
  const n = await diagnosticProfiles(x, '6.12').network();
  assert.equal(n.addresses, 'error: ip: not found');
  assert.match(n['dns download.worksuitecloud.com'], /ENOTFOUND/);
});

test('stripUserinfo', () => {
  assert.equal(stripUserinfo('https://a:b@h/x and http://h2/y'), 'https://h/x and http://h2/y');
});

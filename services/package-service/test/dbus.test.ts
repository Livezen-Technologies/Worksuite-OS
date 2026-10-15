// Runs the real D-Bus adapter on a private dbus-daemon with a fake polkit and package runner.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, type ChildProcess } from 'node:child_process';
import { readFileSync } from 'node:fs';
import dbus from 'dbus-next';
import { NAME, PATH, serve } from '../src/dbus.ts';
import { PackageService } from '../src/service.ts';

const { Message } = dbus;
let daemon: ChildProcess, address = '';
const xml = readFileSync(new URL('../dbus/lk.worksuite.PackageService1.xml', import.meta.url), 'utf8');

before(async () => {
  daemon = spawn('dbus-daemon', ['--session', '--nofork', '--print-address'], { stdio: ['ignore', 'pipe', 'ignore'] });
  address = await new Promise<string>((r) => daemon.stdout!.once('data', (d) => r(String(d).trim())));
});
after(() => daemon.kill());

async function setup(allowed: boolean) {
  const server = dbus.sessionBus({ busAddress: address });
  const client = dbus.sessionBus({ busAddress: address });
  const calls: string[] = [];
  const svc = new PackageService({
    runner: { async run(cmd, args) { calls.push([cmd, ...args].join(' ')); return { code: 0, stdout: '', stderr: '' }; } },
    policy: () => null, sources: () => [], power: () => ({ ac: true, battery: null }), freeBytes: () => 1e12, audit() {},
  });
  const checked: string[] = [];
  serve(server, svc, { uid: async () => 1000, check: async (_s, action) => { checked.push(action); return allowed; } }, xml);
  await server.requestName(NAME, 0);
  const call = (member: string, signature = '', body: unknown[] = [], iface = NAME) =>
    client.call(new Message({ destination: NAME, path: PATH, interface: iface, member, signature, body }));
  return { server, client, call, calls, checked, close: () => { server.disconnect(); client.disconnect(); } };
}

test('Install is authorized with polkit, returns a job path and signals JobFinished', async () => {
  const w = await setup(true);
  const finished = new Promise<unknown[]>((resolve) => {
    w.client.on('message', (m) => { if (m.member === 'JobFinished') resolve(m.body); });
  });
  await w.client.call(new Message({ destination: 'org.freedesktop.DBus', path: '/org/freedesktop/DBus', interface: 'org.freedesktop.DBus', member: 'AddMatch', signature: 's', body: [`type='signal',interface='${NAME}'`] }));
  const r = await w.call('Install', 'ss', ['flatpak', 'flatpak:org.gimp.GIMP']);
  assert.match(String(r?.body[0]), /^\/lk\/worksuite\/PackageService1\/job\/\d+$/);
  assert.deepEqual(w.checked, ['lk.worksuite.package.install']);
  const [path, result] = await finished as [string, string];
  assert.equal(path, r?.body[0]); assert.equal(result, 'success');
  assert.ok(w.calls.includes('flatpak install --system --noninteractive -y flathub org.gimp.GIMP'));
  w.close();
});

test('polkit denial → lk.worksuite.Error.NotAuthorized, nothing runs', async () => {
  const w = await setup(false);
  await assert.rejects(w.call('Repair'), (e: { type?: string }) => e.type === 'lk.worksuite.Error.NotAuthorized');
  assert.deepEqual(w.calls, []);
  w.close();
});

test('bad arguments map to typed errors; read-only calls need no polkit', async () => {
  const w = await setup(true);
  await assert.rejects(w.call('Install', 'ss', ['deb', 'x']), (e: { type?: string }) => e.type === 'lk.worksuite.Error.InvalidArgs');
  await assert.rejects(w.call('Install', 'ss', ['apt', '-oAPT::Foo=1']), (e: { type?: string }) => e.type === 'lk.worksuite.Error.InvalidArgs');
  w.checked.length = 0;
  const u = await w.call('CheckUpdates');
  assert.equal(u?.body[0].state.value, 'idle');
  assert.deepEqual(w.checked, []);
  const props = await w.call('GetAll', 's', [NAME], 'org.freedesktop.DBus.Properties');
  assert.equal(props?.body[0].State.value, 'idle');
  const intro = await w.call('Introspect', '', [], 'org.freedesktop.DBus.Introspectable');
  assert.match(String(intro?.body[0]), /lk\.worksuite\.PackageService1/);
  w.close();
});

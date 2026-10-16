import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { ACTIONS, BusError, dispatch, properties, type AgentOps, type Authority } from '../src/dbus.ts';

const ops = (over: Partial<AgentOps> = {}): AgentOps & { enrolled: string[] } => {
  const enrolled: string[] = [];
  return {
    enrolled,
    status: () => ({ managed: false, org_name: null, device_id: null, last_check_in: null, policies: null }),
    effectivePolicy: () => null,
    enroll: async (url) => { enrolled.push(url); return 'dev-1'; },
    refresh: async () => {},
    ...over,
  };
};
const auth = (uid: number, allow: boolean, seen: string[] = []): Authority => ({ uid: async () => uid, check: async (_s, a) => { seen.push(a); return allow; } });

test('every method in the interface XML has a polkit action or is read-only (WSOS-ARC-002)', () => {
  const xml = readFileSync(new URL('../dbus/lk.worksuite.DeviceAgent1.xml', import.meta.url), 'utf8');
  const methods = [...xml.matchAll(/<method name="(\w+)"/g)].map((m) => m[1]).sort();
  assert.deepEqual(methods, Object.keys(ACTIONS).sort());
  const policy = readFileSync(new URL('../polkit/lk.worksuite.device.policy', import.meta.url), 'utf8');
  for (const a of Object.values(ACTIONS)) if (a) assert.match(policy, new RegExp(`action id="${a.replace(/\./g, '\\.')}"`));
});

test('Enroll needs lk.worksuite.device.enroll for a normal user; root callers pass', async () => {
  const seen: string[] = [];
  const o = ops();
  await assert.rejects(dispatch('Enroll', ['https://ws.test', 'tok'], ':1.5', auth(1000, false, seen), o), (e) => e instanceof BusError && e.code === 'NotAuthorized');
  assert.deepEqual(seen, ['lk.worksuite.device.enroll']);
  assert.deepEqual(o.enrolled, []);
  assert.deepEqual(await dispatch('Enroll', ['https://ws.test', 'tok'], ':1.5', auth(1000, true), o), ['s', ['dev-1']]);
  assert.deepEqual(await dispatch('Enroll', ['https://ws.test', 'tok'], ':1.6', auth(0, false), o), ['s', ['dev-1']]);
});

test('Enroll checks arguments and never echoes the token in errors', async () => {
  await assert.rejects(dispatch('Enroll', ['https://ws.test', ''], ':1', auth(0, true), ops()), (e) => e instanceof BusError && e.code === 'InvalidArgs');
  const failing = ops({ enroll: async (_u, token) => { throw new Error(`bad token ${token}`); } });
  await assert.rejects(dispatch('Enroll', ['https://ws.test', 'SECRET-123'], ':1', auth(0, true), failing), (e) => e instanceof BusError && !e.message.includes('SECRET') && e.message === 'ENROLL_FAILED');
  const known = ops({ enroll: async () => { throw new Error('ALREADY_ENROLLED'); } });
  await assert.rejects(dispatch('Enroll', ['https://ws.test', 'x'], ':1', auth(0, true), known), (e) => e instanceof BusError && e.message === 'ALREADY_ENROLLED');
});

test('read-only methods need no authorization', async () => {
  const deny = auth(1000, false);
  const [sig, body] = await dispatch('GetManagementInfo', [], ':1', deny, ops());
  assert.equal(sig, 'a{sv}');
  assert.deepEqual((body[0] as Record<string, unknown>).managed, ['b', false]);
  assert.deepEqual(await dispatch('GetEffectivePolicy', [], ':1', deny, ops()), ['s', ['null']]);
  assert.deepEqual(await dispatch('RefreshNow', [], ':1', deny, ops()), ['', []]);
  assert.deepEqual(properties(ops()).Enrolled, ['b', false]);
  await assert.rejects(dispatch('Wipe', [], ':1', deny, ops()));
});

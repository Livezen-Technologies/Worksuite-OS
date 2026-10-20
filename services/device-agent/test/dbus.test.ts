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

test('StartSecurityScan needs lk.worksuite.security.scan and a valid kind', async () => {
  const seen: string[] = [], kinds: string[] = [];
  const o = ops({ scan: (k) => { kinds.push(k); } });
  await assert.rejects(dispatch('StartSecurityScan', ['quick'], ':1', auth(1000, false, seen), o), (e) => e instanceof BusError && e.code === 'NotAuthorized');
  assert.deepEqual(seen, ['lk.worksuite.security.scan']);
  await assert.rejects(dispatch('StartSecurityScan', ['everything'], ':1', auth(1000, true), o), (e) => e instanceof BusError && e.code === 'InvalidArgs');
  assert.deepEqual(await dispatch('StartSecurityScan', ['full'], ':1', auth(1000, true), o), ['', []]);
  assert.deepEqual(kinds, ['full']);
  await assert.rejects(dispatch('StartSecurityScan', ['quick'], ':1', auth(0, true), ops()), (e) => e instanceof BusError && e.message === 'NOT_SUPPORTED');
});

test('quarantine and suspended processes (#38) need lk.worksuite.security.quarantine; agent error codes pass through', async () => {
  const seen: string[] = [], calls: string[] = [];
  const id = '0f0e0d0c-0b0a-4908-8706-050403020100';
  const o = ops({
    restore: async (q) => { calls.push(`restore ${q}`); throw new Error('STILL_DETECTED'); },
    deleteQuarantined: async (q) => { calls.push(`delete ${q}`); },
    resolveSuspended: async (e, a) => { calls.push(`${a} ${e}`); },
  });
  await assert.rejects(dispatch('DeleteQuarantined', [id], ':1', auth(1000, false, seen), o), (e) => e instanceof BusError && e.code === 'NotAuthorized');
  assert.deepEqual(seen, ['lk.worksuite.security.quarantine']);
  await assert.rejects(dispatch('DeleteQuarantined', ['../x'], ':1', auth(1000, true), o), (e) => e instanceof BusError && e.code === 'InvalidArgs');
  await assert.rejects(dispatch('RestoreQuarantined', [id], ':1', auth(1000, true), o), (e) => e instanceof BusError && e.message === 'STILL_DETECTED');
  assert.deepEqual(await dispatch('DeleteQuarantined', [id], ':1', auth(1000, true), o), ['', []]);
  await assert.rejects(dispatch('ResolveSuspendedProcess', [id, 'stop'], ':1', auth(1000, true), o), (e) => e instanceof BusError && e.code === 'InvalidArgs');
  assert.deepEqual(await dispatch('ResolveSuspendedProcess', [id, 'resume'], ':1', auth(1000, true), o), ['', []]);
  assert.deepEqual(calls, [`restore ${id}`, `delete ${id}`, `resume ${id}`]);
  await assert.rejects(dispatch('DeleteQuarantined', [id], ':1', auth(0, true), ops()), (e) => e instanceof BusError && e.message === 'NOT_SUPPORTED');
});

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync, randomUUID, sign } from 'node:crypto';
import { ALLOWED_COMMANDS, MemoryReplayStore, signingBytes, validateCommand, type CommandEnvelope } from '../src/commands.ts';

const { privateKey, publicKey } = generateKeyPairSync('ed25519');
const other = generateKeyPairSync('ed25519');
const NOW = Date.parse('2026-10-15T10:00:00Z');
const DAY = 86_400_000;

function make(over: Partial<CommandEnvelope> = {}, key = privateKey): CommandEnvelope {
  const e = {
    id: randomUUID(), command: 'RequestLock', device_id: 'dev-1',
    issued_at: new Date(NOW - 1000).toISOString(), expires_at: new Date(NOW + DAY).toISOString(), args: {},
    ...over,
  } as CommandEnvelope;
  e.signature = { alg: 'ed25519', key_id: 'k1', value: sign(null, signingBytes(e), key).toString('base64') };
  return e;
}
const deps = () => ({ deviceId: 'dev-1', keys: (id: string) => (id === 'k1' ? publicKey : undefined), replay: new MemoryReplayStore(), now: () => NOW });

test('valid command accepted once; replay rejected', () => {
  const d = deps(); const e = make();
  assert.equal(validateCommand(e, d).ok, true);
  assert.deepEqual(validateCommand(e, d), { ok: false, reason: 'REPLAY' });
});

test('allow-list is exactly the SRS set plus software and security incident response; no shell', () => {
  // RemoveApplication: Software Management remote uninstall (catalog ids only; the package service refuses system packages).
  assert.deepEqual([...ALLOWED_COMMANDS].sort(), ['CollectApprovedDiagnostics', 'DeleteQuarantined', 'InstallApprovedApplication', 'IsolateEndpoint', 'RebootDuringWindow', 'RefreshPolicy', 'ReleaseIsolation', 'RemoteSupportEnd', 'RemoteSupportRequest', 'RemoteWipe', 'RemoveApplication', 'RequestLock', 'ResolveSuspendedProcess', 'RestoreQuarantined', 'ScheduleUpdate', 'StartMalwareScan']);
  assert.equal((validateCommand(make({ command: 'RunShell' as any }), deps()) as any).reason, 'UNKNOWN_COMMAND');
});

test('rejections', () => {
  const r = (e: unknown) => (validateCommand(e, deps()) as any).reason;
  assert.equal(r(make({ device_id: 'dev-2' })), 'WRONG_DEVICE');
  assert.equal(r(make({ expires_at: new Date(NOW - 1).toISOString(), issued_at: new Date(NOW - DAY).toISOString() })), 'EXPIRED');
  assert.equal(r(make({ issued_at: new Date(NOW + DAY).toISOString(), expires_at: new Date(NOW + 2 * DAY).toISOString() })), 'NOT_YET_VALID');
  assert.equal(r(make({ expires_at: new Date(NOW + 8 * DAY).toISOString() })), 'TTL_TOO_LONG');
  assert.equal(r(make({ id: 'not-a-uuid' })), 'MALFORMED');
  const unsigned = make(); delete (unsigned as any).signature;
  assert.equal(r(unsigned), 'SIGNATURE_MISSING');
  assert.equal(r(make({}, other.privateKey)), 'BAD_SIGNATURE');
  const tampered = make(); tampered.device_id = 'dev-1'; tampered.args = { x: 1 };
  assert.equal(r(tampered), 'BAD_SIGNATURE');
  const unknownKey = make(); unknownKey.signature.key_id = 'k9';
  assert.equal(r(unknownKey), 'UNKNOWN_KEY');
});

test('RemoteWipe: 30-day max, scope and approval required', () => {
  const r = (e: unknown) => validateCommand(e, deps());
  assert.equal(r(make({ command: 'RemoteWipe', args: { scope: 'worksuite_data', approval_id: 'a1' }, expires_at: new Date(NOW + 29 * DAY).toISOString() })).ok, true);
  assert.equal((r(make({ command: 'RemoteWipe', args: { scope: 'worksuite_data', approval_id: 'a1' }, expires_at: new Date(NOW + 31 * DAY).toISOString() })) as any).reason, 'TTL_TOO_LONG');
  assert.equal((r(make({ command: 'RemoteWipe', args: { scope: 'everything' } })) as any).reason, 'BAD_ARGS');
});

test('CollectApprovedDiagnostics: only the profiles the agent implements', () => {
  const r = (e: unknown) => validateCommand(e, deps());
  for (const p of ['basic', 'session', 'network', 'update']) assert.equal(r(make({ command: 'CollectApprovedDiagnostics', args: { bundle_profile: p } })).ok, true, p);
  assert.equal((r(make({ command: 'CollectApprovedDiagnostics', args: { bundle_profile: 'everything' } })) as any).reason, 'BAD_ARGS');
});

test('quarantine and suspended-process commands (#38): ids are UUIDs, force is a boolean, resume or terminate only', () => {
  const r = (e: unknown) => validateCommand(e, deps());
  const q = randomUUID();
  assert.equal(r(make({ command: 'RestoreQuarantined', args: { quarantine_id: q } })).ok, true);
  assert.equal(r(make({ command: 'RestoreQuarantined', args: { quarantine_id: q, force: true } })).ok, true);
  assert.equal((r(make({ command: 'RestoreQuarantined', args: { quarantine_id: q, force: 'yes' } })) as any).reason, 'BAD_ARGS');
  assert.equal((r(make({ command: 'DeleteQuarantined', args: { quarantine_id: '../../etc/passwd' } })) as any).reason, 'BAD_ARGS');
  assert.equal(r(make({ command: 'DeleteQuarantined', args: { quarantine_id: q } })).ok, true);
  assert.equal(r(make({ command: 'ResolveSuspendedProcess', args: { event_id: q, action: 'resume' } })).ok, true);
  assert.equal((r(make({ command: 'ResolveSuspendedProcess', args: { event_id: q, action: 'kill -9 1' } })) as any).reason, 'BAD_ARGS');
});

test('expired ids are pruned from the replay store but still rejected as expired', () => {
  const d = deps(); const e = make();
  assert.equal(validateCommand(e, d).ok, true);
  const later = { ...d, now: () => NOW + 2 * DAY };
  assert.equal((validateCommand(e, later) as any).reason, 'EXPIRED');
});

// Crash-safe mirrored state: newest valid copy wins, a damaged copy falls back to the other, root-only files.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { MirroredFileStore, FILE } from '../src/store.ts'
import { deserialize, serialize, SCHEMA_VERSION, type SetupSnapshot } from '../src/machine/core/SetupPersistence.ts'

const snap = (state: SetupSnapshot['state'], updatedAt: number): SetupSnapshot =>
  ({ version: SCHEMA_VERSION, mode: 'install', state, resumeTo: null, answers: {}, attempts: 0, lastError: null, checkpoints: [], updatedAt })
const dirs = () => { const t = mkdtempSync(path.join(tmpdir(), 'ws-setup-store-')); return [path.join(t, 'esp'), path.join(t, 'target')] }

test('writes every mirror with 0600 files in 0700 directories', async () => {
  const [a, b] = dirs(); const s = new MirroredFileStore([a, b])
  await s.save(serialize(snap('WELCOME', 1)))
  for (const d of [a, b]) {
    assert.equal(statSync(path.join(d, FILE)).mode & 0o777, 0o600)
    assert.equal(statSync(d).mode & 0o777, 0o700)
  }
})

test('loads the newest valid copy; a damaged newer copy falls back to the older good one', async () => {
  const [a, b] = dirs(); const s = new MirroredFileStore([a, b])
  await s.save(serialize(snap('WELCOME', 1)))
  writeFileSync(path.join(b, FILE), serialize(snap('LANGUAGE_REGION', 5)))
  let r = deserialize(await s.load()); assert.ok(r.ok && r.snapshot.state === 'LANGUAGE_REGION')
  writeFileSync(path.join(b, FILE), readFileSync(path.join(b, FILE), 'utf8').slice(0, 40))   // torn write
  r = deserialize(await s.load()); assert.ok(r.ok && r.snapshot.state === 'WELCOME')
})

test('every copy damaged → the raw text is returned so the machine reports it as corrupt', async () => {
  const [a] = dirs(); const s = new MirroredFileStore([a])
  await s.save(serialize(snap('WELCOME', 1)))
  writeFileSync(path.join(a, FILE), '{"sum":"0","body":"{}"}')
  assert.deepEqual(deserialize(await s.load()), { ok: false, reason: 'corrupt' })
})

test('a mirror that cannot be written is tolerated; no writable mirror at all is an error', async () => {
  const [a, b] = dirs(); writeFileSync(path.dirname(b) + '/blocker', '')
  const broken = path.join(path.dirname(b), 'blocker', 'sub')   // parent is a file: every write fails (ENOTDIR)
  const s = new MirroredFileStore([a, broken])
  await s.save(serialize(snap('LANGUAGE_REGION', 2)))   // the other copy is enough
  const r = deserialize(await s.load()); assert.ok(r.ok && r.snapshot.state === 'LANGUAGE_REGION')
  const only = new MirroredFileStore([broken])
  await assert.rejects(only.save('x'), /could not be saved/)
})

test('addMirror starts writing the target root copy from then on', async () => {
  const [a, b] = dirs(); const s = new MirroredFileStore([a])
  s.addMirror(b)
  await s.save(serialize(snap('INSTALLING_OS', 3)))
  assert.ok(deserialize(readFileSync(path.join(b, FILE), 'utf8')).ok)
})

// Everything from the UI is validated: known events only, never work results, known answers, no secrets.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { parseAnswer, parseEvent } from '../src/validate.ts'

const bad = (fn: () => unknown) => assert.throws(fn, (e: { code?: string }) => e.code === 'InvalidArgs')

test('UI events: allowed ones parse; work results and unknown events are refused', () => {
  assert.deepEqual(parseEvent('{"type":"NEXT"}'), { type: 'NEXT' })
  assert.deepEqual(parseEvent('{"type":"GOTO","to":"LANGUAGE_REGION"}'), { type: 'GOTO', to: 'LANGUAGE_REGION' })
  for (const t of ['WORK_DONE', 'WORK_FAILED', 'ROLLBACK_DONE', 'NETWORK_RESTORED', 'TIMEOUT', 'APPROVED', 'nope']) bad(() => parseEvent(JSON.stringify({ type: t })))
  bad(() => parseEvent('{"type":"GOTO","to":"PAUSED"}'))
  bad(() => parseEvent('not json'))
  bad(() => parseEvent('x'.repeat(70_000)))
})

test('answers: known keys with the right shape; passwords and tokens are never stored', () => {
  assert.deepEqual(parseAnswer('worksuiteApps', '["worksuite-desktop","worksuite-office"]'), { key: 'worksuiteApps', value: ['worksuite-desktop', 'worksuite-office'] })
  bad(() => parseAnswer('rootShell', '"x"'))
  bad(() => parseAnswer('account', '{"user":"ana","password":"hunter2"}'))
  bad(() => parseAnswer('encryption', '{"enabled":true,"passphrase":"x"}'))
  bad(() => parseAnswer('aiMcp', '{"connectors":[{"name":"x","apiToken":"y"}]}'))
  bad(() => parseAnswer('disk', '"../../dev/sda"'))
  bad(() => parseAnswer('worksuiteApps', '["$(rm -rf /)"]'))
})

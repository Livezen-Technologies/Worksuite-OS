// The service's copy of the state machine must be exactly the shell's (scripts/sync-machine.mjs).
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readdirSync, readFileSync } from 'node:fs'
import path from 'node:path'
// @ts-expect-error plain .mjs script
import { DEST, expected } from '../scripts/sync-machine.mjs'

test('src/machine matches shell/src/components/setup-wizard (run npm run sync-machine)', () => {
  const want = expected() as Map<string, string>
  const have = new Map<string, string>()
  for (const d of readdirSync(DEST)) for (const f of readdirSync(path.join(DEST, d))) have.set(`${d}/${f}`, readFileSync(path.join(DEST, d, f), 'utf8'))
  assert.deepEqual([...have.keys()].sort(), [...want.keys()].sort())
  for (const [k, v] of want) assert.equal(have.get(k), v, `${k} differs from the shell copy`)
})

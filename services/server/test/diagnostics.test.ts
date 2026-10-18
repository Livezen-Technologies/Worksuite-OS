// The console must offer exactly the diagnostic profiles the device agent implements.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DIAG_PROFILES } from '../src/console.ts';
import { APP_JS } from '../src/console-ui.ts';
import { DIAGNOSTIC_PROFILES } from '../../device-agent/src/diagnostics.ts';

test('console diagnostic profiles = device agent profiles', () => {
  assert.deepEqual([...DIAG_PROFILES].sort(), [...DIAGNOSTIC_PROFILES].sort());
  for (const p of DIAGNOSTIC_PROFILES) assert.match(APP_JS, new RegExp(`option', \\{ value: '${p}' \\}`), `UI offers ${p}`);
});

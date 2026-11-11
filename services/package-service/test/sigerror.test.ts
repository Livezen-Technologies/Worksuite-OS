// apt signature failures must map to SignatureInvalid on both gpgv (bookworm/Ubuntu) and sqv (Debian 13) systems.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { SIG_ERROR } from '../src/service.ts';

test('recognises gpgv and sqv signature failures, not ordinary network errors', () => {
  // Captured from apt 3.0 on Debian 13 when the repository is re-signed with a foreign key (tests/repo/apt-e2e.sh).
  const sqv = 'W: OpenPGP signature verification failed: http://127.0.0.1:20231/os/apt trixie-stable InRelease: Sub-process /usr/bin/sqv returned an error code (1), error message is: Missing key 16FE302A3597E5CF2F4257AE844313AC54AE2429, which is needed to verify signature.';
  assert.ok(SIG_ERROR.test(sqv));
  assert.ok(SIG_ERROR.test('W: GPG error: http://x trixie InRelease: The following signatures couldn\'t be verified because the public key is not available: NO_PUBKEY 844313AC54AE2429'));
  assert.ok(SIG_ERROR.test('E: The repository \'http://x trixie InRelease\' is not signed.'));
  assert.ok(!SIG_ERROR.test('E: Failed to fetch http://x/dists/trixie/InRelease  Could not resolve \'x\''));
  assert.ok(!SIG_ERROR.test('W: Some index files failed to download. They have been ignored, or old ones used instead.'));
});

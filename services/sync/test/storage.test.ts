// WSOS-SYN-010: the local store must be on dm-crypt when the system uses LUKS.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { checkStorage, luksEnabled, onEncryptedStorage, sourceDevice, type Run } from '../src/storage.ts';

const fake = (findmnt: string | null, lsblk: string | null): { run: Run; calls: string[][] } => {
  const calls: string[][] = [];
  return { calls, run: (cmd, args) => { calls.push([cmd, ...args]); return cmd === 'findmnt' ? findmnt : lsblk; } };
};

test('crypttab with entries means LUKS is enabled', () => {
  assert.equal(luksEnabled(null), false);
  assert.equal(luksEnabled('# <target name> <source device>\n\n'), false);
  assert.equal(luksEnabled('luks-home UUID=1234 none luks,discard\n'), true);
});

test('finds the device under btrfs subvolumes', () => {
  assert.equal(sourceDevice('/dev/mapper/luks-home[/@home]\n'), '/dev/mapper/luks-home');
  assert.equal(sourceDevice('tmpfs\n'), null);
});

test('detects dm-crypt below the database directory with fixed argv', () => {
  const f = fake('/dev/mapper/luks-home\n', 'crypt\npart\ndisk\n');
  assert.equal(onEncryptedStorage('/home/u/.local/state/worksuite', f.run), true);
  assert.deepEqual(f.calls, [['findmnt', '-n', '-o', 'SOURCE', '-T', '/home/u/.local/state/worksuite'], ['lsblk', '-s', '-n', '-o', 'TYPE', '/dev/mapper/luks-home']]);
  assert.equal(onEncryptedStorage('/x', fake('/dev/sda2\n', 'part\ndisk\n').run), false);
  assert.equal(onEncryptedStorage('/x', fake(null, null).run), null);
});

test('refuses an unencrypted or unknown store only when LUKS is enabled', () => {
  const crypttab = 'luks-home UUID=1 none luks\n';
  assert.deepEqual(checkStorage('/s', crypttab, fake('/dev/mapper/luks-home', 'crypt\npart').run), { ok: true, encrypted: true });
  assert.deepEqual(checkStorage('/s', crypttab, fake('/dev/sda3', 'part\ndisk').run), { ok: false, reason: 'storage_unencrypted' });
  assert.deepEqual(checkStorage('/s', crypttab, fake('tmpfs', null).run), { ok: false, reason: 'storage_unencrypted' });
  assert.deepEqual(checkStorage('/s', null, fake('/dev/sda3', 'part\ndisk').run), { ok: true, encrypted: false });
});

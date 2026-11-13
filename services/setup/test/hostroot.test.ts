// Package-changing commands leave the setup service's read-only /usr; reads stay inside it.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { hostRoot } from '../src/hostroot.ts'

test('only package-changing commands run outside the service sandbox', () => {
  assert.equal(hostRoot('apt-get', ['-y', '-q', '-o', 'APT::Status-Fd=1', 'install', '--', 'vlc']), true)
  assert.equal(hostRoot('apt-get', ['-q', 'update']), true)
  assert.equal(hostRoot('apt-get', ['-y', '-q', 'remove', '--', 'vlc']), true)
  assert.equal(hostRoot('apt-get', ['-s', '-q', 'install', '--', 'vlc']), false, 'simulation reads only')
  assert.equal(hostRoot('apt-get', ['-qq', '--print-uris', 'install', '--', 'vlc']), false)
  assert.equal(hostRoot('dpkg', ['--audit']), false)
  assert.equal(hostRoot('dpkg', ['--configure', '-a']), true)
  assert.equal(hostRoot('dpkg-query', ['-W', 'vlc']), false)
  assert.equal(hostRoot('flatpak', ['install', '-y', '--system', 'flathub', 'org.x.Y']), true)
  assert.equal(hostRoot('flatpak', ['info', '--system', 'org.x.Y']), false)
  assert.equal(hostRoot('update-desktop-database', ['/usr/share/applications']), true)
  assert.equal(hostRoot('journalctl', ['-b']), false)
})

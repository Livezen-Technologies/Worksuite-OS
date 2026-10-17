// lib/errors.ts: the shared helper that keeps technical text off the screen.
import { describe, expect, it } from 'vitest'
import { classifyError, errorMessage, friendlyError, isCode, rawText } from './errors'
import { packageErrorText } from './os'

describe('friendly errors', () => {
  it('classifies service codes and technical text alike', () => {
    expect(classifyError('not_authorized')).toBe('not_authorized')
    expect(classifyError('Error: EACCES: permission denied, open \'/var/lib/dpkg/lock\'')).toBe('not_authorized')
    expect(classifyError('write /var/cache/apt/archives/x.deb: No space left on device')).toBe('no_space')
    expect(classifyError('getaddrinfo ENOTFOUND deb.debian.org')).toBe('offline')
    expect(classifyError('E: Could not get lock /var/lib/dpkg/lock-frontend. It is held by process 1234 (apt)')).toBe('busy')
    expect(classifyError('W: GPG error: … NO_PUBKEY 0E98404D386FA1D9')).toBe('integrity')
    expect(classifyError('The following packages have unmet dependencies: foo : Depends: libbar')).toBe('dependencies')
    expect(classifyError('mount: /media/x: wrong fs type, bad option, bad superblock on /dev/sdb1')).toBe('unsupported')
    expect(classifyError('Segmentation fault (core dumped)')).toBe('crashed')
    expect(classifyError('ETIMEDOUT')).toBe('timeout')
    expect(classifyError('org.freedesktop.DBus.Error.ServiceUnknown: The name has no owner')).toBe('service')
    expect(classifyError('something odd')).toBe('unknown')
    expect(classifyError('')).toBe('unknown')
  })

  it('never shows the technical text: a sentence for people, the raw text as details', () => {
    const raw = 'E: Could not get lock /var/lib/dpkg/lock-frontend. It is held by process 1234 (apt)'
    const f = friendlyError(raw, 'package')
    expect(f.text).not.toContain('dpkg')
    expect(f.text).not.toContain('/var/lib')
    expect(f.text).toMatch(/couldn’t be changed/)
    expect(f.text).toMatch(/Something else is using it/)
    expect(f.details).toBe(raw)
  })

  it('known codes have no details; unknown codes are details for administrators', () => {
    expect(friendlyError('no_space', 'update').details).toBeNull()
    expect(friendlyError('weird_backend_code', 'update')).toEqual({ kind: 'unknown', text: 'The update couldn’t be installed.', details: 'weird_backend_code' })
  })

  it('cancelling says nothing', () => {
    expect(friendlyError('cancelled').text).toBe('')
    expect(friendlyError('auth_cancelled').text).toBe('')
  })

  it('accepts Errors and result objects', () => {
    expect(rawText(new Error('boom'))).toBe('boom')
    expect(rawText({ ok: false, error: 'offline' })).toBe('offline')
    expect(errorMessage(new Error('connect ECONNREFUSED 127.0.0.1:443'), 'network')).toBe('Couldn’t connect. Check the internet connection and try again.')
    expect(isCode('not_authorized')).toBe(true)
    expect(isCode('Not authorized.')).toBe(false)
  })

  it('package errors no longer echo PackageKit text', () => {
    expect(packageErrorText('E: Unable to locate package spotify-client')).toBe('The app couldn’t be changed. Something it needs is missing.')
    expect(packageErrorText('not_authorized')).not.toMatch(/_/)
    expect(packageErrorText('cancelled')).toBe('')
  })
})

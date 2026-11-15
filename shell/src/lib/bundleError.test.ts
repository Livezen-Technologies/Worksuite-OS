import { describe, expect, it } from 'vitest'
import { bundleErrorText } from './os'
import { setLocale } from '../i18n'

describe('bundleErrorText (offline update files)', () => {
  it('turns the package service refusals into sentences about the update file', () => {
    setLocale('en')
    expect(bundleErrorText('bundle is not signed with the WorkSuite release key')).toMatch(/isn’t signed by WorkSuite/)
    expect(bundleErrorText('pool/x.deb does not match the signed manifest')).toMatch(/isn’t signed by WorkSuite or was changed/)
    expect(bundleErrorText('refused a downgrade without a signed rollback directive')).toMatch(/older than/)
    expect(bundleErrorText('version 1.0.1 is already installed')).toBe('This version is already installed.')
    expect(bundleErrorText('bundle is for arm64; this device is amd64')).toMatch(/different kind of computer/)
    // Seen in a VM: the old mapping read "not found" as a missing app dependency.
    expect(bundleErrorText('file not found or is a link')).toMatch(/couldn’t be read/)
    expect(bundleErrorText('inbox_failed')).toMatch(/couldn’t be read/)
    expect(bundleErrorText('not_authorized')).not.toMatch(/update file/)
  })
})

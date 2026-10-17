import { describe, expect, it } from 'vitest'
import { START_PLACE, startFallback } from './parts'

describe('Files start folder', () => {
  it('opens Documents', () => expect(START_PLACE).toEqual({ kind: 'dir', root: 'home', rel: 'Documents' }))
  it('falls back to Home when Documents is missing', () => {
    expect(startFallback(START_PLACE, false)).toEqual({ kind: 'dir', root: 'home', rel: '' })
  })
  it('keeps Documents when it lists, and never redirects other folders', () => {
    expect(startFallback(START_PLACE, true)).toBeNull()
    expect(startFallback({ kind: 'dir', root: 'home', rel: 'Music' }, false)).toBeNull()
  })
})

describe('storage card name', () => {
  it('never shows a raw luks- name', async () => {
    const { diskName } = await import('./parts')
    expect(diskName({ device: 'luks-3f1c', encrypted: true })).toBe('WorkSuite OS (encrypted)')
    expect(diskName({ device: 'dm-0', label: 'Data' })).toBe('Data')
  })
})

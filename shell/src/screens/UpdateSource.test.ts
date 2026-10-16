import { describe, expect, it } from 'vitest'
import { updateSource } from './Updates'

describe('Updates: where updates come from', () => {
  it('shows the Update Center host the coordinator checked', () => {
    expect(updateSource('https://download.worksuitecloud.com')).toBe(' · download.worksuitecloud.com')
    expect(updateSource('https://mirror.example:8443')).toBe(' · mirror.example:8443')
  })
  it('shows nothing for older services or a bad value', () => {
    expect(updateSource(undefined)).toBe('')
    expect(updateSource('nope')).toBe('')
  })
})

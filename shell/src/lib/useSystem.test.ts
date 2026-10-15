import { describe, expect, it } from 'vitest'
import { unavailableText } from './useSystem'
import { formatDuration } from './os'

describe('system text', () => {
  it('formats durations', () => {
    expect(formatDuration(4800)).toBe('about 1 h 20 min')
    expect(formatDuration(600)).toBe('about 10 min')
    expect(formatDuration(null)).toBeNull()
  })
  it('explains unavailable reasons', () => {
    expect(unavailableText('wpctl_missing')).toBe('Not available on this system')
    expect(unavailableText('no_battery')).toMatch(/battery/)
  })
})

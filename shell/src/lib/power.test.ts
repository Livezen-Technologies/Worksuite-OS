import { describe, expect, it } from 'vitest'
import { ageLabel, ringDash, uptimeLabel } from './power'

describe('power helpers', () => {
  it('draws the countdown ring as the remaining share', () => {
    expect(ringDash(60)).toBe('175.9 175.9')
    expect(ringDash(42)).toBe('123.2 175.9')
    expect(ringDash(0)).toBe('0.0 175.9')
    expect(ringDash(-3)).toBe('0.0 175.9')
  })
  it('formats uptime like the power menu board', () => {
    expect(uptimeLabel((3 * 60 + 42) * 60_000)).toBe('Up for 3 h 42 min')
    expect(uptimeLabel(5 * 60_000)).toBe('Up for 5 min')
    expect(uptimeLabel(2 * 3_600_000)).toBe('Up for 2 h')
    expect(uptimeLabel(10_000)).toBe('Up for less than a minute')
  })
  it('formats notification ages', () => {
    const now = 1_000_000_000
    expect(ageLabel(now - 5_000, now)).toBe('now')
    expect(ageLabel(now - 5 * 60_000, now)).toBe('5m')
    expect(ageLabel(now - 2 * 3_600_000, now)).toBe('2h')
  })
})

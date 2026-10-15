import { describe, expect, it } from 'vitest'
import { nextState, shouldEnterRecovery } from './session'

describe('session lifecycle', () => {
  it('follows greeter → starting → active', () => {
    expect(nextState(nextState('greeter', 'authSuccess'), 'shellReady')).toBe('active')
  })
  it('resumes from suspend into the lock screen', () => {
    expect(nextState('suspending', 'resume')).toBe('locked')
  })
  it('cannot unlock from the greeter', () => {
    expect(nextState('greeter', 'unlock')).toBe('greeter')
  })
  it('enters recovery after 3 crashes in 60 s only', () => {
    expect(shouldEnterRecovery([0, 10_000, 50_000], 55_000)).toBe(true)
    expect(shouldEnterRecovery([0, 10_000, 50_000], 65_000)).toBe(false)
  })
})

import { policyLines } from './os'

describe('policyLines', () => {
  it('describes only what the policy sets', () => {
    expect(policyLines(null)).toEqual([])
    expect(policyLines({ version: 'v', update_ring: 'pilot', update_mode: null, maintenance_window: null, lock_timeout_max_s: 300, offline_access_days: null, usb_storage: 'block', bluetooth: false, app_allowlist_size: 0 }))
      .toEqual(['Updates: pilot ring', 'Screen locks after at most 5 min idle', 'USB storage is blocked', 'Bluetooth is turned off'])
  })
})

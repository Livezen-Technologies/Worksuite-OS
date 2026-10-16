import { describe, expect, it, vi } from 'vitest'
import { nextState, personName, requestLock, shouldEnterRecovery } from './session'

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

import { managedLabel } from './os'

describe('managedLabel', () => {
  const base = { agent: true, device: null, org_name: 'Livezen', server: null, last_check_in: null }
  it('hides the chip on unmanaged devices and shows the ring when set', () => {
    expect(managedLabel(null)).toBeNull()
    expect(managedLabel({ ...base, managed: false, policies: null })).toBeNull()
    expect(managedLabel({ ...base, managed: true, policies: null })).toBe('Managed')
    expect(managedLabel({ ...base, managed: true, policies: { version: 'v', update_ring: 'pilot', update_mode: null, maintenance_window: null, lock_timeout_max_s: null, offline_access_days: null, usb_storage: null, bluetooth: null, app_allowlist_size: 0 } })).toBe('Managed · pilot ring')
  })
})

describe('requestLock (one lock screen)', () => {
  it('shows no shell lock board when the system locker took the screen', async () => {
    const show = vi.fn()
    await requestLock(async () => true, show)
    expect(show).not.toHaveBeenCalled()
  })
  it('falls back to the shell lock board without a system locker', async () => {
    const show = vi.fn()
    await requestLock(async () => false, show)
    await requestLock(async () => { throw new Error('no logind') }, show)
    await requestLock(async () => undefined, show)
    expect(show).toHaveBeenCalledTimes(3)
  })
})

describe('personName (Start menu, first run)', () => {
  it('shows the full name when the account has one', () => expect(personName('ana', 'Ana Perera')).toBe('Ana Perera'))
  it('falls back to the bare login, capitalised', () => {
    expect(personName('ana')).toBe('Ana')
    expect(personName('ana@corp.lk', '  ')).toBe('Ana')
    expect(personName('CORP\\ana')).toBe('Ana')
  })
})

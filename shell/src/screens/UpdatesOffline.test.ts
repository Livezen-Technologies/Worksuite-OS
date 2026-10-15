import { describe, expect, it } from 'vitest'
import type { OsUpdateStatus } from '../lib/os'
import { cmpVersion, showsOffline } from './UpdatesOffline'

const S = (p: Partial<OsUpdateStatus>): OsUpdateStatus => ({ state: 'available', version: '1.1.2', installed: '1.1.0', release_id: 'r', mandatory: false, deadline: null, deferrals_left: null, reason: null, restart_at: null, last_check: 0, ...p })

describe('G14 offline / resume / emergency', () => {
  it('compares versions numerically', () => {
    expect(cmpVersion('1.1.10', '1.1.9')).toBeGreaterThan(0)
    expect(cmpVersion('1.1.0', '1.1')).toBe(0)
    expect(cmpVersion('1.0.9', '1.1.0')).toBeLessThan(0)
  })
  it('shows for an emergency release, a resumed or interrupted download, or a USB bundle', () => {
    expect(showsOffline(S({}), [])).toBe(false)
    expect(showsOffline(S({ critical: true }), [])).toBe(true)
    expect(showsOffline(S({ critical: true, version: '1.1.0' }), [])).toBe(false)
    expect(showsOffline(S({ state: 'installing', resumed: true }), [])).toBe(true)
    expect(showsOffline(S({ state: 'waiting', reason: 'download_interrupted' }), [])).toBe(true)
    expect(showsOffline(S({ state: 'up_to_date', version: null }), [{ handle: 'h', name: 'a.wsupdate', drive: 'USB' }])).toBe(true)
  })
  it('steps aside for restart and failure screens', () => {
    expect(showsOffline(S({ state: 'ready_to_restart', critical: true }), [{ handle: 'h', name: 'a.wsupdate', drive: 'USB' }])).toBe(false)
    expect(showsOffline(S({ state: 'failed', critical: true }), [])).toBe(false)
  })
})

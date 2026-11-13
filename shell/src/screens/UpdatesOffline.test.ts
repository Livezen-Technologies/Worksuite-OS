import { describe, expect, it } from 'vitest'
import type { OsUpdateStatus } from '../lib/os'
import { cmpVersion, showsOffline } from './UpdatesOffline'

const S = (p: Partial<OsUpdateStatus>): OsUpdateStatus => ({ state: 'available', version: '1.1.2', installed: '1.1.0', release_id: 'r', mandatory: false, deadline: null, deferrals_left: null, reason: null, restart_at: null, last_check: 0, ...p })

describe('G14 offline / resume / emergency', () => {
  it('compares versions numerically', () => {
    expect(cmpVersion('1.1.10', '1.1.9')).toBeGreaterThan(0)
    expect(cmpVersion('1.1.0', '1.1')).toBeGreaterThan(0)   // Debian order, as the service decides
    // Seen in a VM: an rc3 bundle on an rc1 system was shown as 'not newer'.
    expect(cmpVersion('1.0.0~rc3', '1.0.0~rc1')).toBeGreaterThan(0)
    expect(cmpVersion('1.0.0', '1.0.0~rc3')).toBeGreaterThan(0)
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
    // No internet: the online check failed, and a bundle on a USB drive is the way to update (found in a VM).
    expect(showsOffline(S({ state: 'failed', error: 'Can’t reach the update server.' } as never), [{ handle: 'h', name: 'a.wsupdate', drive: 'WSUPDATE' }])).toBe(true)
  })
})

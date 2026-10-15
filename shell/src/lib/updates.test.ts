import { describe, expect, it } from 'vitest'
import type { OsUpdateStatus } from './os'
import { START, compareVersions, heroView, needsAttention, restartOptions, track, updateJobProgress, whatsNew } from './updates'

const S = (p: Partial<OsUpdateStatus>): OsUpdateStatus => ({ state: 'waiting', version: '1.1', installed: '1.0', release_id: 'r', mandatory: false, deadline: null, deferrals_left: null, reason: 'waiting_for_user', restart_at: null, last_check: 0, ...p })

describe('update view', () => {
  it('offers install and later for an open release, not for a paused one', () => {
    expect(heroView(S({}), null)).toMatchObject({ title: 'WorkSuite OS 1.1 is available', primary: 'install', secondary: 'later' })
    expect(heroView(S({ deferrals_left: 0, mandatory: true }), null)).toMatchObject({ secondary: null, primary: 'install' })
    expect(heroView(S({ reason: 'paused' }), null)).toMatchObject({ primary: 'check', secondary: null })
  })
  it('shows real job progress while installing', () => {
    expect(heroView(S({ state: 'installing' }), { percent: 20, phase: 'downloading' })).toMatchObject({ title: 'Downloading WorkSuite OS 1.1', progress: { percent: 20 } })
    expect(heroView(S({ state: 'installing' }), { percent: 50, phase: 'applying' }).title).toBe('Installing WorkSuite OS 1.1')
    expect(heroView(S({ state: 'installing' }), null).progress).toBe('indeterminate')
  })
  it('ready to restart offers schedule and restart', () => {
    expect(heroView(S({ state: 'ready_to_restart', installed: '1.1' }), null)).toMatchObject({ primary: 'restart', secondary: 'schedule' })
  })
  it('attention badge', () => {
    expect(needsAttention(S({}))).toBe(true)
    expect(needsAttention(S({ state: 'installing' }))).toBe(false)
    expect(needsAttention(S({ reason: 'pulled' }))).toBe(false)
    expect(needsAttention(null)).toBe(false)
  })
  it('only update-job phases count as update progress', () => {
    expect(updateJobProgress({ job: 'j', kind: 'progress', percent: 120, phase: 'applying' })).toEqual({ percent: 100, phase: 'applying' })
    expect(updateJobProgress({ job: 'j', kind: 'progress', percent: 30, phase: 'installing' })).toBeNull()
  })
  it('tracks forced installs and failures seen during an install', () => {
    let t = track(START, S({ state: 'restart_pending' }), null)
    t = track(t, S({ state: 'installing' }), null)
    expect(t.forced).toBe(true)
    t = track(t, S({ state: 'failed', reason: 'dpkg error' }), { percent: 50, phase: 'applying' })
    expect(t).toMatchObject({ forced: false, failure: { reason: 'dpkg error', phase: 'applying', percent: 50, installed: '1.0' } })
    expect(track(START, S({ state: 'failed' }), null).failure).toBeNull()
  })
  it('whats new only after an upgrade', () => {
    expect(whatsNew(null, '1.1')).toBe(false)
    expect(whatsNew('1.0.9', '1.0.10')).toBe(true)
    expect(whatsNew('1.1', '1.1')).toBe(false)
    expect(compareVersions('1.0~rc1', '1.0')).toBeLessThan(0)
  })
  it('restart options: scheduling is disabled', () => {
    expect(restartOptions().filter((o) => o.disabled).map((o) => o.id)).toEqual(['scheduled'])
  })
})

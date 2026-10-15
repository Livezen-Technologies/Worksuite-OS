// Captive-portal state machine (WSOS-INT-001).
import { describe, expect, it } from 'vitest'
import { initialPortalState, parseConnectivity, portalNavAllowed, portalStep, type Connectivity, type PortalAction, type PortalState } from './connectivity'
import { systemBridge } from './system'

function run(events: (Connectivity | 'user_closed' | 'user_opened')[], killSwitch = false): PortalAction[][] {
  let s: PortalState = initialPortalState
  return events.map((e) => {
    const r = portalStep(s, e === 'user_closed' || e === 'user_opened' ? e : { connectivity: e, killSwitch })
    s = r.state
    return r.actions
  })
}

describe('connectivity', () => {
  it('parses nmcli output', () => {
    expect(parseConnectivity('portal\n')).toBe('portal')
    expect(parseConnectivity('FULL')).toBe('full')
    expect(parseConnectivity('weird')).toBe('unknown')
  })
  it('bridge reads nmcli networking connectivity', async () => {
    const b = systemBridge(async (_c, args) => ({ code: 0, stdout: args.join(' ') === '-t networking connectivity' ? 'portal\n' : '', stderr: '' }))
    expect(await b.connectivity()).toEqual({ available: true, value: 'portal' })
  })
  it('portal → notify + open once; full → close', () => {
    expect(run(['full', 'portal', 'portal', 'full', 'full'])).toEqual([[], ['notify_portal', 'open_window'], [], ['close_window', 'notify_signed_in'], []])
  })
  it('user closes; reopening from the notification works only while in portal', () => {
    expect(run(['portal', 'user_closed', 'portal', 'user_opened', 'user_opened'])).toEqual([['notify_portal', 'open_window'], [], [], ['open_window'], []])
    expect(run(['full', 'user_opened'])).toEqual([[], []])
  })
  it('a new portal episode after leaving the network notifies again', () => {
    expect(run(['portal', 'user_closed', 'none', 'portal'])).toEqual([['notify_portal', 'open_window'], [], [], ['notify_portal', 'open_window']])
  })
  it('with the kill switch loaded it explains instead of opening a window', () => {
    expect(run(['portal', 'portal', 'full'], true)).toEqual([['notify_blocked_by_killswitch'], [], []])
  })
  it('navigation allowlist', () => {
    expect(portalNavAllowed('http://portal.hotel/login')).toBe(true)
    expect(portalNavAllowed('https://x.example/a?b')).toBe(true)
    expect(portalNavAllowed('file:///etc/passwd')).toBe(false)
    expect(portalNavAllowed('javascript:alert(1)')).toBe(false)
    expect(portalNavAllowed('data:text/html,x')).toBe(false)
    expect(portalNavAllowed('https://u:p@x.example/')).toBe(false)
    expect(portalNavAllowed('not a url')).toBe(false)
  })
})

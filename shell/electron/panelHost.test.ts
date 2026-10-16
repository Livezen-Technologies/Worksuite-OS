import { describe, expect, it, vi } from 'vitest'
import { shellLift, taskViewHost } from './panelHost'

const ok = { ok: true as const, value: true as const }

function client(raise: (h: string, on: boolean) => Promise<{ ok: boolean }> = async () => ok) {
  return {
    windows: [{ handle: 'app', appId: 'firefox', title: 'Firefox', output: '', flags: 1 }, { handle: 'sh', appId: 'worksuite-shell', title: 'WorkSuite', output: '', flags: 0 }],
    workspaces: { supported: true, current: 1, count: 1, windows: {}, capture: false },
    captureOutput: vi.fn(async () => null),
    shellWindow: () => ({ handle: 'sh', appId: 'worksuite-shell', title: 'WorkSuite', output: '', flags: 0 }),
    setShellRaised: vi.fn(raise),
    activate: vi.fn(async () => ok),
  }
}

describe('Task View lifts the always-on-bottom shell over the apps', () => {
  it('lifts on open and puts the shell back below the apps on close', async () => {
    const c = client(), send = vi.fn()
    const tv = taskViewHost(c as never, send)
    await tv.open()
    expect(send).toHaveBeenCalledWith('ws:taskView', { capture: null, previous: 'app' })
    expect(c.setShellRaised).toHaveBeenLastCalledWith('sh', true)
    tv.state(true)
    tv.state(false)
    await new Promise((r) => setTimeout(r, 0))
    expect(c.setShellRaised).toHaveBeenLastCalledWith('sh', false)
    expect(c.activate).not.toHaveBeenCalled()
  })

  it('lowers again when Task View closed before the lift finished', async () => {
    let finish: () => void = () => undefined
    const c = client(async (_h, on) => { if (on) await new Promise<void>((r) => { finish = r }); return ok })
    const tv = taskViewHost(c as never, vi.fn())
    const opening = tv.open()
    await Promise.resolve(); await Promise.resolve()
    tv.state(true)
    tv.state(false)
    finish()
    await opening
    expect(c.setShellRaised.mock.calls).toEqual([['sh', true], ['sh', false]])
  })

  it('falls back to activating the shell when the bridge cannot lift it', async () => {
    const c = client(async () => ({ ok: false })), tv = taskViewHost(c as never, vi.fn())
    await tv.open()
    expect(c.activate).toHaveBeenCalledWith('sh')
    tv.state(false)
    await new Promise((r) => setTimeout(r, 0))
    expect(c.setShellRaised).toHaveBeenCalledTimes(1)
  })
})

describe('the shell is lifted over the apps only while something of its own is open', () => {
  it('lifts once for several reasons and lowers when the last one closes', async () => {
    const c = client(), lift = shellLift(c as never)
    await lift.set('overlay', true)
    await lift.set('taskview', true)
    expect(c.setShellRaised.mock.calls).toEqual([['sh', true]])
    await lift.set('overlay', false)
    expect(lift.lifted).toBe('sh')
    await lift.set('taskview', false)
    expect(c.setShellRaised.mock.calls).toEqual([['sh', true], ['sh', false]])
    expect(lift.lifted).toBe('')
  })

  it('quick open/close while a request is running ends in the last state', async () => {
    let finish: () => void = () => undefined
    const c = client(async (_h, on) => { if (on) await new Promise<void>((r) => { finish = r }); return ok })
    const lift = shellLift(c as never)
    const a = lift.set('overlay', true)
    const b = lift.set('overlay', false)
    const d = lift.set('overlay', true)
    const e = lift.set('overlay', false)
    finish()
    await Promise.all([a, b, d, e])
    expect(c.setShellRaised.mock.calls.at(-1)).toEqual(['sh', false])
    expect(lift.lifted).toBe('')
  })

  it('the overlay and Task View share one lift', async () => {
    const c = client(), lift = shellLift(c as never), tv = taskViewHost(c as never, vi.fn(), lift)
    await lift.set('overlay', true)
    await tv.open()
    tv.state(true)
    tv.state(false)
    await lift.set('overlay', true)
    expect(c.setShellRaised.mock.calls).toEqual([['sh', true]])
    await lift.set('overlay', false)
    expect(c.setShellRaised.mock.calls).toEqual([['sh', true], ['sh', false]])
  })
})

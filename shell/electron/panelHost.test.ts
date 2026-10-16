import { describe, expect, it, vi } from 'vitest'
import { taskViewHost } from './panelHost'

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
    await Promise.resolve()
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
    expect(c.setShellRaised).toHaveBeenCalledTimes(1)
  })
})

// @vitest-environment jsdom
// The shared Settings switch (#34): states, keyboard, failure feedback and accessibility.
import { act, useState } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import axe from 'axe-core'
import { afterEach, beforeAll, describe, expect, it } from 'vitest'
import { Switch, switchFailed } from './Dk'

const g = globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }
beforeAll(() => { g.IS_REACT_ACT_ENVIRONMENT = true })
let root: Root | null = null
let host: HTMLDivElement | null = null
afterEach(() => { act(() => root?.unmount()); host?.remove(); root = null; host = null })
async function render(el: React.ReactElement) {
  host = document.createElement('div')
  document.body.append(host)
  root = createRoot(host)
  await act(async () => { root!.render(el) })
  return host
}
const sw = () => host!.querySelector<HTMLButtonElement>('[role="switch"]')!

function Live({ result }: { result: () => Promise<unknown> }) {
  const [on, setOn] = useState(false)
  return <Switch label="Wi-Fi" checked={on} onChange={(v) => result().then((r) => { if (!switchFailed(r)) setOn(v); return r as never })} />
}

describe('Switch', () => {
  it('shows on and off in words and toggles from the keyboard (a real button)', async () => {
    await render(<Live result={async () => ({ ok: true })} />)
    expect(host!.textContent).toContain('Off')
    expect(sw().getAttribute('aria-checked')).toBe('false')
    expect(sw().tagName).toBe('BUTTON')   // Space and Enter press it natively
    sw().focus()
    expect(document.activeElement).toBe(sw())
    await act(async () => { sw().click() })
    await act(async () => { await Promise.resolve() })
    expect(sw().getAttribute('aria-checked')).toBe('true')
    expect(sw().dataset.state).toBe('on')
    expect(host!.textContent).toContain('On')
  })

  it('shows applying while the change runs, then an error when it fails', async () => {
    let finish: (v: unknown) => void = () => {}
    await render(<Live result={() => new Promise((r) => { finish = r })} />)
    await act(async () => { sw().click() })
    expect(sw().getAttribute('aria-busy')).toBe('true')
    expect(sw().dataset.state).toBe('loading')
    expect(host!.textContent).toContain('Applying…')
    await act(async () => { finish({ available: false, reason: 'nm_missing' }) })
    expect(sw().getAttribute('aria-checked')).toBe('false')
    const alert = host!.querySelector('[role="alert"]')!
    expect(alert.textContent).toContain('Couldn’t change this setting')
    expect(sw().getAttribute('aria-describedby')).toContain(alert.id)
  })

  it('explains why it is unavailable and cannot be changed', async () => {
    let calls = 0
    await render(<Switch label="Rotation lock" checked={false} unavailable="No rotation sensor" onChange={() => { calls++ }} />)
    expect(sw().disabled).toBe(false)   // still focusable, so the reason can be read
    expect(sw().getAttribute('aria-disabled')).toBe('true')
    expect(sw().dataset.state).toBe('unavailable')
    await act(async () => { sw().click() })
    expect(calls).toBe(0)
    expect(host!.textContent).toContain('No rotation sensor')
    expect(host!.textContent).toContain('Unavailable')
  })

  it('passes axe', async () => {
    await render(<div><Switch label="A" checked onChange={() => {}} /><Switch label="B" checked={false} disabled /><Switch label="C" checked={false} unavailable="Managed" /></div>)
    const res = await axe.run(host!, { rules: { 'color-contrast': { enabled: false } } })
    expect(res.violations.map((v) => v.id)).toEqual([])
  })

  it('treats failed bridge replies as failures', () => {
    expect(switchFailed({ ok: false, error: 'x' })).toBe(true)
    expect(switchFailed({ available: false, reason: 'x' })).toBe(true)
    expect(switchFailed(false)).toBe(true)
    expect(switchFailed(undefined)).toBe(false)
    expect(switchFailed({ ok: true })).toBe(false)
  })
})

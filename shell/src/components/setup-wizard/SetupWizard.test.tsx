// @vitest-environment jsdom
// The setup wizard on the real state machine (previewApi): every screen is the machine's state, answers and events
// go through the API, required answers block Continue, recovery offers only what the snapshot allows, and rollback
// always asks first.
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import SetupWizard from './SetupWizard'
import SetupGate from './SetupGate'
import InstallationLogViewer from './recovery/InstallationLogViewer'
import { previewApi, type SetupApi } from '../../lib/setupApi'
import { setLocale } from '../../i18n'

let host: HTMLDivElement
let root: Root
beforeEach(() => { setLocale('en'); host = document.createElement('div'); document.body.appendChild(host); root = createRoot(host) })
afterEach(() => { act(() => root.unmount()); host.remove() })

const flush = async (ms = 0) => { await act(async () => { await new Promise((r) => setTimeout(r, ms)) }) }
const until = async (pred: () => boolean, ms = 3000) => {
  const end = Date.now() + ms
  while (!pred()) { if (Date.now() > end) throw new Error(`timed out; screen: ${host.textContent?.slice(0, 300)}`); await flush(10) }
}
const heading = () => host.querySelector('h1')?.textContent ?? ''
const button = (name: string | RegExp) => [...host.querySelectorAll('button')].find((b) => (typeof name === 'string' ? b.textContent?.trim() === name : name.test(b.textContent ?? '')))
const click = async (name: string | RegExp) => { const b = button(name); if (!b) throw new Error(`no button ${name}; screen: ${host.textContent?.slice(0, 300)}`); await act(async () => { b.click() }); await flush(5) }
const input = async (label: string, value: string) => {
  const l = [...host.querySelectorAll('label')].find((x) => x.textContent?.startsWith(label))!
  const el = l.querySelector('input')!
  const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!
  await act(async () => { set.call(el, value); el.dispatchEvent(new Event('input', { bubbles: true })) }); await flush(5)
}

describe('SetupWizard', () => {
  it('walks first run from Welcome to done through the machine, blocking Continue on missing answers', async () => {
    const api = previewApi({ workMs: 5 })
    const sent = vi.spyOn(api, 'send')
    const done = vi.fn()
    act(() => root.render(<SetupWizard api={api} onDone={done} />))
    await until(() => heading() === 'Let’s set up your computer')
    await click('Get started')
    await until(() => heading() === 'Language and region')
    await click('Continue'); await until(() => heading() === 'Network')
    await click('Continue'); await until(() => heading() === 'How you’ll use it')
    // No account type yet: the machine refuses NEXT and the screen says why.
    await click('Continue')
    expect(heading()).toBe('How you’ll use it')
    expect(host.textContent).toContain('Choose or fill this in to continue.')
    await click(/For myself/)
    // First run: the installer already made the account and set up the disk, so no account, disk or encryption step.
    await click('Continue'); await until(() => heading() === 'Organization')
    await click('Continue'); await until(() => heading() === 'WorkSuite apps')
    const desktop = button(/^WorkSuite Desktop/)!
    expect(desktop.disabled).toBe(true)
    expect(desktop.getAttribute('aria-checked')).toBe('true')
    await click('Continue'); await until(() => heading() === 'More apps')
    await click('Continue'); await until(() => heading() === 'Assistant')
    await click('Continue'); await until(() => heading() === 'Review')
    expect(host.textContent).not.toContain('Encrypt the disk')
    expect(host.textContent).not.toContain('User name')
    await click('Continue')
    expect(heading()).toBe('Review') // not accepted yet
    await act(async () => { (host.querySelector('input[type="checkbox"]') as HTMLInputElement).click() }); await flush(5)
    await click('Continue')
    await until(() => heading() === 'All set' || heading() === 'Your computer is ready', 5000)
    await click('Start using WorkSuite OS')
    expect(done).toHaveBeenCalled()
    // The UI only ever sent events a person may send.
    const types = new Set(sent.mock.calls.map(([e]) => e.type))
    for (const t of ['WORK_DONE', 'WORK_FAILED', 'ROLLBACK_DONE', 'NETWORK_RESTORED']) expect(types.has(t as never)).toBe(false)
  })

  it('asks for the account and encryption when installing (not on first run)', async () => {
    const api = previewApi({ workMs: 5, mode: 'install' })
    act(() => root.render(<SetupWizard api={api} onDone={() => {}} />))
    await until(() => heading() === 'Let’s set up your computer')
    await click('Get started'); await until(() => heading() === 'Language and region')
    await click('Continue'); await until(() => heading() === 'Network')
    await click('Continue'); await until(() => heading() === 'How you’ll use it')
    await click(/For myself/)
    await click('Continue'); await until(() => heading() === 'Your account')
    await input('User name', 'Nimal')
    expect((host.querySelector('input[autocomplete="username"]') as HTMLInputElement).value).toBe('nimal')
  })

  it('opens recovery after a failed install: retry offered, resume explained, rollback confirmed first', async () => {
    const api = previewApi({ scenario: 'recovery', workMs: 5 })
    const sent = vi.spyOn(api, 'send')
    act(() => root.render(<SetupWizard api={api} onDone={() => {}} />))
    await until(() => heading() === 'Setup didn’t finish')
    expect(host.textContent).toContain('It stopped at “Installing apps”.')
    expect(host.textContent).toContain('download interrupted')
    expect(button(/^Resume/)!.disabled).toBe(true)
    expect(button(/^Resume/)!.textContent).toContain('This step runs on its own')
    expect(button(/^Retry failed step/)!.disabled).toBe(false)
    // No recovery environment handler: the option is not offered at all.
    expect(button(/Open recovery environment/)).toBeUndefined()
    await click(/Roll back changes/)
    expect(host.querySelector('[role="dialog"]')?.textContent).toContain('Remove the packages this setup installed')
    expect(sent.mock.calls.some(([e]) => e.type === 'ROLLBACK')).toBe(false)
    await click('Keep things as they are')
    expect(host.querySelector('[role="dialog"]')).toBeNull()
    await click(/Roll back changes/)
    await click('Roll back')
    await until(() => heading() === 'Changes were rolled back')
    expect(sent.mock.calls.filter(([e]) => e.type === 'ROLLBACK')).toHaveLength(1)
  })

  it('shows the service error instead of a blank screen when setup is unavailable', async () => {
    const api: SetupApi = { ...previewApi(), state: async () => ({ ok: false, error: 'service_unavailable' }) }
    act(() => root.render(<SetupWizard api={api} onDone={() => {}} />))
    await until(() => !!host.querySelector('[role="alert"]'))
    expect(host.textContent).toContain('The setup service isn’t running')
  })
})

describe('app installation progress', () => {
  it('shows each app with its state while apps install (GetApps)', async () => {
    const base = previewApi()
    const api: SetupApi = {
      ...base,
      state: async () => ({ ok: true, value: { state: 'INSTALLING_APPLICATIONS', mode: 'firstRun', resumeTo: null, answers: {}, lastError: null, attempts: 1, checkpoints: [], startReason: '', uiActions: [] } }),
      apps: async () => ({ ok: true, value: [
        { id: 'worksuite-desktop', name: 'WorkSuite Desktop', required: true, state: 'installed', attempts: 1, error: null },
        { id: 'worksuite-pos', name: 'WorkSuite POS', required: false, state: 'installing', attempts: 2, error: null, progress: 40 },
        { id: 'vlc', name: 'VLC', required: false, state: 'queued', attempts: 0, error: null },
        { id: 'gimp', name: 'GIMP', required: false, state: 'skipped', attempts: 0, error: null },
        { id: 'worksuite-desk', name: 'WorkSuite Desk', required: false, state: 'failed', attempts: 3, error: 'E: Connection reset' },
      ] }),
    }
    act(() => root.render(<SetupWizard api={api} onDone={() => {}} />))
    await until(() => !!host.querySelector('ul[aria-label="Your apps"] li'))
    const rows = [...host.querySelectorAll('ul[aria-label="Your apps"] li')].map((li) => [li.getAttribute('data-state'), li.textContent])
    // Skipped apps are not shown; each row has the app's name and state, the running one its percentage.
    expect(rows).toEqual([
      ['installed', 'WorkSuite DesktopInstalled'], ['installing', 'POSInstalling… · 40%'],
      ['queued', 'VLCInstalls when you’re online'], ['failed', 'DeskCouldn’t installE: Connection reset'],
    ])
    expect(host.textContent).toContain('1 of 4 apps ready')
    // Overall: settled apps count in full, the running one by its progress: (100 + 40 + 100 + 100) / 4.
    expect(host.querySelector('[role="progressbar"]')!.getAttribute('aria-valuenow')).toBe('85')
    expect(host.querySelector('[title="E: Connection reset"]')).not.toBeNull()
  })
})

describe('SetupGate', () => {
  const fallback = <p>first-run-screens</p>
  it('keeps the first-run screens without a setup service, when it errors, and once setup has finished', async () => {
    act(() => root.render(<SetupGate api={null} fallback={fallback} onDone={() => {}} />))
    expect(host.textContent).toBe('first-run-screens')
    const failing: SetupApi = { ...previewApi(), state: async () => ({ ok: false, error: 'service_unavailable' }) }
    act(() => root.render(<SetupGate key="b" api={failing} fallback={fallback} onDone={() => {}} />))
    await until(() => host.textContent === 'first-run-screens')
    const finished: SetupApi = { ...previewApi(), state: async () => ({ ok: true, value: { state: 'SETUP_COMPLETED' } as never }) }
    act(() => root.render(<SetupGate key="c" api={finished} fallback={fallback} onDone={() => {}} />))
    await until(() => host.textContent === 'first-run-screens')
  })
  it('opens the wizard while setup is unfinished', async () => {
    act(() => root.render(<SetupGate api={previewApi({ workMs: 5 })} fallback={fallback} onDone={() => {}} />))
    await until(() => heading() === 'Let’s set up your computer')
  })
})

describe('InstallationLogViewer', () => {
  it('filters to problem lines and reports a log that cannot be read', async () => {
    const onClose = vi.fn()
    act(() => root.render(<InstallationLogViewer load={async () => ({ ok: true, value: 'run queueInstalls\nqueueInstalls failed: reset\nall good' })} onClose={onClose} />))
    await flush(5)
    expect(host.querySelector('pre')?.textContent).toContain('all good')
    await act(async () => { (host.querySelector('input[type="checkbox"]') as HTMLInputElement).click() }); await flush(5)
    expect(host.querySelector('pre')?.textContent).toBe('queueInstalls failed: reset')
    await act(async () => { host.querySelector('[role="dialog"]')!.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })) })
    expect(onClose).toHaveBeenCalled()
    act(() => root.render(<InstallationLogViewer key="x" load={async () => ({ ok: false, error: 'failed' })} onClose={onClose} />))
    await flush(5)
    expect(host.querySelector('[role="alert"]')?.textContent).toBe('The log couldn’t be read.')
  })
})

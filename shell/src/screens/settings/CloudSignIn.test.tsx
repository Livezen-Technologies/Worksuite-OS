// @vitest-environment jsdom
// Settings › Users › WorkSuite account (#46): the sign-in runs through the credentials broker, with status, errors,
// retry, cancel, sign in again and sign-out.
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { CloudAccounts } from '../Settings'
import { signInUrl } from './CloudSignIn'
import { defaultSignInTarget, os, type CloudAccount, type DeviceInfo } from '../../lib/os'
import { requestCloudSignIn } from '../../lib/settingsNav'

const g = globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }
beforeAll(() => { g.IS_REACT_ACT_ENVIRONMENT = true })
let root: Root | null = null
let host: HTMLDivElement | null = null
afterEach(() => { act(() => root?.unmount()); host?.remove(); document.body.innerHTML = ''; root = null; host = null; vi.restoreAllMocks() })

const flush = async () => { for (let i = 0; i < 4; i++) await act(async () => { await Promise.resolve() }) }
async function render(el: React.ReactElement) {
  host = document.createElement('div'); document.body.append(host); root = createRoot(host)
  await act(async () => { root!.render(el) })
  await flush()
}
const button = (name: string) => Array.from(document.querySelectorAll('button')).find((b) => b.textContent === name || (b.getAttribute('role') === 'radio' && b.textContent?.startsWith(name))) as HTMLButtonElement
const click = async (b: HTMLElement) => { await act(async () => { b.click() }); await flush() }
const text = () => document.body.textContent ?? ''
const unmanaged = { agent: false, managed: false, org_name: null, server: null, last_check_in: null, policies: null } as DeviceInfo
const acct: CloudAccount = { id: 'auth.example.com:u-1', name: 'Kamal Perera', server_url: 'https://work.example.com', state: 'signed_in' }

function setup(accounts: CloudAccount[], info: DeviceInfo = unmanaged) {
  let list = accounts
  vi.spyOn(os, 'cloudAccounts').mockImplementation(async () => ({ ok: true, value: list }))
  vi.spyOn(os, 'deviceInfo').mockResolvedValue(info)
  return { set: (a: CloudAccount[]) => { list = a } }
}

describe('default sign-in target', () => {
  it('prefers the enrolled or provisioned server, then an earlier sign-in, then WorkSuite Cloud', () => {
    expect(defaultSignInTarget({ server: 'https://work.example.com' }, [])).toEqual({ mode: 'enterprise', server: 'https://work.example.com' })
    expect(defaultSignInTarget({ server: null, provisioning: { require_enrollment: true, server: 'https://p.example.com' } }, [])).toEqual({ mode: 'enterprise', server: 'https://p.example.com' })
    expect(defaultSignInTarget({ server: 'http://plain.example.com' }, [{ server_url: 'https://old.example.com' }])).toEqual({ mode: 'enterprise', server: 'https://old.example.com' })
    expect(defaultSignInTarget(null, [{ server_url: 'https://worksuitecloud.com' }])).toEqual({ mode: 'personal', server: '' })
  })
  it('refuses an empty or plain-http enterprise address before the broker sees it', () => {
    expect(signInUrl('enterprise', ' ')).toHaveProperty('error')
    expect(signInUrl('enterprise', 'http://work.example.com')).toHaveProperty('error')
    expect(signInUrl('enterprise', 'work.example.com')).toEqual({ url: 'https://work.example.com' })
    expect(signInUrl('personal', '')).toEqual({ url: 'https://worksuitecloud.com' })
    // #55: no spaces, no credentials, a real host name
    expect(signInUrl('enterprise', 'work example.com')).toHaveProperty('error')
    expect(signInUrl('enterprise', 'https://me:pw@work.example.com')).toHaveProperty('error')
    expect(signInUrl('enterprise', 'https://-bad-.example.com')).toHaveProperty('error')
    expect(signInUrl('enterprise', 'https://work.example.com/')).toEqual({ url: 'https://work.example.com' })
  })
})

describe('WorkSuite account', () => {
  it('signs in through the broker and shows the connected account', async () => {
    const s = setup([])
    const signIn = vi.spyOn(os, 'cloudSignIn').mockImplementation(async () => { s.set([acct]); return { ok: true, value: acct } })
    await render(<CloudAccounts />)
    expect(text()).toContain('Not signed in')
    await click(button('Enterprise'))
    const input = document.querySelector('input') as HTMLInputElement
    await act(async () => { Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, 'work.example.com'); input.dispatchEvent(new Event('input', { bubbles: true })) })
    await click(button('Sign in'))
    expect(signIn).toHaveBeenCalledWith('https://work.example.com', 'enterprise')
    expect(text()).toContain('Connected as Kamal Perera.')
    expect(text()).toContain('Kamal Perera')
    expect(text()).toContain('Connected')
    expect(button('Sign out')).toBeTruthy()
  })

  it('shows a clear error with Try again, which retries', async () => {
    setup([])
    const signIn = vi.spyOn(os, 'cloudSignIn').mockResolvedValueOnce({ ok: false, error: 'sign_in_timeout' }).mockResolvedValueOnce({ ok: true, value: acct })
    await render(<CloudAccounts />)
    await click(button('Sign in'))
    expect(signIn).toHaveBeenCalledWith('https://worksuitecloud.com', 'personal')
    expect(document.querySelector('[role="alert"]')?.textContent).toContain('wasn’t finished in the browser')
    await click(button('Try again'))
    expect(signIn).toHaveBeenCalledTimes(2)
  })

  it('#55: checks the server first and says why it failed, without opening the browser', async () => {
    setup([])
    const check = vi.spyOn(os, 'cloudCheckServer').mockResolvedValueOnce({ ok: false, error: 'dns_failed' })
      .mockResolvedValueOnce({ ok: false, error: 'tls_failed' }).mockResolvedValueOnce({ ok: true, value: { server_url: 'https://work.example.com', issuer: 'id.example.com' } })
    const signIn = vi.spyOn(os, 'cloudSignIn').mockResolvedValue({ ok: true, value: acct })
    await render(<CloudAccounts />)
    await click(button('Enterprise'))
    const input = document.querySelector('input') as HTMLInputElement
    await act(async () => { Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, 'work.example.com'); input.dispatchEvent(new Event('input', { bubbles: true })) })
    await click(button('Sign in'))
    expect(check).toHaveBeenCalledWith('https://work.example.com')
    expect(signIn).not.toHaveBeenCalled()
    expect(document.querySelector('[role="alert"]')?.textContent).toContain('Couldn’t find that server')
    await click(button('Try again'))
    expect(document.querySelector('[role="alert"]')?.textContent).toContain('certificate isn’t trusted')
    await click(button('Try again'))
    expect(signIn).toHaveBeenCalledWith('https://work.example.com', 'enterprise')
  })
  it('#55: shows the checking step while the server is checked', async () => {
    setup([])
    let done: (v: { ok: false; error: string }) => void = () => {}
    vi.spyOn(os, 'cloudCheckServer').mockImplementation(() => new Promise((r) => { done = r }))
    await render(<CloudAccounts />)
    await click(button('Sign in'))
    expect(document.querySelector('[role="status"]')?.textContent).toContain('Checking worksuitecloud.com')
    await act(async () => { done({ ok: false, error: 'unreachable' }) }); await flush()
    expect(document.querySelector('[role="alert"]')?.textContent).toContain('can’t be reached')
  })
  it('Cancel while the browser is open stops the broker sign-in quietly', async () => {
    setup([])
    let finish: (v: { ok: false; error: string }) => void = () => {}
    vi.spyOn(os, 'cloudSignIn').mockImplementation(() => new Promise((r) => { finish = r }))
    const cancel = vi.spyOn(os, 'cloudSignInCancel').mockImplementation(async () => { finish({ ok: false, error: 'sign_in_cancelled' }); return { ok: true, value: true } })
    await render(<CloudAccounts />)
    await click(button('Sign in'))
    expect(text()).toContain('Finish signing in in your browser')
    await click(button('Cancel'))
    expect(cancel).toHaveBeenCalled()
    expect(document.querySelector('[role="alert"]')).toBeNull()
    expect(button('Sign in')).toBeTruthy()
  })

  it('the desktop’s Sign in starts the flow at once with the enrolled server', async () => {
    setup([], { ...unmanaged, managed: true, server: 'https://work.example.com' })
    const signIn = vi.spyOn(os, 'cloudSignIn').mockImplementation(() => new Promise(() => {}))
    requestCloudSignIn()
    await render(<CloudAccounts />)
    expect(signIn).toHaveBeenCalledWith('https://work.example.com', 'enterprise')
  })

  it('a refused refresh token offers Sign in again to the same server', async () => {
    setup([{ ...acct, state: 'refresh_failed' }])
    const signIn = vi.spyOn(os, 'cloudSignIn').mockResolvedValue({ ok: true, value: acct })
    await render(<CloudAccounts />)
    expect(text()).toContain('Sign-in needed')
    await click(button('Sign in again'))
    await click(button('Sign in again'))
    expect(signIn).toHaveBeenCalledWith('https://work.example.com', 'enterprise')
  })

  it('signs out after checking for unsent changes', async () => {
    const s = setup([acct])
    vi.spyOn(os, 'syncUnsent').mockResolvedValue({ ok: true, value: 0 })
    const out = vi.spyOn(os, 'cloudSignOut').mockImplementation(async () => { s.set([]); return { ok: true, value: { exported: null } } })
    await render(<CloudAccounts />)
    await click(button('Sign out'))
    expect(out).toHaveBeenCalledWith(acct.id, 'none')
    expect(text()).toContain('Signed out.')
    expect(text()).toContain('Not signed in')
  })
})

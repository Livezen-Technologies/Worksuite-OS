import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { signinHost, signinMethods, signinPolicy, type Runner } from './signin'

function paths(files: { methods?: string; policy?: string; faillock?: string }) {
  const d = mkdtempSync(path.join(tmpdir(), 'ws-signin-'))
  const p = { methods: path.join(d, 'methods.json'), policy: path.join(d, 'policy.conf'), faillock: path.join(d, 'faillock.conf'), socket: path.join(d, 'sock') }
  if (files.methods) writeFileSync(p.methods, files.methods)
  if (files.policy) writeFileSync(p.policy, files.policy)
  if (files.faillock) writeFileSync(p.faillock, files.faillock)
  return p
}

describe('sign-in methods (electron/signin.ts)', () => {
  it('reads the public index and the policy, with password as the fallback default', () => {
    const p = paths({ methods: JSON.stringify({ users: { kim: { pin: true, keys: [{ id: 'abcdef0123456789', name: 'YubiKey', added: 5 }], default: 'key' } } }), policy: 'ALLOW_PIN=1\nPIN_MIN_LENGTH=8\n', faillock: 'deny = 4\n' })
    expect(signinMethods('kim', p)).toEqual({ available: true, value: { pin: true, keys: [{ id: 'abcdef0123456789', name: 'YubiKey', added: 5 }], default: 'key', allow_pin: true, pin_min_length: 8, pin_max_length: 12, attempt_limit: 2 } })
    expect(signinMethods('ann', p)).toMatchObject({ value: { pin: false, keys: [], default: 'password' } })
  })
  it('keeps the PIN limit below faillock and clamps the minimum length', () => {
    expect(signinPolicy(paths({ policy: 'ALLOW_PIN=0\nPIN_MIN_LENGTH=2\n', faillock: 'deny=10' }))).toEqual({ allow_pin: false, pin_min_length: 4, pin_max_length: 12, attempt_limit: 5 })
    expect(signinPolicy(paths({ faillock: 'deny=3' })).attempt_limit).toBe(1)
  })
  it('does not trust a default the user has not set up', () => {
    const p = paths({ methods: JSON.stringify({ users: { kim: { pin: false, keys: [], default: 'pin' } } }) })
    expect(signinMethods('kim', p)).toMatchObject({ value: { default: 'password' } })
  })
  it('sends the PIN on stdin only, with fixed arguments', async () => {
    const calls: { args: string[]; stdin: string }[] = []
    const run: Runner = async (args, stdin) => { calls.push({ args, stdin }); return { status: 0, out: '{"ok": true}\n' } }
    const h = signinHost(run, paths({}))
    expect(await h.pinSet('482915')).toEqual({ ok: true })
    expect(calls[0]).toEqual({ args: ['pin-set'], stdin: '482915\n' })
    expect(calls.flatMap((c) => c.args).join(' ')).not.toContain('482915')
  })
  it('refuses non-digit PINs and bad key ids before running anything', async () => {
    let ran = 0
    const h = signinHost(async () => { ran++; return { status: 0, out: '{"ok":true}' } }, paths({}))
    expect(await h.pinSet('12ab56')).toEqual({ ok: false, error: 'digits_only' })
    expect(await h.pinSet('123456\n--x')).toEqual({ ok: false, error: 'digits_only' })
    expect(await h.keyRemove('../etc')).toEqual({ ok: false, error: 'bad_request' })
    expect(ran).toBe(0)
  })
  it('maps pkexec dismissal and helper errors', async () => {
    expect(await signinHost(async () => ({ status: 126, out: '' }), paths({})).pinRemove()).toEqual({ ok: false, error: 'auth_cancelled' })
    expect(await signinHost(async () => ({ status: 1, out: '{"ok":false,"error":"too_simple"}' }), paths({})).pinSet('123456')).toEqual({ ok: false, error: 'too_simple' })
    expect(await signinHost(async () => ({ status: 1, out: '{"ok":false,"error":"<script>"}' }), paths({})).pinRemove()).toEqual({ ok: false, error: 'failed' })
  })
  it('names a key with a trimmed, bounded name', async () => {
    let args: string[] = []
    await signinHost(async (a) => { args = a; return { status: 0, out: '{"ok":true,"id":"0123456789abcdef"}' } }, paths({})).keyAdd('  My   key ' + 'x'.repeat(100))
    expect(args[0]).toBe('key-add')
    expect(args[2].length).toBeLessThanOrEqual(60)
    expect(args[2].startsWith('My key x')).toBe(true)
  })
})

describe('lk.worksuite.SignIn1 calls (WSOS-ARC-002)', () => {
  it('maps each change to its named method; the PIN is an argument, not argv', async () => {
    const { busCall } = await import('./signin')
    expect(busCall(['pin-set'], '123456\n')).toEqual({ member: 'SetPin', body: ['123456'] })
    expect(busCall(['pin-remove'], '')).toEqual({ member: 'RemovePin', body: [] })
    expect(busCall(['key-add', '--name', 'YubiKey'], '')).toEqual({ member: 'AddKey', body: ['YubiKey'] })
    expect(busCall(['key-remove', '--id', '0123456789abcdef'], '')).toEqual({ member: 'RemoveKey', body: ['0123456789abcdef'] })
    expect(busCall(['serve'], '')).toBeNull()
  })
})

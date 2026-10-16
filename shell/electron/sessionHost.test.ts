// electron/sessionHost.ts: inhibitors, forced power, crashed apps, administrator check, diagnostics IPC.
import { describe, expect, it, vi } from 'vitest'
import { COREDUMP_MESSAGE_ID, CRASH_JOURNAL_ARGS, appIdFromScope, blockingInhibitors, clampLines, crashDeduper, crashFromJournal, forcePower, isAdminUser, listInhibitors, pkexecError, powerArgs, startSessionHost } from './sessionHost'
import type { DesktopEntry } from './xdg'

const app = (id: string, name: string, exec: string): DesktopEntry => ({ id, name, exec, generic_name: null, comment: null, icon: null, categories: [], keywords: [], mime_types: [] })
const APPS = [app('org.gnome.TextEditor', 'Text Editor', 'gnome-text-editor %U'), app('firefox-esr', 'Firefox', '/usr/lib/firefox-esr/firefox-esr %u')]

describe('inhibitors', () => {
  const inh = [
    { what: 'shutdown:sleep', who: 'Docs', why: 'Unsaved changes', mode: 'block', uid: 1000, pid: 10 },
    { what: 'sleep', who: 'NetworkManager', why: 'NetworkManager needs to turn off networks', mode: 'delay', uid: 0, pid: 2 },
    { what: 'shutdown', who: 'Updates', why: 'Installing updates', mode: 'delay', uid: 0, pid: 3 },
    { what: 'handle-lid-switch', who: 'labwc', why: '', mode: 'block', uid: 1000, pid: 4 },
  ]
  it('only blocking shutdown inhibitors stop shutdown and restart; sign-out has none', () => {
    expect(blockingInhibitors(inh, 'shutdown').map((i) => i.who)).toEqual(['Docs'])
    expect(blockingInhibitors(inh, 'restart').map((i) => i.who)).toEqual(['Docs'])
    expect(blockingInhibitors(inh, 'logout')).toEqual([])
  })
  it('reads logind over D-Bus', async () => {
    const disconnect = vi.fn()
    const bus = { disconnect, getProxyObject: async () => ({ getInterface: () => ({ ListInhibitors: async () => [['shutdown', 'Docs', 'Unsaved', 'block', 1000, 42]] }) }) }
    expect(await listInhibitors(bus)).toEqual([{ what: 'shutdown', who: 'Docs', why: 'Unsaved', mode: 'block', uid: 1000, pid: 42 }])
    expect(disconnect).toHaveBeenCalled()
  })
  it('forced power skips inhibitors; sleep is never forced', () => {
    expect(powerArgs('shutdown', false)).toEqual(['poweroff'])
    expect(powerArgs('shutdown', true)).toEqual(['poweroff', '--check-inhibitors=no'])
    expect(powerArgs('restart', true)).toEqual(['reboot', '--check-inhibitors=no'])
    expect(powerArgs('suspend', true)).toEqual(['suspend'])
    expect(powerArgs('rm -rf', true)).toBeNull()
  })
})

describe('crashed apps', () => {
  it('watches coredumps in the user journal', () => {
    expect(CRASH_JOURNAL_ARGS).toContain(`MESSAGE_ID=${COREDUMP_MESSAGE_ID}`)
    expect(CRASH_JOURNAL_ARGS.slice(0, 2)).toEqual(['--user', '-f'])
  })
  it('finds the app from its scope, else from the executable', () => {
    expect(appIdFromScope('app-worksuite-org.gnome.TextEditor-1a2b3c4d.scope')).toBe('org.gnome.TextEditor')
    expect(appIdFromScope('app-worksuite-firefox-esr-deadbeef.scope')).toBe('firefox-esr')
    expect(appIdFromScope('worksuite-shell.service')).toBeNull()
    const c = crashFromJournal({ COREDUMP_USER_UNIT: 'app-worksuite-org.gnome.TextEditor-1a2b3c4d.scope', COREDUMP_COMM: 'gnome-text-edit', COREDUMP_EXE: '/usr/bin/gnome-text-editor', COREDUMP_PID: '4242', COREDUMP_SIGNAL_NAME: 'SIGSEGV' }, APPS, 5)
    expect(c).toEqual({ appId: 'org.gnome.TextEditor', name: 'Text Editor', at: 5, details: expect.stringContaining('Signal: SIGSEGV') })
    expect(c!.details).toContain('/usr/bin/gnome-text-editor')
    const f = crashFromJournal({ COREDUMP_USER_UNIT: 'app-firefox-esr-123.scope', COREDUMP_COMM: 'firefox-esr', COREDUMP_EXE: '/usr/lib/firefox-esr/firefox-esr' }, APPS)
    expect(f?.appId).toBe('firefox-esr')
    expect(f?.name).toBe('Firefox')
  })
  it('ignores the shell itself and background services', () => {
    expect(crashFromJournal({ COREDUMP_USER_UNIT: 'worksuite-shell.service', COREDUMP_EXE: '/usr/lib/worksuite/shell/worksuite-shell' }, APPS)).toBeNull()
    expect(crashFromJournal({ COREDUMP_USER_UNIT: 'pipewire.service', COREDUMP_EXE: '/usr/bin/pipewire', COREDUMP_COMM: 'pipewire' }, APPS)).toBeNull()
  })
  it('a crash loop shows one dialog', () => {
    const fresh = crashDeduper(15_000)
    const c = { appId: 'x', name: 'X', at: 1000, details: '' }
    expect(fresh(c)).toBe(true)
    expect(fresh({ ...c, at: 5000 })).toBe(false)
    expect(fresh({ ...c, at: 30_000 })).toBe(true)
  })
})

describe('administrators and diagnostics', () => {
  const group = 'root:x:0:\nsudo:x:27:nimali,kamal\nadm:x:4:syslog\nusers:x:100:ayesha'
  it('admin = member of sudo, admin or wheel', () => {
    expect(isAdminUser('nimali', group)).toBe(true)
    expect(isAdminUser('ayesha', group)).toBe(false)
    expect(isAdminUser('syslog', group)).toBe(false)
  })
  it('line counts are bounded numbers; pkexec refusals are named', () => {
    expect(clampLines('50')).toBe(50)
    expect(clampLines('999999')).toBe(5000)
    expect(clampLines('0')).toBe(1)
    expect(clampLines('5; rm -rf /')).toBe(500)
    expect(pkexecError(126)).toBe('auth_cancelled')
    expect(pkexecError(127)).toBe('not_authorized')
  })
  it('system logs and boot details go through pkexec and the helper, with fixed arguments', async () => {
    const handlers = new Map<string, (...a: string[]) => unknown>()
    const exec = vi.fn(async (cmd: string, args: string[]) => ({ code: cmd === 'pkexec' && args.includes('previous') ? 126 : 0, stdout: 'log line\n', stderr: '' }))
    startSessionHost((c, fn) => handlers.set(c, fn), () => {}, { apps: () => [], user: 'nimali', readGroup: () => group, exec, launch: () => {}, watch: false })
    expect(await handlers.get('ws:isAdmin')!()).toBe(true)
    expect(await handlers.get('ws:systemJournal')!('boot', '100')).toEqual({ ok: true, value: 'log line\n' })
    expect(exec).toHaveBeenLastCalledWith('pkexec', ['/usr/lib/worksuite/worksuite-diagnostics', 'journal', 'boot', '100'])
    expect(await handlers.get('ws:systemJournal')!('previous', '100')).toEqual({ ok: false, error: 'auth_cancelled' })
    expect(await handlers.get('ws:systemJournal')!('/etc/shadow', '1')).toEqual({ ok: false, error: 'invalid_argument' })
    expect(await handlers.get('ws:sessionJournal')!('20')).toEqual({ ok: true, value: 'log line\n' })
    expect(exec).toHaveBeenLastCalledWith('journalctl', ['--user', '-b', '0', '-o', 'short-iso', '-n', '20', '--no-pager', '-q'])
    expect(await handlers.get('ws:bootDetails')!('on')).toEqual({ ok: true, value: false })
    expect(exec).toHaveBeenLastCalledWith('pkexec', ['/usr/lib/worksuite/worksuite-diagnostics', 'boot-details', 'on'])
    expect(await handlers.get('ws:bootDetails')!('rm')).toEqual({ ok: false, error: 'invalid_argument' })
    expect(await handlers.get('ws:powerForce')!('shutdown')).toEqual({ ok: true, value: true })
    expect(exec).toHaveBeenLastCalledWith('systemctl', ['poweroff', '--check-inhibitors=no', '--no-ask-password'])
  })
  it('"Restart anyway" asks at most once: logind without interaction first, then one prompt for the root helper', async () => {
    const calls: string[][] = []
    const run = (codes: number[]) => { let i = 0; return async (cmd: string, args: string[]) => { calls.push([cmd, ...args]); return { code: codes[i++] ?? 0, stdout: '', stderr: '' } } }
    expect(await forcePower(run([0]), 'restart')).toEqual({ ok: true, value: true })   // no admin needed: no prompt
    expect(calls).toEqual([['systemctl', 'reboot', '--check-inhibitors=no', '--no-ask-password']])
    calls.length = 0
    expect(await forcePower(run([1, 0]), 'shutdown')).toEqual({ ok: true, value: true })
    expect(calls).toEqual([['systemctl', 'poweroff', '--check-inhibitors=no', '--no-ask-password'], ['pkexec', '/usr/lib/worksuite/worksuite-power-force', 'poweroff']])
    expect(await forcePower(run([1, 126]), 'restart')).toEqual({ ok: false, error: 'auth_cancelled' })
    expect(await forcePower(run([1, 1]), 'restart')).toEqual({ ok: false, error: 'not_authorized' })
    expect(await forcePower(run([]), 'suspend')).toEqual({ ok: false, error: 'invalid_argument' })
  })
  it('the overlay state goes to every display', async () => {
    const handlers = new Map<string, (...a: string[]) => unknown>()
    const broadcast = vi.fn()
    startSessionHost((c, fn) => handlers.set(c, fn), broadcast, { apps: () => [], user: 'x', readGroup: () => '', exec: async () => ({ code: 0, stdout: '', stderr: '' }), launch: () => {}, watch: false })
    expect(handlers.get('ws:sessionEndState')!(JSON.stringify({ action: 'shutdown', phase: 'closing', progress: 0.4 }))).toBe(true)
    expect(broadcast).toHaveBeenCalledWith('ws:sessionEnd', { action: 'shutdown', phase: 'closing', progress: 0.4 })
    expect(handlers.get('ws:sessionEndState')!('{nope')).toBe(false)
  })
})

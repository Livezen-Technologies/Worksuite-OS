// Shell-rendered polkit agent (WSOS-INT-010): identity resolution, the helper conversation, retries, the prompt
// queue, and the AuthenticationAgent interface on a private D-Bus bus with a fake polkitd.
import { spawn, spawnSync, type ChildProcess } from 'node:child_process'
import dbus from 'dbus-next'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { AGENT_PATH, MAX_TRIES, accountsFor, authenticate, converse, describeRequest, exportAgent, parseIdentities, type AgentUi, type HelperIo } from './polkit'
import { promptQueue } from './polkitMode'

const { Message, Variant } = dbus
const PASSWD = 'root:x:0:0::/root:/bin/sh\nalice:x:1000:1000::/home/alice:/bin/bash\nbob:x:1001:1001::/home/bob:/bin/bash\ncarol:x:1002:27::/home/carol:/bin/bash\n'
const GROUP = 'root:x:0:\nsudo:x:27:alice,ghost\nbob:x:1001:\n'

/** Fake helper: plays back `script`, records what the agent wrote. */
function fakeHelper(script: string[], answer: (written: string[]) => string[] = () => []) {
  const written: string[] = []
  let lineCb: (l: string) => void = () => {}
  let closeCb: () => void = () => {}
  const io: HelperIo = {
    write: (s) => { written.push(s); for (const l of answer(written)) lineCb(l) },
    end: () => { written.push('<end>') },
    onLine: (cb) => { lineCb = cb; queueMicrotask(() => script.forEach((l) => lineCb(l))) },
    onClose: (cb) => { closeCb = cb },
  }
  return { io, written, close: () => closeCb() }
}

describe('identities', () => {
  it('expands admin groups (listed and primary members), skips unknown users, puts root last', () => {
    const ids = parseIdentities([['unix-user', { uid: new Variant('u', 0) }], ['unix-group', { gid: new Variant('u', 27) }], ['unix-user', { uid: new Variant('u', 1001) }], ['bogus', {}]])
    expect(ids).toEqual([{ kind: 'unix-user', uid: 0 }, { kind: 'unix-group', gid: 27 }, { kind: 'unix-user', uid: 1001 }])
    expect(accountsFor(ids, PASSWD, GROUP)).toEqual(['alice', 'carol', 'bob', 'root'])
  })
  it('names the program from pkexec details', () => {
    expect(describeRequest('org.freedesktop.policykit.exec', 'Authentication is needed to run `/usr/bin/gparted`', { program: '/usr/bin/gparted' }, ['alice'], 'c1'))
      .toEqual({ cookie: 'c1', action: 'org.freedesktop.policykit.exec', message: 'Authentication is needed to run `/usr/bin/gparted`', program: 'gparted', accounts: ['alice'] })
  })
})

describe('helper conversation', () => {
  it('answers the password prompt once on stdin and reports success', async () => {
    const h = fakeHelper(['PAM_TEXT_INFO hello', 'PAM_PROMPT_ECHO_OFF Password: '], (w) => (w.length === 1 ? ['SUCCESS'] : []))
    expect(await converse(h.io, 'alice', 's3cret')).toBe('ok')
    expect(h.written).toEqual(['s3cret\n', '<end>'])
  })
  it('fails on FAILURE, on a second secret prompt, and when the helper dies', async () => {
    expect(await converse(fakeHelper(['PAM_PROMPT_ECHO_OFF Password: '], (w) => (w.length === 1 ? ['PAM_ERROR_MSG Authentication failure', 'FAILURE'] : [])).io, 'a', 'x')).toBe('failed')
    expect(await converse(fakeHelper(['PAM_PROMPT_ECHO_OFF Password: '], (w) => (w.length === 1 ? ['PAM_PROMPT_ECHO_OFF Code: '] : [])).io, 'a', 'x')).toBe('failed')
    const dead = fakeHelper([])
    const p = converse(dead.io, 'a', 'x'); dead.close()
    expect(await p).toBe('failed')
  })
  it('lets the user try again, then gives up', async () => {
    const req = describeRequest('a', 'm', {}, ['alice'], 'c')
    let asked = 0
    const ui: AgentUi = { ask: async () => { asked++; return { account: 'alice', password: 'wrong' } }, close: () => {} }
    const failing = () => fakeHelper(['PAM_PROMPT_ECHO_OFF Password: '], (w) => (w.length === 1 ? ['FAILURE'] : [])).io
    expect(await authenticate(req, ui, failing, () => false)).toBe('failed')
    expect(asked).toBe(MAX_TRIES)
    expect(await authenticate(req, { ask: async () => ({ account: 'mallory', password: 'x' }), close: () => {} }, failing, () => false)).toBe('failed')
    expect(await authenticate(req, { ask: async () => null, close: () => {} }, failing, () => false)).toBe('cancelled')
  })
})

describe('prompt queue', () => {
  it('shows one request at a time and cancels by cookie', async () => {
    const shown: string[] = []
    const q = promptQueue((p) => shown.push(p.req.cookie), () => shown.push('hide'))
    const r = (c: string) => describeRequest('a', 'm', {}, ['alice'], c)
    const a = q.ui.ask(r('1'), false); const b = q.ui.ask(r('2'), false)
    expect(shown).toEqual(['1'])
    q.answer({ account: 'alice', password: 'p' })
    expect(await a).toEqual({ account: 'alice', password: 'p' })
    q.ui.close('2')
    expect(await b).toBeNull()
    expect(shown).toEqual(['1', '2', 'hide'])
  })
})

const haveDbus = spawnSync('sh', ['-c', 'command -v dbus-daemon']).status === 0
describe.skipIf(!haveDbus)('AuthenticationAgent on a private bus', () => {
  let daemon: ChildProcess
  let agentBus: InstanceType<typeof dbus.MessageBus>
  let polkitd: InstanceType<typeof dbus.MessageBus>
  let other: InstanceType<typeof dbus.MessageBus>
  const opened: string[] = []
  let password = 'right'
  beforeAll(async () => {
    daemon = spawn('dbus-daemon', ['--session', '--nofork', '--print-address=1'], { stdio: ['ignore', 'pipe', 'ignore'] })
    const address = await new Promise<string>((resolve) => daemon.stdout!.once('data', (d) => resolve(String(d).trim())))
    agentBus = dbus.sessionBus({ busAddress: address })
    polkitd = dbus.sessionBus({ busAddress: address })
    other = dbus.sessionBus({ busAddress: address })
    await polkitd.requestName('org.freedesktop.PolicyKit1.Fake', 0)
    const ui: AgentUi = { ask: async () => ({ account: 'alice', password }), close: () => {} }
    exportAgent(agentBus, {
      ui, passwd: () => PASSWD, group: () => GROUP,
      open: (user, cookie) => {
        opened.push(`${user} ${cookie}`)
        return fakeHelper(['PAM_PROMPT_ECHO_OFF Password: '], (w) => (w.length === 1 ? [w[0] === 'right\n' ? 'SUCCESS' : 'FAILURE'] : [])).io
      },
    }, async () => (polkitd as unknown as { name: string }).name)
    // Unique names are assigned once Hello completes.
    await polkitd.call(new Message({ destination: 'org.freedesktop.DBus', path: '/org/freedesktop/DBus', interface: 'org.freedesktop.DBus', member: 'GetId' }))
  })
  afterAll(() => { other?.disconnect(); polkitd?.disconnect(); agentBus?.disconnect(); daemon?.kill() })

  const begin = (bus: InstanceType<typeof dbus.MessageBus>, cookie: string) => bus.call(new Message({
    destination: (agentBus as unknown as { name: string }).name, path: AGENT_PATH, interface: 'org.freedesktop.PolicyKit1.AuthenticationAgent', member: 'BeginAuthentication',
    signature: 'sssa{ss}sa(sa{sv})', body: ['org.example.manage', 'Change system settings', '', { program: '/usr/bin/tool' }, cookie, [['unix-group', { gid: new Variant('u', 27) }]]],
  }))

  it('authenticates through the helper with the cookie and replies to polkitd', async () => {
    await expect(begin(polkitd, 'cookie-1')).resolves.toBeTruthy()
    expect(opened).toEqual(['alice cookie-1'])
  })
  it('returns the polkit error after failed attempts', async () => {
    password = 'wrong'
    await expect(begin(polkitd, 'cookie-2')).rejects.toMatchObject({ type: 'org.freedesktop.PolicyKit1.Error.Failed' })
    password = 'right'
  })
  it('refuses callers other than polkitd', async () => {
    await expect(begin(other, 'cookie-3')).rejects.toMatchObject({ type: 'org.freedesktop.DBus.Error.AccessDenied' })
  })
})

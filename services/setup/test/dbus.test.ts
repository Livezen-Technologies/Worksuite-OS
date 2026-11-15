// lk.worksuite.Setup1 on a private dbus-daemon with a fake polkit: reads are open, changes need polkit, system hooks
// are root only, bad input is refused, and StateChanged is signalled.
import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { spawn, type ChildProcess } from 'node:child_process'
import { mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import dbus from 'dbus-next'
import { ACTIONS, NAME, PATH, serve } from '../src/dbus.ts'
import { SetupService } from '../src/service.ts'
import { MirroredFileStore } from '../src/store.ts'

const { Message } = dbus
let daemon: ChildProcess, address = ''
const xml = readFileSync(new URL('../dbus/lk.worksuite.Setup1.xml', import.meta.url), 'utf8')

before(async () => {
  daemon = spawn('dbus-daemon', ['--session', '--nofork', '--print-address'], { stdio: ['ignore', 'pipe', 'ignore'] })
  address = await new Promise<string>((r) => daemon.stdout!.once('data', (d) => r(String(d).trim())))
})
after(() => daemon.kill())

async function setup(o: { uid?: number; allowed?: boolean } = {}) {
  const dir = mkdtempSync(path.join(tmpdir(), 'ws-setup-dbus-'))
  const server = dbus.sessionBus({ busAddress: address }), client = dbus.sessionBus({ busAddress: address })
  const svc = new SetupService({ mode: 'firstRun', store: new MirroredFileStore([path.join(dir, 's')]), logDir: path.join(dir, 'l'), handlers: new Proxy({}, { get: () => async () => {} }), providers: {}, online: () => true })
  await svc.start()
  const checked: string[] = []
  serve(server, svc, { uid: async () => o.uid ?? 1000, check: async (_s, a) => { checked.push(a); return o.allowed ?? true } }, xml)
  await server.requestName(NAME, 0)
  const call = (member: string, signature = '', body: unknown[] = []) => client.call(new Message({ destination: NAME, path: PATH, interface: NAME, member, signature, body }))
  return { svc, client, call, checked, close: () => { server.disconnect(); client.disconnect() } }
}
const errType = (t: string) => (e: { type?: string }) => e.type === t

test('every method in the interface XML has an authorization rule, and the other way round', () => {
  const inXml = [...xml.matchAll(/<method name="(\w+)"/g)].map((m) => m[1]).sort()
  assert.deepEqual(inXml, Object.keys(ACTIONS).sort())
})

test('GetState is read-only; Send is authorized with polkit and returns the new state', async () => {
  const w = await setup()
  await new Promise((r) => setTimeout(r, 50))
  const st = JSON.parse(String((await w.call('GetState'))?.body[0]))
  assert.equal(st.state, 'WELCOME'); assert.deepEqual(w.checked, [])
  const r = JSON.parse(String((await w.call('Send', 's', ['{"type":"NEXT"}']))?.body[0]))
  assert.deepEqual(r, { ok: true, state: 'LANGUAGE_REGION' })
  assert.deepEqual(w.checked, ['lk.worksuite.setup.manage'])
  w.close()
})

test('validation errors come back as fieldErrors, not as a D-Bus error', async () => {
  const w = await setup()
  await new Promise((r) => setTimeout(r, 50))
  await w.call('Send', 's', ['{"type":"NEXT"}'])
  const r = JSON.parse(String((await w.call('Send', 's', ['{"type":"NEXT"}']))?.body[0]))
  assert.equal(r.ok, false); assert.deepEqual(Object.keys(r.fieldErrors), ['locale', 'timezone', 'keyboard'])
  w.close()
})

test('polkit denial → NotAuthorized and nothing changes', async () => {
  const w = await setup({ allowed: false })
  await new Promise((r) => setTimeout(r, 50))
  await assert.rejects(w.call('Send', 's', ['{"type":"NEXT"}']), errType('lk.worksuite.Error.NotAuthorized'))
  await assert.rejects(w.call('SetAnswer', 'ss', ['locale', '"en_US"']), errType('lk.worksuite.Error.NotAuthorized'))
  assert.equal(w.svc.machine.state, 'WELCOME')
  w.close()
})

test('system hooks are root only, even with polkit allowing everything', async () => {
  const w = await setup({ allowed: true })
  await assert.rejects(w.call('WorkResult', 'sbs', ['INSTALLING_OS', true, '']), errType('lk.worksuite.Error.NotAuthorized'))
  await assert.rejects(w.call('TargetMounted', 's', ['/target']), errType('lk.worksuite.Error.NotAuthorized'))
  await assert.rejects(w.call('ConnectivityChanged', 'b', [false]), errType('lk.worksuite.Error.NotAuthorized'))
  w.close()
})

test('a UI cannot send work results or secrets', async () => {
  const w = await setup()
  await assert.rejects(w.call('Send', 's', ['{"type":"WORK_DONE"}']), errType('lk.worksuite.Error.InvalidArgs'))
  await assert.rejects(w.call('SetAnswer', 'ss', ['account', '{"user":"a","password":"x"}']), errType('lk.worksuite.Error.InvalidArgs'))
  await assert.rejects(w.call('Send', 's', ['{"type":"BACK"}']), errType('lk.worksuite.Error.Refused'))
  w.close()
})

test('StateChanged is signalled with the new state', async () => {
  const w = await setup()
  await new Promise((r) => setTimeout(r, 50))
  await w.client.call(new Message({ destination: 'org.freedesktop.DBus', path: '/org/freedesktop/DBus', interface: 'org.freedesktop.DBus', member: 'AddMatch', signature: 's', body: [`type='signal',interface='${NAME}'`] }))
  const got = new Promise<string>((resolve) => w.client.on('message', (m) => { if (m.member === 'StateChanged') resolve(String(m.body[0])) }))
  await w.call('Send', 's', ['{"type":"NEXT"}'])
  assert.equal(JSON.parse(await got).state, 'LANGUAGE_REGION')
  w.close()
})

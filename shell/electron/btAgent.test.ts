// Bluetooth pairing agent (WSOS-INT-003) against a mocked BlueZ: the broker's answers for every org.bluez.Agent1 method,
// Cancel, the timeout, invalid input, and registration / Device1.Pair on a fake system bus.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  AGENT_CAPABILITY, AGENT_PATH, BtAgentError, ERR_CANCELED, ERR_REJECTED, agentInterface, btAgentBroker, pathAddress, startBtAgent, startBtAgentIpc, validDevicePath,
} from './btAgent'
import { peripheralsBridge } from './peripherals'

const DEV = '/org/bluez/hci0/dev_AA_BB_CC_DD_EE_01'
type Sent = { channel: string; payload: unknown }

function setup(timeoutMs = 30_000) {
  const sent: Sent[] = []
  const cancelled: string[] = []
  const b = btAgentBroker((channel, payload) => sent.push({ channel, payload }), (d) => cancelled.push(d), timeoutMs)
  const last = () => sent[sent.length - 1]?.payload as { id: string; kind: string; address: string; passkey?: number; pin?: string; entered?: number } | null
  return { b, sent, cancelled, last }
}
const errName = (p: Promise<unknown>) => p.then(() => 'resolved', (e: BtAgentError) => e.name)

describe('org.bluez.Agent1 methods', () => {
  it('RequestPasskey: forwards the request and returns the typed number', async () => {
    const { b, last } = setup()
    const p = b.requestPasskey(DEV)
    expect(last()).toMatchObject({ kind: 'requestPasskey', address: 'AA:BB:CC:DD:EE:01' })
    expect(b.respond(last()!.id, '012345')).toBe(true)
    expect(await p).toBe(12345)
  })
  it('DisplayPasskey: returns at once, shows the passkey and keystroke updates, clears when pairing ends', async () => {
    const { b, last } = setup()
    await expect(b.displayPasskey(DEV, 123456, 0)).resolves.toBeUndefined()
    const id = last()!.id
    expect(last()).toMatchObject({ kind: 'displayPasskey', passkey: 123456, entered: 0 })
    await b.displayPasskey(DEV, 123456, 3)
    expect(last()).toMatchObject({ id, entered: 3 })
    b.done()
    expect(last()).toBeNull()
  })
  it('RequestConfirmation: resolves only on an explicit yes', async () => {
    const { b, last } = setup()
    const p = b.requestConfirmation(DEV, 4321)
    expect(last()).toMatchObject({ kind: 'requestConfirmation', passkey: 4321 })
    expect(b.respond(last()!.id, 'no')).toBe(false)
    expect(b.respond(last()!.id, 'yes')).toBe(true)
    await expect(p).resolves.toBeUndefined()
  })
  it('DisplayPinCode: returns at once and shows the PIN', async () => {
    const { b, last } = setup()
    await expect(b.displayPinCode(DEV, '0000')).resolves.toBeUndefined()
    expect(last()).toMatchObject({ kind: 'displayPinCode', pin: '0000' })
  })
  it('RequestPinCode: returns the typed PIN', async () => {
    const { b, last } = setup()
    const p = b.requestPinCode(DEV)
    expect(b.respond(last()!.id, '1234')).toBe(true)
    expect(await p).toBe('1234')
  })
  it('Release and Cancel from BlueZ reject the open request and close the prompt', async () => {
    const { b, last } = setup()
    const p1 = b.requestPasskey(DEV)
    b.cancel()
    expect(await errName(p1)).toBe(ERR_CANCELED)
    expect(last()).toBeNull()
    const p2 = b.requestPinCode(DEV)
    b.release()
    expect(await errName(p2)).toBe(ERR_CANCELED)
    expect(b.current()).toBeNull()
  })
})

describe('cancel, timeout, invalid input', () => {
  beforeEach(() => vi.useFakeTimers())
  afterEach(() => vi.useRealTimers())

  it('the Cancel button rejects with org.bluez.Error.Canceled; on a display prompt it also cancels pairing', async () => {
    const { b, last, cancelled } = setup()
    const p = b.requestConfirmation(DEV, 1)
    expect(b.cancelPrompt('stale')).toBe(false)
    expect(b.cancelPrompt(last()!.id)).toBe(true)
    expect(await errName(p)).toBe(ERR_CANCELED)
    await b.displayPinCode(DEV, '9999')
    b.cancelPrompt(last()!.id)
    expect(cancelled).toEqual([DEV])
  })
  it('times out after 30 s so pairing never hangs', async () => {
    const { b, last, cancelled } = setup()
    const p = errName(b.requestPasskey(DEV))
    vi.advanceTimersByTime(29_999)
    expect(b.current()).not.toBeNull()
    vi.advanceTimersByTime(1)
    expect(await p).toBe(ERR_CANCELED)
    expect(last()).toBeNull()
    await b.displayPasskey(DEV, 5, 0)
    vi.advanceTimersByTime(30_000)
    expect(cancelled).toEqual([DEV])
  })
  it('rejects bad device paths, passkeys out of 0–999999 and malformed PINs from either side', async () => {
    const { b, last, sent } = setup()
    expect(await errName(b.requestPasskey('/org/bluez/hci0/../evil'))).toBe(ERR_REJECTED)
    expect(await errName(b.requestConfirmation(DEV, 1_000_000))).toBe(ERR_REJECTED)
    expect(await errName(b.displayPasskey(DEV, -1, 0))).toBe(ERR_REJECTED)
    expect(await errName(b.displayPinCode(DEV, 'bad pin!'))).toBe(ERR_REJECTED)
    expect(await errName(b.displayPinCode(DEV, ''))).toBe(ERR_REJECTED)
    expect(sent).toEqual([])
    b.requestPasskey(DEV).catch(() => undefined)
    const id = last()!.id
    for (const v of ['', '1234567', '12a', '-1', '1e3']) expect(b.respond(id, v)).toBe(false)
    expect(b.respond('other', '1')).toBe(false)
    b.cancel()
    b.requestPinCode(DEV).catch(() => undefined)
    for (const v of ['', '12345678901234567', 'ab cd', '12;rm']) expect(b.respond(last()!.id, v)).toBe(false)
    expect(validDevicePath('/org/bluez/hci0/dev_AA_BB_CC_DD_EE_0')).toBe(false)
    expect(pathAddress(DEV)).toBe('AA:BB:CC:DD:EE:01')
  })
})

describe('D-Bus wiring (mocked BlueZ)', () => {
  it('exports Agent1, registers KeyboardDisplay as default agent, and pairs with Device1.Pair', async () => {
    const calls: string[] = []
    let exported: { path: string; iface: unknown } | null = null
    const proxies: Record<string, Record<string, Record<string, (...a: unknown[]) => Promise<unknown>>>> = {
      '/org/bluez': { 'org.bluez.AgentManager1': {
        async RegisterAgent(p, c) { calls.push(`register ${p} ${c}`) },
        async RequestDefaultAgent(p) { calls.push(`default ${p}`) },
      } },
      '/': { 'org.freedesktop.DBus.ObjectManager': { async GetManagedObjects() { return { [DEV]: { 'org.bluez.Device1': { Address: { value: 'AA:BB:CC:DD:EE:01' } } } } } } },
      [DEV]: { 'org.bluez.Device1': { async Pair() { calls.push('pair'); throw Object.assign(new Error('x'), { type: 'org.bluez.Error.AuthenticationFailed' }) } } },
    }
    const bus = {
      on() {}, export(path: string, iface: unknown) { exported = { path, iface } },
      async getProxyObject(_n: string, p: string) { return { getInterface: (i: string) => proxies[p][i] } },
    }
    const host = await startBtAgent(() => undefined, bus as never)
    expect(exported!.path).toBe(AGENT_PATH)
    expect(calls).toEqual([`register ${AGENT_PATH} ${AGENT_CAPABILITY}`, `default ${AGENT_PATH}`])
    expect(await host.pair('AA:BB:CC:DD:EE:01')).toEqual({ ok: false, error: 'org.bluez.Error.AuthenticationFailed' })
    expect(await host.pair('AA:BB:CC:DD:EE:99')).toEqual({ ok: false, error: 'org.bluez.Error.DoesNotExist' })
    // The bridge uses the agent's Pair when it is registered, then trusts and connects.
    const execs: string[] = []
    const bridge = peripheralsBridge('/h', async (c, a) => { execs.push([c, ...a].join(' ')); return { code: 0, stdout: '', stderr: '' } }, undefined, undefined, undefined, () => async () => ({ ok: true }))
    expect(await bridge.btPair('aa:bb:cc:dd:ee:01')).toEqual({ available: true, value: true })
    expect(execs).toEqual(['bluetoothctl trust aa:bb:cc:dd:ee:01', 'bluetoothctl connect aa:bb:cc:dd:ee:01'])
    const failing = peripheralsBridge('/h', async () => ({ code: 0, stdout: '', stderr: '' }), undefined, undefined, undefined, () => host.pair)
    expect(await failing.btPair('AA:BB:CC:DD:EE:01')).toEqual({ available: false, reason: 'bt_auth_failed' })
  })
  it('the Agent1 object turns a rejection into the BlueZ error name and declares the Agent1 signatures', async () => {
    const { b } = setup()
    const iface = agentInterface(b) as unknown as Record<string, (...a: unknown[]) => Promise<unknown>>
    await expect(iface.RequestConfirmation('/bad', 1)).rejects.toMatchObject({ type: ERR_REJECTED })
    const p = iface.RequestPasskey(DEV)
    b.cancel()
    await expect(p).rejects.toMatchObject({ type: ERR_CANCELED })
    const members = (iface.constructor as unknown as { prototype: { $methods: Record<string, { inSignature: string; outSignature: string }> } }).prototype.$methods
    expect(Object.keys(members).sort()).toEqual(['AuthorizeService', 'Cancel', 'DisplayPasskey', 'DisplayPinCode', 'Release', 'RequestAuthorization', 'RequestConfirmation', 'RequestPasskey', 'RequestPinCode'])
    expect(members.DisplayPasskey).toMatchObject({ inSignature: 'ouq' })
  })
  it('IPC: narrow channels; strings only reach the broker', async () => {
    const h: Record<string, (...a: string[]) => unknown> = {}
    const { b, last } = setup()
    startBtAgentIpc((c, fn) => { h[c] = fn }, () => b)
    expect(Object.keys(h).sort()).toEqual(['ws:btAgentCancel', 'ws:btAgentRespond', 'ws:btAgentState'])
    const p = b.requestPinCode(DEV)
    expect(h['ws:btAgentState']()).toMatchObject({ kind: 'requestPinCode' })
    expect(h['ws:btAgentRespond'](last()!.id, '../x')).toBe(false)
    expect(h['ws:btAgentRespond'](last()!.id, '0000')).toBe(true)
    expect(await p).toBe('0000')
    startBtAgentIpc((c, fn) => { h[c] = fn }, () => null)
    expect(h['ws:btAgentCancel']('bt1')).toBe(false)
  })
})

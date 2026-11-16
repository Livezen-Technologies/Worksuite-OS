// Bluetooth pairing agent (WSOS-INT-003). The shell registers an org.bluez.Agent1 object on the system bus with
// capability KeyboardDisplay, as the default agent, and pairs through org.bluez.Device1.Pair on the same connection so
// BlueZ asks this agent. Each agent call goes to the renderer as one prompt ('ws:btAgent'); the person's answer comes
// back over 'ws:btAgentRespond' / 'ws:btAgentCancel'. In-process dbus-next (already used by the shell) as the user:
// no helper binary, no privilege; BlueZ's own D-Bus policy lets the active session register an agent.
// Every value is checked both ways: object paths must be BlueZ device paths, passkeys 0–999999, PINs 1–16 letters or
// digits. Cancel and a 30 s timeout reject with org.bluez.Error.Canceled so pairing never hangs.
import dbus from 'dbus-next'

export const AGENT_PATH = '/lk/worksuite/bt_agent'
export const AGENT_CAPABILITY = 'KeyboardDisplay'
export const AGENT_TIMEOUT_MS = 30_000
export const ERR_CANCELED = 'org.bluez.Error.Canceled'
export const ERR_REJECTED = 'org.bluez.Error.Rejected'

const DEVICE_PATH = /^\/org\/bluez\/hci\d{1,3}\/dev(_[0-9A-F]{2}){6}$/
const PIN = /^[0-9A-Za-z]{1,16}$/
const PASSKEY = /^\d{1,6}$/

export type BtPromptKind = 'requestPasskey' | 'displayPasskey' | 'requestConfirmation' | 'displayPinCode' | 'requestPinCode'
/** What the renderer draws. `passkey` / `pin` are shown; `entered` counts keys typed on the device (DisplayPasskey). */
export interface BtPrompt { id: string; kind: BtPromptKind; address: string; passkey?: number; pin?: string; entered?: number }

export class BtAgentError extends Error {
  constructor(public readonly name: string, message = '') { super(message) }
}

export const validDevicePath = (p: unknown): p is string => typeof p === 'string' && DEVICE_PATH.test(p)
export const validPasskey = (n: unknown): n is number => typeof n === 'number' && Number.isInteger(n) && n >= 0 && n <= 999_999
export const validPin = (s: unknown): s is string => typeof s === 'string' && PIN.test(s)
/** /org/bluez/hci0/dev_AA_BB_CC_DD_EE_FF → AA:BB:CC:DD:EE:FF */
export const pathAddress = (p: string) => p.slice(p.lastIndexOf('/dev_') + 5).replace(/_/g, ':')

type Broadcast = (channel: string, payload: unknown) => void
interface Pending { prompt: BtPrompt; device: string; resolve(v: string | number | void): void; reject(e: BtAgentError): void; timer: ReturnType<typeof setTimeout> }

/**
 * The agent's logic without D-Bus: one prompt at a time (BlueZ pairs one device at a time per agent). A request that
 * needs an answer stays open until respond / cancel / timeout; a display-only one resolves at once and the prompt stays
 * on screen until pairing ends, Cancel (which calls `cancelPairing`) or the timeout.
 */
export function btAgentBroker(broadcast: Broadcast, cancelPairing: (device: string) => void = () => undefined, timeoutMs = AGENT_TIMEOUT_MS) {
  let cur: Pending | null = null
  let seq = 0
  const clear = () => {
    if (!cur) return
    clearTimeout(cur.timer)
    cur = null
    broadcast('ws:btAgent', null)
  }
  const drop = (name: string) => { const p = cur; clear(); p?.reject(new BtAgentError(name)) }
  const open = (kind: BtPromptKind, device: string, extra: Partial<BtPrompt>, waits: boolean) => {
    if (!validDevicePath(device)) return Promise.reject(new BtAgentError(ERR_REJECTED, 'invalid device'))
    drop(ERR_CANCELED)   // a new request replaces any older one
    const prompt: BtPrompt = { id: `bt${++seq}`, kind, address: pathAddress(device), ...extra }
    return new Promise<string | number | void>((resolve, reject) => {
      const timer = setTimeout(() => {
        if (cur?.prompt.id !== prompt.id) return
        if (!waits) cancelPairing(device)
        drop(ERR_CANCELED)
      }, timeoutMs)
      cur = { prompt, device, resolve, reject, timer }
      broadcast('ws:btAgent', prompt)
      if (!waits) resolve()
    })
  }
  return {
    current: () => cur?.prompt ?? null,
    // org.bluez.Agent1
    requestPasskey: (device: string) => open('requestPasskey', device, {}, true) as Promise<number>,
    displayPasskey(device: string, passkey: number, entered: number): Promise<void> {
      if (!validPasskey(passkey) || !Number.isInteger(entered) || entered < 0 || entered > 16) return Promise.reject(new BtAgentError(ERR_REJECTED, 'invalid passkey'))
      // Updates while the person types on the device keep the same prompt.
      if (cur && cur.device === device && cur.prompt.kind === 'displayPasskey' && cur.prompt.passkey === passkey) {
        cur.prompt = { ...cur.prompt, entered }
        broadcast('ws:btAgent', cur.prompt)
        return Promise.resolve()
      }
      return open('displayPasskey', device, { passkey, entered }, false) as Promise<void>
    },
    requestConfirmation(device: string, passkey: number): Promise<void> {
      if (!validPasskey(passkey)) return Promise.reject(new BtAgentError(ERR_REJECTED, 'invalid passkey'))
      return open('requestConfirmation', device, { passkey }, true) as Promise<void>
    },
    displayPinCode(device: string, pin: string): Promise<void> {
      if (!validPin(pin)) return Promise.reject(new BtAgentError(ERR_REJECTED, 'invalid pin'))
      return open('displayPinCode', device, { pin }, false) as Promise<void>
    },
    requestPinCode: (device: string) => open('requestPinCode', device, {}, true) as Promise<string>,
    /** BlueZ unregistered the agent (bluetoothd stopping). */
    release() { drop(ERR_CANCELED) },
    /** BlueZ gave up on the request (device went away, its own timeout). */
    cancel() { drop(ERR_CANCELED) },

    // From the renderer. Returns false (and changes nothing) for a stale id or a value of the wrong shape.
    respond(id: string, value: string): boolean {
      const p = cur
      if (!p || p.prompt.id !== id) return false
      switch (p.prompt.kind) {
        case 'requestPasskey': {
          if (!PASSKEY.test(value)) return false
          clear(); p.resolve(Number(value)); return true
        }
        case 'requestPinCode':
          if (!validPin(value)) return false
          clear(); p.resolve(value); return true
        case 'requestConfirmation':
          if (value !== 'yes') return false
          clear(); p.resolve(); return true
        default:
          return false
      }
    },
    /** The person pressed Cancel (or declined a confirmation). */
    cancelPrompt(id: string): boolean {
      const p = cur
      if (!p || p.prompt.id !== id) return false
      if (p.prompt.kind === 'displayPasskey' || p.prompt.kind === 'displayPinCode') cancelPairing(p.device)
      drop(ERR_CANCELED)
      return true
    },
    /** Pairing finished (either way): a display-only prompt has nothing left to show. */
    done() { if (cur && (cur.prompt.kind === 'displayPasskey' || cur.prompt.kind === 'displayPinCode')) clear() },
  }
}
export type BtAgentBroker = ReturnType<typeof btAgentBroker>

// ---------- D-Bus ----------
type Bus = InstanceType<typeof dbus.MessageBus>
const toDbusError = (e: unknown) => {
  const name = e instanceof BtAgentError ? e.name : ERR_CANCELED
  return new dbus.DBusError(name, e instanceof Error ? e.message : '')
}

/** org.bluez.Agent1 on dbus-next, delegating to the broker. */
export function agentInterface(b: BtAgentBroker) {
  class Agent1 extends dbus.interface.Interface {
    Release() { b.release() }
    async RequestPinCode(device: string) { try { return await b.requestPinCode(device) } catch (e) { throw toDbusError(e) } }
    async DisplayPinCode(device: string, pin: string) { try { await b.displayPinCode(device, pin) } catch (e) { throw toDbusError(e) } }
    async RequestPasskey(device: string) { try { return await b.requestPasskey(device) } catch (e) { throw toDbusError(e) } }
    async DisplayPasskey(device: string, passkey: number, entered: number) { try { await b.displayPasskey(device, passkey, entered) } catch (e) { throw toDbusError(e) } }
    async RequestConfirmation(device: string, passkey: number) { try { await b.requestConfirmation(device, passkey) } catch (e) { throw toDbusError(e) } }
    async RequestAuthorization(device: string) { throw toDbusError(new BtAgentError(ERR_REJECTED, `unsolicited ${validDevicePath(device) ? 'pairing' : 'request'}`)) }
    AuthorizeService() { throw toDbusError(new BtAgentError(ERR_REJECTED, 'not handled')) }
    Cancel() { b.cancel() }
  }
  Agent1.configureMembers({
    methods: {
      Release: { inSignature: '', outSignature: '' },
      RequestPinCode: { inSignature: 'o', outSignature: 's' },
      DisplayPinCode: { inSignature: 'os', outSignature: '' },
      RequestPasskey: { inSignature: 'o', outSignature: 'u' },
      DisplayPasskey: { inSignature: 'ouq', outSignature: '' },
      RequestConfirmation: { inSignature: 'ou', outSignature: '' },
      RequestAuthorization: { inSignature: 'o', outSignature: '' },
      AuthorizeService: { inSignature: 'os', outSignature: '' },
      Cancel: { inSignature: '', outSignature: '' },
    },
  })
  return new Agent1('org.bluez.Agent1')
}

/** Pair result: ok, or the BlueZ error name (mapped to a reason by peripherals.btError). */
export type PairResult = { ok: true } | { ok: false; error: string }
export interface BtAgentHost { broker: BtAgentBroker; pair(address: string): Promise<PairResult> }

/** Exports the agent, registers it as the default agent, and pairs through Device1.Pair on the same connection. */
export async function startBtAgent(broadcast: Broadcast, bus: Bus = dbus.systemBus()): Promise<BtAgentHost> {
  bus.on('error', () => { /* bluetoothd or the bus went away: pairing falls back to failing with a reason */ })
  const cancelPairing = (device: string) => {
    void bus.getProxyObject('org.bluez', device).then((o) => o.getInterface('org.bluez.Device1').CancelPairing()).catch(() => undefined)
  }
  const broker = btAgentBroker(broadcast, cancelPairing)
  bus.export(AGENT_PATH, agentInterface(broker))
  const mgr = (await bus.getProxyObject('org.bluez', '/org/bluez')).getInterface('org.bluez.AgentManager1')
  await mgr.RegisterAgent(AGENT_PATH, AGENT_CAPABILITY)
  await mgr.RequestDefaultAgent(AGENT_PATH).catch(() => undefined)
  return {
    broker,
    async pair(address) {
      try {
        const om = (await bus.getProxyObject('org.bluez', '/')).getInterface('org.freedesktop.DBus.ObjectManager')
        const objs = (await om.GetManagedObjects()) as Record<string, Record<string, Record<string, { value: unknown }>>>
        const path = Object.keys(objs).find((p) => validDevicePath(p) && objs[p]['org.bluez.Device1']?.Address?.value === address)
        if (!path) return { ok: false, error: 'org.bluez.Error.DoesNotExist' }
        await (await bus.getProxyObject('org.bluez', path)).getInterface('org.bluez.Device1').Pair()
        return { ok: true }
      } catch (e) {
        return { ok: false, error: (e as { type?: string }).type ?? 'org.bluez.Error.Failed' }
      } finally { broker.done() }
    },
  }
}

type Handle = (channel: string, fn: (...args: string[]) => unknown) => void
/** The renderer's two answers. Values are strings from IPC; the broker checks their shape. */
export function startBtAgentIpc(handle: Handle, broker: () => BtAgentBroker | null) {
  handle('ws:btAgentState', () => broker()?.current() ?? null)
  handle('ws:btAgentRespond', (id, value) => broker()?.respond(String(id), String(value)) ?? false)
  handle('ws:btAgentCancel', (id) => broker()?.cancelPrompt(String(id)) ?? false)
}

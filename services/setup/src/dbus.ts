// lk.worksuite.Setup1 on the system bus. The caller's UID comes from the bus, never from arguments; polkit authorizes
// every call that changes setup; root-only hooks (NetworkManager dispatcher, Calamares) refuse any other caller.
import dbus from 'dbus-next'
import { SetupError } from './errors.ts'
import type { SetupService } from './service.ts'
import { parseAnswer, parseEvent } from './validate.ts'

const { Message } = dbus
type Msg = InstanceType<typeof Message>
type Bus = ReturnType<typeof dbus.systemBus>

export const NAME = 'lk.worksuite.Setup1'
export const PATH = '/lk/worksuite/Setup1'
const IFACE = NAME

/** polkit action per method; null = read-only; 'root' = only uid 0 (system components), never a user. */
export const ACTIONS: Record<string, string | null | 'root'> = {
  GetState: null,
  GetRecoveryOptions: null,
  GetLog: null,
  GetApps: null,
  Send: 'lk.worksuite.setup.manage',
  SetAnswer: 'lk.worksuite.setup.manage',
  ConnectivityChanged: 'root',
  TargetMounted: 'root',
  WorkResult: 'root',
}

export interface Authority { uid(sender: string): Promise<number>; check(sender: string, action: string): Promise<boolean> }

const errorReply = (msg: Msg, name: string, text: string) => Message.newError(msg as unknown as string, name, text)

export function serve(bus: Bus, svc: SetupService, auth: Authority, introspectionXml: string, apps: () => unknown[] = () => []) {
  svc.on('changed', (st: unknown) => bus.send(Message.newSignal(PATH, IFACE, 'StateChanged', 's', [JSON.stringify(st)])))

  async function call(msg: Msg): Promise<Msg> {
    const member = msg.member
    if (!(member in ACTIONS)) return errorReply(msg, 'org.freedesktop.DBus.Error.UnknownMethod', member)
    const uid = await auth.uid(msg.sender)
    const action = ACTIONS[member]
    if (action === 'root' && uid !== 0) throw new SetupError('NotAuthorized', `${member} is for system components only`)
    if (action && action !== 'root' && uid !== 0 && !(await auth.check(msg.sender, action))) throw new SetupError('NotAuthorized')
    const b = msg.body
    const json = (x: unknown) => Message.newMethodReturn(msg, 's', [JSON.stringify(x)])
    switch (member) {
      case 'GetState': return json(svc.getState())
      case 'GetRecoveryOptions': return json(svc.recovery())
      case 'GetApps': return json(apps())
      case 'GetLog': {
        const n = Number(b[0]); return Message.newMethodReturn(msg, 's', [svc.readLog(Number.isInteger(n) && n > 0 && n <= 5000 ? n : 200)])
      }
      case 'Send': {
        const r = await svc.send(parseEvent(b[0]))
        return json({ ok: r.ok, state: r.state, ...(r.fieldErrors ? { fieldErrors: r.fieldErrors } : {}), ...(r.error ? { error: r.error } : {}) })
      }
      case 'SetAnswer': { const { key, value } = parseAnswer(b[0], b[1]); await svc.setAnswer(key, value); return Message.newMethodReturn(msg, '', []) }
      case 'ConnectivityChanged': await svc.connectivity(b[0] === true); return Message.newMethodReturn(msg, '', [])
      case 'WorkResult': await svc.workResult(String(b[0] ?? ''), b[1] === true, String(b[2] ?? '')); return Message.newMethodReturn(msg, '', [])
      case 'TargetMounted': {
        const dir = String(b[0] ?? '')
        if (!/^\/[A-Za-z0-9._/-]{1,200}$/.test(dir) || dir.includes('..')) throw new SetupError('InvalidArgs', 'target path')
        await svc.targetMounted(dir); return Message.newMethodReturn(msg, '', [])
      }
    }
    return errorReply(msg, 'org.freedesktop.DBus.Error.UnknownMethod', member)
  }

  bus.addMethodHandler((msg: Msg) => {
    if (msg.path !== PATH) return false
    if (msg.interface === 'org.freedesktop.DBus.Introspectable' && msg.member === 'Introspect') { bus.send(Message.newMethodReturn(msg, 's', [introspectionXml])); return true }
    if (msg.interface !== IFACE) return false
    call(msg).then((r) => bus.send(r), (e) => {
      const err = e instanceof SetupError ? e : new SetupError('Failed', (e as Error).message)
      bus.send(errorReply(msg, `lk.worksuite.Error.${err.code}`, err.message))
    })
    return true
  })
}

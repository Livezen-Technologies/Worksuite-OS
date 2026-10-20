// lk.worksuite.DeviceAgent1 on the system bus (WSOS-ARC-002). Every method has a named polkit action or is
// read-only; the caller's UID comes from the bus, never from arguments. The enrollment token arrives as a D-Bus
// argument (not argv, not logged) and is only passed to Agent.enroll.
import { readFileSync } from 'node:fs';

export const NAME = 'lk.worksuite.DeviceAgent1';
export const PATH = '/lk/worksuite/DeviceAgent1';
const IFACE = NAME;
export const ERR = 'lk.worksuite.Error.';

/** Which polkit action guards which method (`null` = read-only, no authorization). */
export const ACTIONS: Record<string, string | null> = {
  GetManagementInfo: null,
  GetEffectivePolicy: null,
  Enroll: 'lk.worksuite.device.enroll',
  RefreshNow: null,   // fetches what the server already decided; changes nothing the caller chooses
  // WorkSuite Security (#20): Settings › Privacy & security › WorkSuite Security "Scan now" (active local user).
  StartSecurityScan: 'lk.worksuite.security.scan',
};

export interface Authority {
  uid(sender: string): Promise<number>;
  check(sender: string, action: string): Promise<boolean>;
}

export interface AgentOps {
  status(): { managed: boolean; org_name: string | null; device_id: string | null; last_check_in: number | null; policies: unknown; wiped?: boolean };
  effectivePolicy(): unknown;
  enroll(serverUrl: string, token: string): Promise<string>;
  refresh(): Promise<void>;
  /** Starts a malware scan (quick | full); resolves when it has started. Absent = no security module. */
  scan?(kind: 'quick' | 'full'): void;
}

export class BusError extends Error {
  readonly code: 'NotAuthorized' | 'InvalidArgs' | 'Failed';
  constructor(code: 'NotAuthorized' | 'InvalidArgs' | 'Failed', message: string = code) { super(message); this.code = code; }
}

/** One method call → [signature, body]. Throws BusError; agent errors map to Failed with their code (no token text). */
export async function dispatch(member: string, body: unknown[], sender: string, auth: Authority, ops: AgentOps): Promise<[string, unknown[]]> {
  if (!(member in ACTIONS)) throw new BusError('Failed', `unknown method ${member}`);
  const action = ACTIONS[member];
  if (action) {
    const uid = await auth.uid(sender);
    if (uid !== 0 && !(await auth.check(sender, action))) throw new BusError('NotAuthorized');
  }
  switch (member) {
    case 'GetManagementInfo': {
      const s = ops.status();
      return ['a{sv}', [{
        managed: ['b', s.managed], org_name: ['s', s.org_name ?? ''], device_id: ['s', s.device_id ?? ''],
        last_check_in: ['t', BigInt(s.last_check_in ?? 0)], policies: ['s', JSON.stringify(s.policies ?? null)],
        can_wipe_data: ['b', s.managed], can_wipe_device: ['b', s.managed],
      }]];
    }
    case 'GetEffectivePolicy': return ['s', [JSON.stringify(ops.effectivePolicy() ?? null)]];
    case 'RefreshNow': await ops.refresh(); return ['', []];
    case 'StartSecurityScan': {
      const [kind] = body;
      if (kind !== 'quick' && kind !== 'full') throw new BusError('InvalidArgs');
      if (!ops.scan) throw new BusError('Failed', 'NOT_SUPPORTED');
      ops.scan(kind); return ['', []];
    }
    case 'Enroll': {
      const [url, token] = body;
      if (typeof url !== 'string' || typeof token !== 'string' || !token || token.length > 4096 || url.length > 2048) throw new BusError('InvalidArgs');
      try { return ['s', [await ops.enroll(url, token)]]; } catch (e) {
        const code = e instanceof Error && /^[A-Z_]{3,40}$/.test(e.message) ? e.message : 'ENROLL_FAILED';
        throw new BusError('Failed', code);
      }
    }
  }
  throw new BusError('Failed');
}

/** Read-only properties from the introspection XML. */
export function properties(ops: AgentOps): Record<string, [string, unknown]> {
  const s = ops.status();
  return { Enrolled: ['b', s.managed], DeviceId: ['s', s.device_id ?? ''], LastCheckIn: ['t', BigInt(s.last_check_in ?? 0)] };
}

/** Serve on the system bus with dbus-next (loaded lazily so tests and the CLI need no bus). */
export async function serveBus(ops: AgentOps, xmlPath = '/usr/share/dbus-1/interfaces/lk.worksuite.DeviceAgent1.xml') {
  const { default: dbus } = await import('dbus-next');
  const { Message, Variant } = dbus;
  type Msg = InstanceType<typeof Message>;
  const bus = dbus.systemBus();
  const xml = readFileSync(xmlPath, 'utf8');
  const v = ([sig, x]: [string, unknown]) => new Variant(sig, x);
  const err = (msg: Msg, name: string, text: string) => Message.newError(msg as unknown as string, name, text);
  const auth: Authority = {
    async uid(sender) {
      const r = await bus.call(new Message({ destination: 'org.freedesktop.DBus', path: '/org/freedesktop/DBus', interface: 'org.freedesktop.DBus', member: 'GetConnectionUnixUser', signature: 's', body: [sender] }));
      return Number(r?.body[0]);
    },
    async check(sender, action) {
      const r = await bus.call(new Message({
        destination: 'org.freedesktop.PolicyKit1', path: '/org/freedesktop/PolicyKit1/Authority', interface: 'org.freedesktop.PolicyKit1.Authority',
        member: 'CheckAuthorization', signature: '(sa{sv})sa{ss}us', body: [['system-bus-name', { name: new Variant('s', sender) }], action, {}, 1, ''],
      }));
      return r?.body[0]?.[0] === true;
    },
  };
  bus.addMethodHandler((msg: Msg) => {
    if (msg.path !== PATH) return false;
    if (msg.interface === 'org.freedesktop.DBus.Introspectable' && msg.member === 'Introspect') { bus.send(Message.newMethodReturn(msg, 's', [xml])); return true; }
    if (msg.interface === 'org.freedesktop.DBus.Properties') {
      const all = Object.fromEntries(Object.entries(properties(ops)).map(([k, p]) => [k, v(p)]));
      if (msg.member === 'GetAll') bus.send(Message.newMethodReturn(msg, 'a{sv}', [all]));
      else if (msg.member === 'Get' && msg.body[1] in all) bus.send(Message.newMethodReturn(msg, 'v', [all[msg.body[1]]]));
      else bus.send(err(msg, 'org.freedesktop.DBus.Error.PropertyReadOnly', 'read-only'));
      return true;
    }
    if (msg.interface !== IFACE) return false;
    dispatch(msg.member, msg.body, msg.sender, auth, ops).then(
      ([sig, body]) => bus.send(Message.newMethodReturn(msg, sig, sig === 'a{sv}' ? [Object.fromEntries(Object.entries(body[0] as Record<string, [string, unknown]>).map(([k, p]) => [k, v(p)]))] : body)),
      (e) => bus.send(err(msg, ERR + (e instanceof BusError ? e.code : 'Failed'), e instanceof Error ? e.message : 'failed')),
    );
    return true;
  });
  await bus.requestName(NAME, 0);
  return {
    policyChanged: (version: string) => bus.send(Message.newSignal(PATH, IFACE, 'PolicyChanged', 's', [version])),
    close: () => bus.disconnect(),
  };
}

// Live taskbar status (#28): Wi-Fi, Bluetooth and power change without polling. The system bus' PropertiesChanged
// signals from NetworkManager, BlueZ and UPower (and their device add/remove signals) are matched here and become one
// debounced 'ws:sysChanged' event per kind; the renderer then re-reads that state (components/QuickSettings.tsx).
// Without a system bus nothing is sent and the taskbar keeps its slow poll.
import dbus from 'dbus-next'

export type SysKind = 'network' | 'bluetooth' | 'battery'

/** Match rules: signals from the three services only (no eavesdropping, any user may add these). */
export const SYS_MATCH_RULES = [
  "type='signal',sender='org.freedesktop.NetworkManager'",
  "type='signal',sender='org.bluez'",
  "type='signal',sender='org.freedesktop.UPower'",
]

/** Which taskbar state a signal changes, from its object path (signals carry the sender's unique name, not its
 *  well-known name). Null for anything else. */
export function sysChangeKind(m: { type?: number; path?: string | null; interface?: string | null; member?: string | null; body?: unknown[] }): SysKind | null {
  const path = m.path ?? ''
  const iface = m.interface ?? ''
  if (path.startsWith('/org/freedesktop/NetworkManager') || iface.startsWith('org.freedesktop.NetworkManager')) return 'network'
  if (path.startsWith('/org/freedesktop/UPower') || iface.startsWith('org.freedesktop.UPower')) return 'battery'
  if (path.startsWith('/org/bluez') || iface.startsWith('org.bluez')) return 'bluetooth'
  // BlueZ' ObjectManager signals come from "/": a device or adapter appearing or going away.
  if (path === '/' && (m.member === 'InterfacesAdded' || m.member === 'InterfacesRemoved')) {
    const p = String(m.body?.[0] ?? '')
    if (p.startsWith('/org/bluez')) return 'bluetooth'
  }
  return null
}

/** Coalesces bursts (NetworkManager sends many signals per connect) into one call per kind after `ms`. */
export function debouncer(emit: (k: SysKind) => void, ms = 400, timers: { set: typeof setTimeout; clear: typeof clearTimeout } = { set: setTimeout, clear: clearTimeout }) {
  const pending = new Map<SysKind, ReturnType<typeof setTimeout>>()
  return {
    push(k: SysKind) {
      if (pending.has(k)) return
      pending.set(k, timers.set(() => { pending.delete(k); emit(k) }, ms))
    },
    stop() { pending.forEach((t) => timers.clear(t)); pending.clear() },
  }
}

type Bus = { call(m: InstanceType<typeof dbus.Message>): Promise<unknown>; on(e: 'message', cb: (m: InstanceType<typeof dbus.Message>) => void): void; on(e: 'error', cb: () => void): void }

/** Starts watching; returns the stopper. `bus` is for tests (default: the system bus). */
export async function startSysWatch(broadcast: (ch: string, p: unknown) => void, bus?: Bus): Promise<() => void> {
  let b: Bus
  try { b = bus ?? (dbus.systemBus() as unknown as Bus) } catch { return () => undefined }
  b.on('error', () => { /* no system bus: the taskbar's poll still runs */ })
  const d = debouncer((k) => broadcast('ws:sysChanged', k))
  b.on('message', (m) => { if (m.type !== dbus.MessageType.SIGNAL) return; const k = sysChangeKind(m); if (k) d.push(k) })
  for (const rule of SYS_MATCH_RULES) {
    try {
      await b.call(new dbus.Message({ destination: 'org.freedesktop.DBus', path: '/org/freedesktop/DBus', interface: 'org.freedesktop.DBus', member: 'AddMatch', signature: 's', body: [rule] }))
    } catch { /* that service is not there */ }
  }
  return () => d.stop()
}

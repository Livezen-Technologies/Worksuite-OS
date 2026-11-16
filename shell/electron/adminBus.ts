// lk.worksuite.Admin1 (services/session/admin, WSOS-ARC-002): the shell's root work as named D-Bus methods, each
// behind its own polkit action, acting for the calling user only (the service takes the UID from the bus). Kiosk exit,
// Recovery › Reinstall, printer administration, "Restart anyway" and Settings › About › Diagnostics go through here;
// the shell starts no setuid helper (shell/electron/boundary.test.ts).
import dbus from 'dbus-next'

export type AdminMethod = 'KioskExit' | 'Reinstall' | 'Printers' | 'ForcePower' | 'Journal' | 'BootDetails'
/** The D-Bus input signature of each method (services/session/dbus/lk.worksuite.Admin1.xml). */
export const ADMIN_SIGNATURES: Record<AdminMethod, string> = { KioskExit: 'ss', Reinstall: 'a{ss}', Printers: 'as', ForcePower: 's', BootDetails: 's', Journal: 'su' }

/** What a call came to: the helper ran (its exit code and output), or why it did not. */
export type AdminResult =
  | { ok: true; code: number; stdout: string }
  | { ok: false; error: 'not_authorized' | 'auth_cancelled' | 'invalid_argument' | 'unavailable' | 'failed' }

export type AdminCall = (member: AdminMethod, body: unknown[]) => Promise<AdminResult>

/** A D-Bus error name → what the screens say: refused, dismissed, bad input, no service, or anything else. */
export function adminError(type: string): Extract<AdminResult, { ok: false }>['error'] {
  if (type === 'lk.worksuite.Error.NotAuthorized') return 'not_authorized'
  if (type === 'lk.worksuite.Error.Cancelled') return 'auth_cancelled'
  if (type === 'lk.worksuite.Error.InvalidArgs' || type === 'org.freedesktop.DBus.Error.InvalidArgs') return 'invalid_argument'
  if (!type || /ServiceUnknown|NameHasNoOwner|Spawn|Disconnected/.test(type)) return 'unavailable'
  return 'failed'
}

export function adminMessage(member: AdminMethod, body: unknown[]) {
  return new dbus.Message({
    destination: 'lk.worksuite.Admin1', path: '/lk/worksuite/Admin1', interface: 'lk.worksuite.Admin1',
    member, signature: ADMIN_SIGNATURES[member], body,
  })
}

/** The method call itself, sent directly (fixed signature per method; no introspected proxy). No reply timeout:
 *  the polkit prompt waits for the person, and a reinstall takes minutes. */
export const adminCall: AdminCall = async (member, body) => {
  const bus = dbus.systemBus()
  try {
    const reply = await bus.call(adminMessage(member, body))
    const [code, stdout] = (reply?.body ?? []) as [unknown, unknown]
    return typeof code === 'number' ? { ok: true, code, stdout: String(stdout ?? '') } : { ok: false, error: 'failed' }
  } catch (e) {
    return { ok: false, error: adminError((e as { type?: string }).type ?? '') }
  } finally { bus.disconnect() }
}

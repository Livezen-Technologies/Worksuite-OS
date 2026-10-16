// Screenshot shortcuts (WSOS-DSK-011): Labwc runs `worksuite-screenshot [--save|--window|--snip]` on Print, Super+Print,
// Alt+Print and Super+Shift+S. It hands the request to the shell (lk.worksuite.Shell1.Capture, electron/capture.ts),
// which captures, copies, saves and shows the snipping overlay. When the shell does not answer (it is restarting, or a
// session without it) the screenshot comes from xdg-desktop-portal (org.freedesktop.portal.Screenshot, backed by
// xdg-desktop-portal-wlr per services/session/portals/worksuite-portals.conf) and is copied into ~/Pictures/Screenshots.
import { copyFileSync, mkdirSync } from 'node:fs'
import { randomBytes } from 'node:crypto'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import dbus from 'dbus-next'
import { screenshotFileName, type CaptureKind } from './capture'

const { Message, Variant } = dbus
const PORTAL = 'org.freedesktop.portal.Desktop'
const PORTAL_PATH = '/org/freedesktop/portal/desktop'

type Bus = InstanceType<typeof dbus.MessageBus>

/** The Request object path the portal will use for this sender and token (portal spec, "Request"). */
export function requestPath(uniqueName: string, token: string): string {
  return `/org/freedesktop/portal/desktop/request/${uniqueName.replace(/^:/, '').replace(/\./g, '_')}/${token}`
}

/** Same names as the shell's own screenshots (capture.ts). */
export const screenshotName = (now: Date) => screenshotFileName(now)

/** The shortcut's request: Print = 'print', --save (Super+Print), --window (Alt+Print), --snip / --interactive. */
export function cliKind(argv: string[]): CaptureKind {
  if (argv.includes('--snip') || argv.includes('--interactive')) return 'snip'
  if (argv.includes('--window')) return 'window'
  if (argv.includes('--save')) return 'save'
  return 'print'
}

/** Hands the request to the shell; false when it does not answer (then the portal takes the screenshot). */
export async function viaShell(bus: Bus, kind: CaptureKind, timeoutMs = 3000): Promise<boolean> {
  const call = bus.call(new Message({ destination: 'lk.worksuite.Shell1', path: '/lk/worksuite/Shell1', interface: 'lk.worksuite.Shell1', member: 'Capture', signature: 's', body: [kind] }))
  const timer = new Promise<null>((r) => setTimeout(() => r(null), timeoutMs))
  try { return (await Promise.race([call, timer])) !== null } catch { return false }
}

export type ShotResult = { ok: true; file: string } | { ok: false; error: 'cancelled' | 'failed' | 'no_portal' }

/** Asks the portal for a screenshot and copies it to `<picturesDir>/Screenshots/`. */
export async function takeScreenshot(bus: Bus, interactive: boolean, picturesDir: string, now = new Date(), timeoutMs = 60_000): Promise<ShotResult> {
  const token = `ws${randomBytes(6).toString('hex')}`
  // Subscribe before calling (the portal may answer at once); the bus has its unique name once this call returns.
  const rule = `type='signal',interface='org.freedesktop.portal.Request',member='Response'`
  await bus.call(new Message({ destination: 'org.freedesktop.DBus', path: '/org/freedesktop/DBus', interface: 'org.freedesktop.DBus', member: 'AddMatch', signature: 's', body: [rule] }))
  const req = requestPath((bus as unknown as { name: string | null }).name ?? '', token)
  const response = new Promise<{ code: number; uri: string | null }>((resolve) => {
    const timer = setTimeout(() => { bus.removeListener('message', on); resolve({ code: 2, uri: null }) }, timeoutMs)
    const on = (m: InstanceType<typeof Message>) => {
      if (m.type !== dbus.MessageType.SIGNAL || m.path !== req || m.member !== 'Response') return
      clearTimeout(timer)
      bus.removeListener('message', on)
      const [code, results] = m.body as [number, Record<string, InstanceType<typeof Variant>>]
      resolve({ code, uri: typeof results?.uri?.value === 'string' ? results.uri.value : null })
    }
    bus.on('message', on)
  })
  try {
    await bus.call(new Message({
      destination: PORTAL, path: PORTAL_PATH, interface: 'org.freedesktop.portal.Screenshot', member: 'Screenshot', signature: 'sa{sv}',
      body: ['', { handle_token: new Variant('s', token), interactive: new Variant('b', interactive) }],
    }))
  } catch { return { ok: false, error: 'no_portal' } }
  const r = await response
  if (r.code === 1) return { ok: false, error: 'cancelled' }
  if (r.code !== 0 || !r.uri?.startsWith('file://')) return { ok: false, error: 'failed' }
  try {
    const dir = path.join(picturesDir, 'Screenshots')
    mkdirSync(dir, { recursive: true })
    const file = path.join(dir, screenshotName(now))
    copyFileSync(fileURLToPath(r.uri), file)
    return { ok: true, file }
  } catch { return { ok: false, error: 'failed' } }
}

/** ~/Pictures unless XDG_PICTURES_DIR is set (xdg-user-dirs exports it in the session). */
export function picturesDir(env: NodeJS.ProcessEnv = process.env): string {
  return env.XDG_PICTURES_DIR || path.join(env.HOME || '/', 'Pictures')
}

// CLI: worksuite-screenshot [--save|--window|--snip|--interactive]
if (typeof require !== 'undefined' && typeof module !== 'undefined' && require.main === module) {
  const bus = dbus.sessionBus()
  const kind = cliKind(process.argv.slice(2))
  void viaShell(bus, kind).then(async (handled) => {
    if (handled) { bus.disconnect(); return }
    const r = await takeScreenshot(bus, kind === 'snip' || kind === 'window', picturesDir())
    if (r.ok) process.stdout.write(`${r.file}\n`)
    else process.stderr.write(`worksuite-screenshot: ${r.error}\n`)
    bus.disconnect()
    process.exitCode = r.ok || r.error === 'cancelled' ? 0 : 1
  })
}

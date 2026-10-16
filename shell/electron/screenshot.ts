// Screenshot shortcut (WSOS-DSK-011): Print / Shift+Print in Labwc run `worksuite-screenshot [--interactive]`, which
// asks xdg-desktop-portal (org.freedesktop.portal.Screenshot, backed by xdg-desktop-portal-wlr per
// services/session/portals/worksuite-portals.conf) for a screenshot and copies the result into
// ~/Pictures/Screenshots. Going through the portal keeps the compositor's screen-capture permission in one place.
import { copyFileSync, mkdirSync } from 'node:fs'
import { randomBytes } from 'node:crypto'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import dbus from 'dbus-next'

const { Message, Variant } = dbus
const PORTAL = 'org.freedesktop.portal.Desktop'
const PORTAL_PATH = '/org/freedesktop/portal/desktop'

type Bus = InstanceType<typeof dbus.MessageBus>

/** The Request object path the portal will use for this sender and token (portal spec, "Request"). */
export function requestPath(uniqueName: string, token: string): string {
  return `/org/freedesktop/portal/desktop/request/${uniqueName.replace(/^:/, '').replace(/\./g, '_')}/${token}`
}

export function screenshotName(now: Date): string {
  const p = (n: number) => String(n).padStart(2, '0')
  return `Screenshot ${now.getFullYear()}-${p(now.getMonth() + 1)}-${p(now.getDate())} ${p(now.getHours())}-${p(now.getMinutes())}-${p(now.getSeconds())}.png`
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

// CLI: worksuite-screenshot [--interactive]
if (typeof require !== 'undefined' && typeof module !== 'undefined' && require.main === module) {
  const bus = dbus.sessionBus()
  void takeScreenshot(bus, process.argv.includes('--interactive'), picturesDir()).then((r) => {
    if (r.ok) process.stdout.write(`${r.file}\n`)
    else process.stderr.write(`worksuite-screenshot: ${r.error}\n`)
    bus.disconnect()
    process.exitCode = r.ok || r.error === 'cancelled' ? 0 : 1
  })
}

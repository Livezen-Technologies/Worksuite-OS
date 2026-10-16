// The shell's org.freedesktop.Notifications server (WSOS-INT-007): the centre's rules, then a round trip on a
// private D-Bus session bus the way libnotify talks to it.
import { spawn, spawnSync, type ChildProcess } from 'node:child_process'
import dbus from 'dbus-next'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { CLOSED, NotificationCenter, actionPairs, plainBody, serveNotifications, signalsFor } from './notifications'

const { Message, Variant } = dbus

describe('notification centre', () => {
  it('keeps history, replaces by id, runs actions once and reports closes', () => {
    const closed: [number, number][] = []; const invoked: [number, string][] = []
    const c = new NotificationCenter((id, r) => closed.push([id, r]), (id, k) => invoked.push([id, k]), () => 5)
    const a = c.notify('Mail', 0, 'New mail', '<b>Hi</b> &amp; bye', ['reply', 'Reply', 'archive', 'Archive'], 1)
    const b = c.notify('Chat', 0, 'Ping', '', [], 2)
    expect(c.list().map((n) => n.id)).toEqual([b, a])
    expect(c.list()[1]).toMatchObject({ app: 'Mail', body: 'Hi & bye', actions: [{ key: 'reply', label: 'Reply' }, { key: 'archive', label: 'Archive' }] })
    expect(c.notify('Mail', a, 'New mail (2)', '', ['reply', 'Reply'], 1)).toBe(a)
    expect(c.list()).toHaveLength(2)
    expect(c.invoke(a, 'delete')).toBe(false)
    expect(c.invoke(a, 'reply')).toBe(true)
    expect(invoked).toEqual([[a, 'reply']])
    expect(closed).toEqual([[a, CLOSED.dismissed]])
    c.close(999, CLOSED.closedByCall)
    expect(closed).toHaveLength(1)
  })
  it('sanitises input', () => {
    expect(plainBody('<a href="x">link</a> &lt;3')).toBe('link <3')
    expect(actionPairs(['a', 'A', 'dangling'])).toEqual([{ key: 'a', label: 'A' }])
    expect(actionPairs('nope')).toEqual([])
  })
})

const haveDbus = spawnSync('sh', ['-c', 'command -v dbus-daemon']).status === 0
describe.skipIf(!haveDbus)('org.freedesktop.Notifications on a private bus', () => {
  let daemon: ChildProcess
  let server: InstanceType<typeof dbus.MessageBus>
  let client: InstanceType<typeof dbus.MessageBus>
  let center: NotificationCenter
  beforeAll(async () => {
    daemon = spawn('dbus-daemon', ['--session', '--nofork', '--print-address=1'], { stdio: ['ignore', 'pipe', 'ignore'] })
    const address = await new Promise<string>((resolve) => daemon.stdout!.once('data', (d) => resolve(String(d).trim())))
    server = dbus.sessionBus({ busAddress: address })
    const sig = signalsFor(server)
    center = new NotificationCenter(sig.closed, sig.invoked)
    expect(await serveNotifications(server, center)).toBe(true)
    client = dbus.sessionBus({ busAddress: address })
  })
  afterAll(() => { client?.disconnect(); server?.disconnect(); daemon?.kill() })

  const call = (member: string, signature = '', body: unknown[] = []) => client.call(new Message({
    destination: 'org.freedesktop.Notifications', path: '/org/freedesktop/Notifications', interface: 'org.freedesktop.Notifications', member, signature, body,
  }))

  it('answers capabilities, takes a notification with actions, and signals the chosen action', async () => {
    expect((await call('GetCapabilities'))!.body[0]).toEqual(['actions', 'body', 'persistence'])
    const r = await call('Notify', 'susssasa{sv}i', ['Calendar', 0, '', 'Standup in 5 min', 'Room 2', ['open', 'Open', 'snooze', 'Snooze'], { urgency: new Variant('y', 2) }, -1])
    const id = r!.body[0] as number
    expect(center.list()[0]).toMatchObject({ id, app: 'Calendar', summary: 'Standup in 5 min', urgency: 2 })
    await client.call(new Message({ destination: 'org.freedesktop.DBus', path: '/org/freedesktop/DBus', interface: 'org.freedesktop.DBus', member: 'AddMatch', signature: 's', body: ["type='signal',interface='org.freedesktop.Notifications'"] }))
    const got = new Promise<string[]>((resolve) => {
      const seen: string[] = []
      client.on('message', (m: InstanceType<typeof Message>) => {
        if (m.type !== dbus.MessageType.SIGNAL) return
        seen.push(`${m.member} ${m.body.join(' ')}`)
        if (seen.length === 2) resolve(seen)
      })
    })
    center.invoke(id, 'snooze')
    expect(await got).toEqual([`ActionInvoked ${id} snooze`, `NotificationClosed ${id} 2`])
  })
  it('closes on request', async () => {
    const id = (await call('Notify', 'susssasa{sv}i', ['Files', 0, '', 'Copied', '', [], {}, 5000]))!.body[0] as number
    await call('CloseNotification', 'u', [id])
    expect(center.list().some((n) => n.id === id)).toBe(false)
  })
})

describe('notification icons', () => {
  it('keeps app_icon, else desktop-entry, as a name or absolute path', async () => {
    const { notifyIcon } = await import('./notifications')
    expect(notifyIcon('firefox-esr', 'x')).toBe('firefox-esr')
    expect(notifyIcon('', 'org.gnome.Nautilus')).toBe('org.gnome.Nautilus')
    expect(notifyIcon('file:///usr/share/icons/hicolor/48x48/apps/a.png', null)).toBe('/usr/share/icons/hicolor/48x48/apps/a.png')
    expect(notifyIcon('../etc/passwd', 'bad name')).toBeNull()
    expect(notifyIcon(undefined, undefined)).toBeNull()
  })
})

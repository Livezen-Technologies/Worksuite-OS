// Runs the shell's real panel client (shell/electron/panel.ts) against the bridge; driven by test_shell_client.py.
import dbus from '../../../shell/node_modules/dbus-next/index.js'
import { PanelClient } from '../../../shell/electron/panel.ts'

const bus = dbus.sessionBus()
const log: string[] = []
const c = new PanelClient(bus as never, {
  windows: (w) => log.push('windows ' + w.map((x) => x.appId).join(',')),
  tray: (t) => log.push('tray ' + t.map((x) => x.id).join(',')),
  launcher: (a) => { log.push('launcher ' + a); process.stdout.write('') },
})
await c.start()
console.log('ready')
// The test adds a window, presses "Super" (busctl → Shell1), then writes "go" on stdin.
await new Promise<void>((r) => process.stdin.once('data', () => r()))
log.push('activate ' + JSON.stringify(await c.activate(c.windows[0]?.handle ?? '')))
log.push('stale ' + JSON.stringify(await c.close('nope')))
console.log(log.join('\n'))
bus.disconnect()

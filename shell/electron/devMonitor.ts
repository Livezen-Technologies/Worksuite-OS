// Vite dev-server middleware for the browser preview (vite.config.ts): answers src/lib/monitorApi.ts with this
// machine's real /proc, backlight and power-profiles state through the same code as electron/monitorHost.ts.
// Read-only: setting brightness or the power mode, and ending processes, are refused here.
import type { IncomingMessage, ServerResponse } from 'node:http'
import { homedir } from 'node:os'
import { descendants, health, monitorSampler, parseMeminfo, readAutostart, realProcSource } from './monitor'
import { quickBridge } from './quick'
import { realExec } from './system'

export function devMonitor() {
  const src = realProcSource(() => null)
  const sampler = monitorSampler(src, () => descendants(src, process.pid))
  const quick = quickBridge(realExec)
  let lastCpu: number | null = null
  const refused = { available: false, reason: 'preview_read_only' }
  return async (req: IncomingMessage, res: ServerResponse) => {
    const op = (req.url ?? '').replace(/^\//, '').split('?')[0]
    let body: unknown
    switch (op) {
      case 'sample': { const r = sampler.sample(); if (r.available) lastCpu = r.value.cpu.percent; body = r; break }
      case 'health': body = { available: true, value: await health(realExec, null, parseMeminfo(src.read('/proc/meminfo') ?? ''), lastCpu) }; break
      case 'startup': body = { available: true, value: readAutostart(homedir()) }; break
      case 'brightness': body = quick.brightness(); break
      default: body = refused
    }
    res.setHeader('content-type', 'application/json')
    res.end(JSON.stringify(body))
  }
}

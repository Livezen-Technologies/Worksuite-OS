// IPC for the system monitor (G11) and the quick settings panel (G01). Registered from main.ts through its
// sender-checked `handle`.
import { homedir } from 'node:os'
import { descendants, endProcess, health, monitorSampler, parseMeminfo, readAutostart, realProcSource } from './monitor'
import { quickBridge } from './quick'
import { realExec } from './system'
import { installedApps } from './xdg'

type Handle = (channel: string, fn: (...args: string[]) => unknown) => void

let readyMs: number | null = null
/** Process start → first window ready (the same number the perf probe prints, WSOS-PRF-002). */
export function markShellReady(ms: number) { if (readyMs == null) readyMs = ms }

export function startMonitorHost(handle: Handle) {
  let names: Map<string, string> | null = null
  const appName = (id: string) => {
    if (!names) { try { names = new Map(installedApps().map((a) => [a.id.replace(/\.desktop$/, ''), a.name])) } catch { names = new Map() } }
    return names.get(id) ?? null
  }
  const src = realProcSource(appName)
  const shellPids = () => descendants(src, process.pid)
  const sampler = monitorSampler(src, shellPids)
  let lastCpu: number | null = null
  handle('ws:monitorSample', () => {
    const r = sampler.sample()
    if (r.available) lastCpu = r.value.cpu.percent
    return r
  })
  handle('ws:monitorHealth', async () => ({ available: true, value: await health(realExec, readyMs, parseMeminfo(src.read('/proc/meminfo') ?? ''), lastCpu) }))
  handle('ws:monitorStartup', () => ({ available: true, value: readAutostart(homedir()) }))
  handle('ws:monitorEnd', (pid) => {
    const uid = src.uid
    const own = (p: number) => uid != null && Number(/^Uid:\s+(\d+)/m.exec(src.read(`/proc/${p}/status`) ?? '')?.[1]) === uid
    return endProcess(Number(pid), own, (p, s) => process.kill(p, s), shellPids())
  })

  const quick = quickBridge(realExec)
  handle('ws:sysBrightness', () => quick.brightness())
  handle('ws:sysSetBrightness', (p) => quick.setBrightness(Number(p)))
}

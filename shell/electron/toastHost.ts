// Notification pop-ups over the apps. The shell's window is always below them (Labwc rc.xml), so a toast drawn in it
// was invisible whenever an app was open. worksuite-toasts (services/session/toasts) draws them on a layer-shell
// overlay surface, top-right on the active output; this host feeds it one JSON line per toast and hears back
// "click <key>" / "closed <key>". Without it (exit 69: no gtk4-layer-shell) the renderer keeps its in-window toast.
import { spawn } from 'node:child_process'

export const WORKSUITE_TOASTS = '/usr/lib/worksuite/worksuite-toasts'

export interface ToastMsg { key: string; title: string; body?: string; tone?: 'ok' | 'warn' | 'error'; icon?: string | null; sticky?: boolean }
export interface ToastProc { write(line: string): void; onLine(cb: (l: string) => void): void; onExit(cb: (code: number | null) => void): void; kill(): void }
export type ToastSpawn = () => ToastProc | null

const realSpawn: ToastSpawn = () => {
  try {
    const p = spawn(WORKSUITE_TOASTS, [], { stdio: ['pipe', 'pipe', 'ignore'] })
    p.on('error', () => undefined)
    p.stdin.on('error', () => undefined)
    let buf = ''
    const subs: ((l: string) => void)[] = []
    p.stdout.on('data', (d: Buffer) => {
      buf += d.toString('utf8')
      const lines = buf.split('\n'); buf = lines.pop() ?? ''
      for (const l of lines) for (const s of subs) s(l)
    })
    return { write: (l) => { if (p.stdin.writable) p.stdin.write(l) }, onLine: (cb) => { subs.push(cb) }, onExit: (cb) => { p.on('exit', cb) }, kill: () => { p.kill() } }
  } catch { return null }
}

const KEY = /^[A-Za-z0-9._:-]{1,64}$/

export function toastHost(onClick: (key: string) => void, spawnFn: ToastSpawn = realSpawn, restartMs = 2000) {
  let proc: ToastProc | null = null
  let unavailable = false
  let crashes = 0
  function start() {
    if (proc || unavailable) return
    const p = spawnFn()
    if (!p) { unavailable = true; return }
    proc = p
    p.onLine((l) => { const m = /^click (\S+)$/.exec(l.trim()); if (m && KEY.test(m[1])) onClick(m[1]) })
    p.onExit((code) => {
      if (proc === p) proc = null
      // 69: no layer-shell here; three crashes: give up. Otherwise start again for the next toast.
      if (code === 69 || ++crashes >= 3) unavailable = true
      else setTimeout(start, restartMs)
    })
  }
  const send = (o: unknown) => { start(); proc?.write(`${JSON.stringify(o)}\n`) }
  return {
    available: () => { start(); return !unavailable && !!proc },
    show(t: ToastMsg): boolean {
      if (!KEY.test(t.key)) return false
      send({ op: 'show', key: t.key, title: String(t.title ?? '').slice(0, 200), body: String(t.body ?? '').slice(0, 400), tone: t.tone ?? 'ok', icon: t.icon ?? '', sticky: !!t.sticky })
      return !unavailable
    },
    hide(key: string) { if (KEY.test(key) && proc) proc.write(`${JSON.stringify({ op: 'hide', key })}\n`) },
    stop() { unavailable = true; proc?.kill(); proc = null },
  }
}

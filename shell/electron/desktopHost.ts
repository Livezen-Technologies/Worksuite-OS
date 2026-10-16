// IPC for Settings › Default apps (WSOS-DSK-009), clipboard history (WSOS-DSK-008) and the recovery launcher's
// "Report problem" (WSOS-SES-005). Registered from main.ts through its sender-checked `handle`.
import { execFile } from 'node:child_process'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { clipboardHistory, wlClipboardIo } from './clipboard'
import { defaultApps, setDefaultApp } from './mimeapps'
import { installedApps } from './xdg'
import { xdgDirs } from './xdgDirs'

type Handle = (channel: string, fn: (...args: string[]) => unknown) => void
type Broadcast = (channel: string, payload: unknown) => void

/** Journal lines for the report: this boot's shell and session units, newest last. Fixed argv, no shell. */
export const REPORT_JOURNAL_ARGS = ['--user', '-b', '-n', '400', '--no-pager', '-o', 'short-iso', '-u', 'worksuite-shell.service', '-u', 'worksuite-session.target', '-u', 'worksuite-wayland-bridge.service']

export function reportName(now: Date): string {
  return `WorkSuite problem report ${now.toISOString().slice(0, 19).replace(/[:T]/g, '-')}.txt`
}

export function reportText(journal: string | null, now: Date, version: string): string {
  return [`WorkSuite OS problem report`, `Created: ${now.toISOString()}`, `Shell version: ${version}`, '',
    '--- Recent shell and session log ---', journal?.trim() || '(The log could not be read.)', ''].join('\n')
}

// ---- "The desktop restarted" notice (G12, WSOS-SES-004) ----
// systemd counts automatic restarts of worksuite-shell.service (NRestarts); apps live in app-worksuite-*.scope units
// outside the shell's cgroup, so the ones still running are the ones the restart kept. The count already shown is
// kept in $XDG_RUNTIME_DIR, which lives for the login session, so the notice appears once per restart.
export const NRESTARTS_ARGS = ['--user', 'show', 'worksuite-shell.service', '-p', 'NRestarts', '--value']
export const APP_SCOPES_ARGS = ['--user', 'list-units', '--type=scope', '--state=running', '--no-legend', '--plain', 'app-worksuite-*']

export function parseRestarts(out: string | null): number | null {
  const m = /^\s*(\d+)\s*$/.exec(out ?? '')
  return m ? Number(m[1]) : null
}
export function countAppScopes(out: string | null): number | null {
  if (out == null) return null
  return out.split('\n').filter((l) => /^\s*app-worksuite-\S+\.scope\s/.test(l)).length
}
/** Show the notice when the shell restarted more often than the count the user last saw this session. */
export function restartPending(restarts: number | null, seen: number | null): boolean {
  return restarts != null && restarts > (seen ?? 0)
}

export function startDesktopHost(handle: Handle, broadcast: Broadcast, home: string, version: string) {
  handle('ws:defaultApps', () => ({ ok: true, value: defaultApps(installedApps()) }))
  handle('ws:setDefaultApp', (category, id) => setDefaultApp(category, id, installedApps()))

  const clip = clipboardHistory(wlClipboardIo(), path.join(xdgDirs(home).config, 'worksuite', 'clipboard.json'))
  clip.onChange(() => broadcast('ws:clipboardChanged', clip.state()))
  clip.start()
  handle('ws:clipboardState', () => clip.state())
  handle('ws:clipboardSetEnabled', (on) => { clip.setEnabled(on === 'on'); return clip.state() })
  handle('ws:clipboardClear', () => { clip.clear(); return clip.state() })
  handle('ws:clipboardRemove', (id) => { clip.remove(Number(id)); return clip.state() })
  handle('ws:clipboardCopy', (id) => clip.copy(Number(id)))

  // Saved to the user's Documents (or home) so it can be attached to a support request; nothing is uploaded.
  handle('ws:problemReport', () => new Promise((resolve) => {
    execFile('journalctl', REPORT_JOURNAL_ARGS, { encoding: 'utf8', maxBuffer: 4 * 1024 * 1024, timeout: 10_000 }, (err, stdout) => {
      const now = new Date()
      const dir = path.join(home, 'Documents')
      const name = reportName(now)
      try {
        mkdirSync(dir, { recursive: true })
        writeFileSync(path.join(dir, name), reportText(err ? null : stdout, now, version), { mode: 0o600 })
        resolve({ ok: true, value: path.join('Documents', name) })
      } catch { resolve({ ok: false, error: 'write_failed' }) }
    })
  }))

  const runtime = process.env.XDG_RUNTIME_DIR
  const seenFile = runtime ? path.join(runtime, 'worksuite', 'shell-restarts-seen') : null
  const systemctl = (args: string[]) => new Promise<string | null>((resolve) =>
    execFile('systemctl', args, { encoding: 'utf8', timeout: 5000 }, (err, out) => resolve(err ? null : out)))
  handle('ws:shellRestart', async () => {
    const restarts = parseRestarts(await systemctl(NRESTARTS_ARGS))
    let seen: number | null = null
    try { seen = seenFile ? parseRestarts(readFileSync(seenFile, 'utf8')) : null } catch { /* not shown yet */ }
    if (!restartPending(restarts, seen)) return { restarted: false, apps: null, restarts }
    return { restarted: true, apps: countAppScopes(await systemctl(APP_SCOPES_ARGS)), restarts }
  })
  handle('ws:shellRestartSeen', (n) => {
    if (!seenFile || !/^\d+$/.test(n)) return false
    try { mkdirSync(path.dirname(seenFile), { recursive: true, mode: 0o700 }); writeFileSync(seenFile, n, { mode: 0o600 }); return true } catch { return false }
  })
}

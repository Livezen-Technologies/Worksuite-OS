// IPC for Settings › Default apps (WSOS-DSK-009), clipboard history (WSOS-DSK-008) and the recovery launcher's
// "Report problem" (WSOS-SES-005). Registered from main.ts through its sender-checked `handle`.
import { execFile } from 'node:child_process'
import { mkdirSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { clipboardHistory, wlClipboardIo } from './clipboard'
import { defaultApps, setDefaultApp } from './mimeapps'
import { installedApps } from './xdg'

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

export function startDesktopHost(handle: Handle, broadcast: Broadcast, home: string, version: string) {
  handle('ws:defaultApps', () => ({ ok: true, value: defaultApps(installedApps()) }))
  handle('ws:setDefaultApp', (category, id) => setDefaultApp(category, id, installedApps()))

  const clip = clipboardHistory(wlClipboardIo(), path.join(home, '.config', 'worksuite', 'clipboard.json'))
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
}

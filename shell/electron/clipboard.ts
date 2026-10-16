// Clipboard history (WSOS-DSK-008). Off by default; when the user turns it on, the shell watches the Wayland
// clipboard with `wl-paste --watch` (wlr-data-control, so it sees copies from every app, not only when the shell has
// focus) and keeps the last text entries in memory only: nothing is written to disk and the list is gone at logout.
// Copies marked secret by the source are never recorded: password managers and toolkits set
// `x-kde-passwordManagerHint: secret` (KeePassXC, KDE, Chromium/Electron password fields with that hint) or the
// concealed-type markers below. The list can be cleared at any time, and turning history off clears it.
import { execFile, spawn } from 'node:child_process'
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import path from 'node:path'

export const MAX_ENTRIES = 25
export const MAX_BYTES = 64 * 1024

/** MIME types a source offers to say "do not record this". */
export const SECRET_MARKERS = ['x-kde-passwordManagerHint', 'application/x-nspasteboard-concealed-type', 'ExcludeClipboardContentFromMonitorProcessing']

export interface ClipEntry { id: number; text: string; at: number }

export interface ClipIo {
  /** MIME types the current selection offers (`wl-paste --list-types`), or null when there is no selection. */
  types(): Promise<string[] | null>
  /** Content for one type (`wl-paste --no-newline --type <t>`), or null. */
  read(type: string): Promise<string | null>
  /** Puts text back on the clipboard (`wl-copy`, text on stdin). */
  write(text: string): Promise<boolean>
  /** Calls onChange for every new selection until the returned stop is called (`wl-paste --watch`). */
  watch(onChange: () => void): () => void
}

export interface ClipSettings { enabled: boolean }

/** Whether the offered types mark the copy as secret. A KDE hint with any value other than "secret" does not. */
export async function isSecret(types: string[], read: (t: string) => Promise<string | null>): Promise<boolean> {
  if (types.includes('application/x-nspasteboard-concealed-type') || types.includes('ExcludeClipboardContentFromMonitorProcessing')) return true
  if (types.includes('x-kde-passwordManagerHint')) return ((await read('x-kde-passwordManagerHint')) ?? 'secret').trim() === 'secret'
  return false
}

const TEXT_TYPES = ['text/plain;charset=utf-8', 'UTF8_STRING', 'text/plain', 'STRING', 'TEXT']

export function clipboardHistory(io: ClipIo, settingsFile: string | null, now: () => number = Date.now) {
  let entries: ClipEntry[] = []
  let next = 1
  let stop: (() => void) | null = null
  let enabled = false
  const listeners = new Set<(e: ClipEntry[]) => void>()
  const emit = () => listeners.forEach((l) => l(entries.slice()))

  async function capture() {
    const types = await io.types()
    if (!types || !enabled) return
    if (await isSecret(types, (t) => io.read(t))) return
    const type = TEXT_TYPES.find((t) => types.includes(t))
    if (!type) return
    const text = await io.read(type)
    if (!enabled || !text || !text.trim() || Buffer.byteLength(text) > MAX_BYTES) return
    entries = [{ id: next++, text, at: now() }, ...entries.filter((e) => e.text !== text)].slice(0, MAX_ENTRIES)
    emit()
  }

  function save() {
    if (!settingsFile) return
    try {
      mkdirSync(path.dirname(settingsFile), { recursive: true })
      const tmp = `${settingsFile}.tmp-${process.pid}`
      writeFileSync(tmp, JSON.stringify({ enabled }) + '\n', { mode: 0o600 })
      renameSync(tmp, settingsFile)
    } catch { /* setting stays for this session only */ }
  }

  function setEnabled(on: boolean, persist = true) {
    if (on === enabled) return
    enabled = on
    if (on) stop = io.watch(() => void capture())
    else { stop?.(); stop = null; entries = []; emit() }
    if (persist) save()
  }

  return {
    /** Reads the saved setting; history starts off unless the user turned it on earlier. */
    start() {
      let saved = false
      if (settingsFile) try { saved = (JSON.parse(readFileSync(settingsFile, 'utf8')) as ClipSettings).enabled === true } catch { /* default off */ }
      setEnabled(saved, false)
    },
    state: () => ({ enabled, entries: entries.slice() }),
    setEnabled,
    clear() { entries = []; emit() },
    remove(id: number) { entries = entries.filter((e) => e.id !== id); emit() },
    async copy(id: number) { const e = entries.find((x) => x.id === id); return e ? io.write(e.text) : false },
    onChange(l: (e: ClipEntry[]) => void) { listeners.add(l); return () => { listeners.delete(l) } },
    /** For tests: run one capture as if the selection changed. */
    capture,
  }
}

/**
 * wl-clipboard backend. Fixed argument arrays, no shell; clipboard text travels on stdin/stdout only, never argv.
 * `env` lets tests point it at a headless compositor.
 */
export function wlClipboardIo(env: NodeJS.ProcessEnv = process.env): ClipIo {
  const out = (args: string[]) => new Promise<string | null>((resolve) => {
    execFile('wl-paste', args, { env, encoding: 'utf8', maxBuffer: MAX_BYTES * 2, timeout: 3000 }, (err, stdout) => resolve(err ? null : stdout))
  })
  return {
    async types() { const s = await out(['--list-types']); return s === null ? null : s.split('\n').map((l) => l.trim()).filter(Boolean) },
    read: (type) => out(['--no-newline', '--type', type]),
    write: (text) => new Promise((resolve) => {
      const p = spawn('wl-copy', ['--type', 'text/plain;charset=utf-8'], { env, stdio: ['pipe', 'ignore', 'ignore'] })
      p.on('error', () => resolve(false))
      p.on('exit', (code) => resolve(code === 0))
      p.stdin.end(text)
    }),
    watch(onChange) {
      // `echo` ignores the content wl-paste hands it and prints one line per new selection.
      const p = spawn('wl-paste', ['--watch', 'echo'], { env, stdio: ['ignore', 'pipe', 'ignore'] })
      p.on('error', () => undefined)
      p.stdout.setEncoding('utf8')
      p.stdout.on('data', (d: string) => { for (let i = 0; i < d.split('\n').length - 1; i++) onChange() })
      return () => { p.kill() }
    },
  }
}

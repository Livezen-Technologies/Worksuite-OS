// Clipboard history (WSOS-DSK-008), Super+V. Off by default, like Windows; when the user turns it on (Settings ›
// Clipboard) the shell watches the Wayland clipboard with `wl-paste --watch` (wlr-data-control, so it sees copies from
// every app, not only when the shell has focus) and keeps the last copies in memory: text, images and files.
// * Up to MAX_ENTRIES items, newest first; copying the same thing again moves it to the top instead of adding it twice.
// * Pinned items stay when the list is cleared and are kept across sign-ins in an encrypted file in the user's config
//   folder (mode 0600, AES-256-GCM, its key in the login keyring through `secret-tool`). Without a keyring nothing is
//   written: pins then last for the session. Unpinned items are never written to disk and are gone at logout.
// * Copies marked secret by the source are never recorded: password managers and toolkits set
//   `x-kde-passwordManagerHint: secret` (KeePassXC, KDE, Chromium/Electron password fields with that hint) or the
//   concealed-type markers below. Copies made while an app on the deny list has the focus are skipped as well
//   (Wayland does not say which client owns a selection; the focused window is the one that copied in practice).
// * Policy `clipboard_history: disabled` (or a kiosk device) turns it off and keeps it off; the list is dropped.
// Nothing here ever leaves the device.
import { execFile, spawn } from 'node:child_process'
import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto'
import { chmodSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import path from 'node:path'

export const MAX_ENTRIES = 25
export const MAX_PINNED = 25
export const MAX_BYTES = 64 * 1024
export const MAX_IMAGE_BYTES = 8 * 1024 * 1024
export const MAX_FILES = 100

/** MIME types a source offers to say "do not record this". */
export const SECRET_MARKERS = ['x-kde-passwordManagerHint', 'application/x-nspasteboard-concealed-type', 'ExcludeClipboardContentFromMonitorProcessing']

/** Apps whose copies are never recorded (Wayland app_id, lower case): password managers and the like. Users and
 *  administrators can add more in clipboard.json's `deny`. */
export const DENY_APPS = ['org.keepassxc.keepassxc', 'keepassxc', 'bitwarden', 'com.bitwarden.desktop', '1password', 'org.gnome.world.secrets',
  'org.gnome.seahorse.application', 'seahorse', 'enpass', 'proton-pass', 'me.proton.pass']

export type ClipKind = 'text' | 'image' | 'files'
export interface ClipEntry {
  id: number
  kind: ClipKind
  /** Text, or for files their names one per line, or for images "" (the renderer shows `image`). */
  text: string
  at: number
  pinned: boolean
  /** image: a data: URL to show (a scaled-down preview for large ones). */
  image?: string
  /** files: absolute paths (file:// URIs in the clipboard). */
  files?: string[]
  /** image: its MIME type and size in bytes. */
  mime?: string
  size?: number
}
/** What the renderer gets: blocked = turned off by policy; persist = pins are kept across sign-ins. */
export interface ClipState { enabled: boolean; entries: ClipEntry[]; blocked?: boolean; persist?: boolean }

export interface ClipIo {
  /** MIME types the current selection offers (`wl-paste --list-types`), or null when there is no selection. */
  types(): Promise<string[] | null>
  /** Content for one type as text (`wl-paste --no-newline --type <t>`), or null. */
  read(type: string): Promise<string | null>
  /** Content for one type as bytes, or null. Optional: text-only backends (tests) leave it out. */
  readBytes?(type: string, max: number): Promise<Buffer | null>
  /** Puts text back on the clipboard (`wl-copy`, text on stdin). */
  write(text: string): Promise<boolean>
  /** Puts bytes of one type on the clipboard (`wl-copy --type <t>`). */
  writeBytes?(type: string, data: Buffer): Promise<boolean>
  /** Calls onChange for every new selection until the returned stop is called (`wl-paste --watch`). */
  watch(onChange: () => void): () => void
}

/** Pinned items across sign-ins. load() gives [] when there is nothing (or it cannot be read); save() may fail quietly. */
export interface PinStore { available(): Promise<boolean>; load(): Promise<StoredPin[]>; save(pins: StoredPin[]): Promise<void>; clear(): Promise<void> }
export interface StoredPin { kind: ClipKind; text: string; at: number; files?: string[]; mime?: string; data?: string /* base64 */ }

export interface ClipSettings { enabled: boolean; deny?: string[] }

export interface ClipDeps {
  now?: () => number
  /** The focused app's app_id (lower case), or null. */
  focusedApp?: () => string | null
  /** false while policy (clipboard_history: disabled, kiosk) turns history off. */
  allowed?: () => boolean
  /** A data: URL preview for an image (main process: Electron nativeImage, scaled to fit 360×240). */
  preview?: (data: Buffer, mime: string) => string | null
  pins?: PinStore | null
}

/** Whether the offered types mark the copy as secret. A KDE hint with any value other than "secret" does not. */
export async function isSecret(types: string[], read: (t: string) => Promise<string | null>): Promise<boolean> {
  if (types.includes('application/x-nspasteboard-concealed-type') || types.includes('ExcludeClipboardContentFromMonitorProcessing')) return true
  if (types.includes('x-kde-passwordManagerHint')) return ((await read('x-kde-passwordManagerHint')) ?? 'secret').trim() === 'secret'
  return false
}

export const TEXT_TYPES = ['text/plain;charset=utf-8', 'UTF8_STRING', 'text/plain', 'STRING', 'TEXT']
export const IMAGE_TYPES = ['image/png', 'image/jpeg', 'image/webp', 'image/gif', 'image/bmp']
export const FILE_TYPES = ['text/uri-list', 'x-special/gnome-copied-files']

/** Local paths from a text/uri-list (or GNOME's "copy\nfile:///…" list); other schemes are dropped. */
export function parseUriList(s: string): string[] {
  const out: string[] = []
  for (const raw of s.split(/\r?\n/)) {
    const l = raw.trim()
    if (!l.startsWith('file://')) continue
    try { const p = decodeURIComponent(new URL(l).pathname); if (p.startsWith('/') && !out.includes(p)) out.push(p) } catch { /* not a URI */ }
    if (out.length >= MAX_FILES) break
  }
  return out
}
export const uriList = (files: string[]) => files.map((f) => `file://${f.split('/').map(encodeURIComponent).join('/')}`).join('\r\n') + '\r\n'

/** What makes two entries the same copy. */
export function entryKey(e: Pick<ClipEntry, 'kind' | 'text' | 'files'> & { hash?: string }): string {
  if (e.kind === 'image') return `i:${e.hash ?? ''}`
  if (e.kind === 'files') return `f:${(e.files ?? []).join('\n')}`
  return `t:${e.text}`
}

/** Newest first, the same copy only once (a pinned one keeps its pin), at most MAX_ENTRIES unpinned and MAX_PINNED pinned. */
export function addEntry<T extends ClipEntry & { key: string }>(list: T[], e: T): T[] {
  const old = list.find((x) => x.key === e.key)
  const next = [{ ...e, pinned: e.pinned || !!old?.pinned }, ...list.filter((x) => x.key !== e.key)]
  let unpinned = 0, pinned = 0
  return next.filter((x) => (x.pinned ? ++pinned <= MAX_PINNED : ++unpinned <= MAX_ENTRIES))
}

interface Item extends ClipEntry { key: string; data?: Buffer }
const sha = (b: Buffer | string) => createHash('sha256').update(b).digest('hex')

export function clipboardHistory(io: ClipIo, settingsFile: string | null, depsOrNow: ClipDeps | (() => number) = {}) {
  const deps: ClipDeps = typeof depsOrNow === 'function' ? { now: depsOrNow } : depsOrNow
  const now = deps.now ?? Date.now
  const allowed = deps.allowed ?? (() => true)
  let items: Item[] = []
  let next = 1
  let stop: (() => void) | null = null
  let enabled = false
  let deny = new Set(DENY_APPS)
  let persist = false
  // Our own writes (copy back, paste) come back through the watch: they only move the entry to the top.
  const listeners = new Set<(s: ClipState) => void>()
  const view = (i: Item): ClipEntry => {
    const { key: _k, data: _d, ...e } = i
    return e
  }
  const state = (): ClipState => ({ enabled: enabled && allowed(), entries: enabled && allowed() ? items.map(view) : [], blocked: !allowed(), persist })
  const emit = () => { const s = state(); listeners.forEach((l) => l(s)) }

  async function capture() {
    if (!enabled) return
    if (!allowed()) { setEnabled(false, false); return }
    const types = await io.types()
    if (!types || !enabled) return
    if (await isSecret(types, (t) => io.read(t))) return
    const app = deps.focusedApp?.()?.toLowerCase() ?? null
    if (app && deny.has(app)) return
    let item: Item | null = null
    const fileType = FILE_TYPES.find((t) => types.includes(t))
    const imageType = IMAGE_TYPES.find((t) => types.includes(t))
    const textType = TEXT_TYPES.find((t) => types.includes(t))
    if (fileType) {
      const files = parseUriList((await io.read(fileType)) ?? '')
      if (files.length) item = { id: 0, kind: 'files', text: files.map((f) => path.basename(f)).join('\n'), files, at: now(), pinned: false, key: '' }
    }
    if (!item && imageType && io.readBytes) {
      const data = await io.readBytes(imageType, MAX_IMAGE_BYTES)
      if (data && data.length && data.length <= MAX_IMAGE_BYTES) {
        item = { id: 0, kind: 'image', text: '', at: now(), pinned: false, mime: imageType, size: data.length, data, image: deps.preview?.(data, imageType) ?? undefined, key: `i:${sha(data)}` }
      }
    }
    if (!item && textType) {
      const text = await io.read(textType)
      if (text && text.trim() && Buffer.byteLength(text) <= MAX_BYTES) item = { id: 0, kind: 'text', text, at: now(), pinned: false, key: '' }
    }
    if (!item || !enabled) return
    if (!item.key) item.key = entryKey(item)
    item.id = next++
    const before = items.filter((x) => x.pinned).map((x) => x.key).join()
    items = addEntry(items, item)
    if (items.filter((x) => x.pinned).map((x) => x.key).join() !== before) void savePins()
    emit()
  }

  function loadSettings(): ClipSettings {
    if (!settingsFile) return { enabled: false }
    try { const s = JSON.parse(readFileSync(settingsFile, 'utf8')) as ClipSettings; return { enabled: s.enabled === true, deny: Array.isArray(s.deny) ? s.deny.filter((x) => typeof x === 'string').slice(0, 100) : undefined } } catch { return { enabled: false } }
  }
  function save() {
    if (!settingsFile) return
    try {
      mkdirSync(path.dirname(settingsFile), { recursive: true })
      const tmp = `${settingsFile}.tmp-${process.pid}`
      const extra = [...deny].filter((d) => !DENY_APPS.includes(d))
      writeFileSync(tmp, JSON.stringify(extra.length ? { enabled, deny: extra } : { enabled }) + '\n', { mode: 0o600 })
      renameSync(tmp, settingsFile)
    } catch { /* setting stays for this session only */ }
  }

  async function savePins() {
    if (!deps.pins || !persist) return
    const pins: StoredPin[] = items.filter((x) => x.pinned).map((x) => ({ kind: x.kind, text: x.text, at: x.at, files: x.files, mime: x.mime, data: x.data?.toString('base64') }))
    await deps.pins.save(pins).catch(() => undefined)
  }
  async function loadPins() {
    if (!deps.pins) return
    persist = await deps.pins.available().catch(() => false)
    if (!persist) return
    const pins = await deps.pins.load().catch(() => [] as StoredPin[])
    if (!enabled) return
    for (const p of pins.slice(0, MAX_PINNED).reverse()) {
      const data = p.kind === 'image' && p.data ? Buffer.from(p.data, 'base64') : undefined
      if (p.kind === 'image' && (!data || data.length > MAX_IMAGE_BYTES)) continue
      const it: Item = { id: next++, kind: p.kind, text: String(p.text ?? ''), at: Number(p.at) || now(), pinned: true, files: p.files, mime: p.mime, data, size: data?.length,
        image: data ? deps.preview?.(data, p.mime ?? 'image/png') ?? undefined : undefined, key: '' }
      it.key = data ? `i:${sha(data)}` : entryKey(it)
      if (!items.some((x) => x.key === it.key)) items = [...items, it]
    }
    emit()
  }

  function setEnabled(on: boolean, persistSetting = true) {
    if (on && !allowed()) on = false
    if (on === enabled) { if (persistSetting) save(); return }
    enabled = on
    if (on) { stop = io.watch(() => void capture()); void loadPins() }
    else { stop?.(); stop = null; items = []; emit() }
    if (persistSetting) save()
    emit()
  }

  async function writeBack(e: Item): Promise<boolean> {
    if (e.kind === 'image' && e.data && io.writeBytes) return io.writeBytes(e.mime ?? 'image/png', e.data)
    if (e.kind === 'files' && e.files?.length && io.writeBytes) return io.writeBytes('text/uri-list', Buffer.from(uriList(e.files)))
    return io.write(e.text)
  }

  return {
    /** Reads the saved setting; history starts off unless the user turned it on earlier (and policy allows it). */
    start() {
      const s = loadSettings()
      if (s.deny) deny = new Set([...DENY_APPS, ...s.deny.map((d) => d.toLowerCase())])
      setEnabled(s.enabled, false)
    },
    state,
    setEnabled,
    /** Policy changed: history goes off (and its list away) when it is no longer allowed. */
    policyChanged() { if (enabled && !allowed()) setEnabled(false, false); else emit() },
    /** "Clear all" in the flyout and Settings' "Clear clipboard data": pinned items stay (like Windows) unless `pinned`. */
    async clear(pinned = false) {
      items = pinned ? [] : items.filter((x) => x.pinned)
      if (pinned) await deps.pins?.clear().catch(() => undefined)
      emit()
    },
    remove(id: number) {
      const was = items.find((e) => e.id === id)
      items = items.filter((e) => e.id !== id)
      if (was?.pinned) void savePins()
      emit()
    },
    pin(id: number, on: boolean) {
      const e = items.find((x) => x.id === id)
      if (!e || e.pinned === on) return false
      if (on && items.filter((x) => x.pinned).length >= MAX_PINNED) return false
      items = items.map((x) => (x.id === id ? { ...x, pinned: on } : x))
      void savePins()
      emit()
      return true
    },
    /** Puts the entry back on the clipboard (and at the top of the list). */
    async copy(id: number) {
      const e = items.find((x) => x.id === id)
      if (!e) return false
      items = [e, ...items.filter((x) => x !== e)]
      emit()
      return writeBack(e)
    },
    /** Puts any text on the clipboard (emoji and symbols from the flyout). */
    copyText: (text: string) => io.write(String(text).slice(0, MAX_BYTES)),
    onChange(l: (s: ClipState) => void) { listeners.add(l); return () => { listeners.delete(l) } },
    /** For tests: run one capture as if the selection changed. */
    capture,
  }
}

/**
 * wl-clipboard backend. Fixed argument arrays, no shell; clipboard content travels on stdin/stdout only, never argv.
 * `env` lets tests point it at a headless compositor.
 */
export function wlClipboardIo(env: NodeJS.ProcessEnv = process.env): ClipIo {
  const out = (args: string[]) => new Promise<string | null>((resolve) => {
    execFile('wl-paste', args, { env, encoding: 'utf8', maxBuffer: MAX_BYTES * 2, timeout: 3000 }, (err, stdout) => resolve(err ? null : stdout))
  })
  const put = (args: string[], data: Buffer | string) => new Promise<boolean>((resolve) => {
    const p = spawn('wl-copy', args, { env, stdio: ['pipe', 'ignore', 'ignore'] })
    p.on('error', () => resolve(false))
    p.on('exit', (code) => resolve(code === 0))
    p.stdin.on('error', () => undefined)
    p.stdin.end(data)
  })
  return {
    async types() { const s = await out(['--list-types']); return s === null ? null : s.split('\n').map((l) => l.trim()).filter(Boolean) },
    read: (type) => out(['--no-newline', '--type', type]),
    readBytes: (type, max) => new Promise((resolve) => {
      execFile('wl-paste', ['--no-newline', '--type', type], { env, encoding: 'buffer', maxBuffer: max, timeout: 5000 }, (err, stdout) => resolve(err ? null : stdout))
    }),
    write: (text) => put(['--type', 'text/plain;charset=utf-8'], text),
    writeBytes: (type, data) => put(['--type', type], data),
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

// ---- pinned items on disk, encrypted ----------------------------------------------------------------------------
/** Where the key lives: the login keyring (gnome-keyring, unlocked by PAM at sign-in) through libsecret's CLI. */
export interface KeyStore { get(): Promise<Buffer | null>; create(): Promise<Buffer | null> }
const SECRET_ATTRS = ['application', 'worksuite', 'purpose', 'clipboard-pins']

export function secretToolKeys(env: NodeJS.ProcessEnv = process.env): KeyStore {
  const lookup = () => new Promise<Buffer | null>((resolve) => {
    execFile('secret-tool', ['lookup', ...SECRET_ATTRS], { env, encoding: 'utf8', timeout: 5000 }, (err, stdout) => {
      const k = !err ? Buffer.from(stdout.trim(), 'base64') : null
      resolve(k && k.length === 32 ? k : null)
    })
  })
  return {
    get: lookup,
    async create() {
      const key = randomBytes(32)
      const ok = await new Promise<boolean>((resolve) => {
        const p = spawn('secret-tool', ['store', '--label=WorkSuite clipboard pins', ...SECRET_ATTRS], { env, stdio: ['pipe', 'ignore', 'ignore'] })
        p.on('error', () => resolve(false))
        p.on('exit', (c) => resolve(c === 0))
        p.stdin.on('error', () => undefined)
        p.stdin.end(key.toString('base64'))
      })
      return ok ? key : null
    },
  }
}

export function encryptPins(pins: StoredPin[], key: Buffer): string {
  const iv = randomBytes(12)
  const c = createCipheriv('aes-256-gcm', key, iv)
  const data = Buffer.concat([c.update(JSON.stringify(pins), 'utf8'), c.final()])
  return JSON.stringify({ v: 1, iv: iv.toString('base64'), tag: c.getAuthTag().toString('base64'), data: data.toString('base64') }) + '\n'
}
export function decryptPins(text: string, key: Buffer): StoredPin[] {
  const f = JSON.parse(text) as { v: number; iv: string; tag: string; data: string }
  if (f.v !== 1) return []
  const d = createDecipheriv('aes-256-gcm', key, Buffer.from(f.iv, 'base64'))
  d.setAuthTag(Buffer.from(f.tag, 'base64'))
  const json = Buffer.concat([d.update(Buffer.from(f.data, 'base64')), d.final()]).toString('utf8')
  const v = JSON.parse(json) as unknown
  return Array.isArray(v) ? v.filter((p): p is StoredPin => !!p && typeof p === 'object' && ['text', 'image', 'files'].includes((p as StoredPin).kind)) : []
}

export function encryptedPinStore(file: string, keys: KeyStore): PinStore {
  let key: Buffer | null | undefined
  const getKey = async (create: boolean) => {
    if (key) return key
    key = await keys.get()
    if (!key && create) key = await keys.create()
    return key
  }
  return {
    async available() { return (await getKey(true)) !== null },
    async load() {
      const k = await getKey(false)
      if (!k) return []
      try { return decryptPins(readFileSync(file, 'utf8'), k) } catch { return [] }
    },
    async save(pins) {
      const k = await getKey(true)
      if (!k) return
      if (!pins.length) { rmSync(file, { force: true }); return }
      mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 })
      const tmp = `${file}.tmp-${process.pid}`
      writeFileSync(tmp, encryptPins(pins, k), { mode: 0o600 })
      chmodSync(tmp, 0o600)
      renameSync(tmp, file)
    },
    async clear() { rmSync(file, { force: true }) },
  }
}

/** Policy: allowed unless clipboard_history is disabled; never on a kiosk. */
export const clipboardAllowed = (p: { clipboard_history?: string | null; kiosk?: boolean } | null | undefined) => p?.clipboard_history !== 'disabled' && p?.kiosk !== true

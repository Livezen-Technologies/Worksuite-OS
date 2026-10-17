import { spawn, spawnSync, type ChildProcess } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { addEntry, clipboardHistory, decryptPins, encryptedPinStore, encryptPins, isSecret, MAX_ENTRIES, MAX_PINNED, parseUriList, uriList, wlClipboardIo, type ClipEntry, type ClipIo, type KeyStore, type PinStore, type StoredPin } from './clipboard'

/** In-memory clipboard: set() is a copy from some app. */
function fakeIo() {
  let sel: Record<string, string | Buffer> | null = null
  let cb: (() => void) | null = null
  const io: ClipIo = {
    async types() { return sel ? Object.keys(sel) : null },
    async read(t) { const v = sel?.[t]; return v == null ? null : String(v) },
    async readBytes(t) { const v = sel?.[t]; return v == null ? null : Buffer.isBuffer(v) ? v : Buffer.from(v) },
    async write(text) { sel = { 'text/plain': text }; return true },
    async writeBytes(t, data) { sel = { [t]: data }; return true },
    watch(on) { cb = on; return () => { cb = null } },
  }
  return { io, watching: () => cb !== null, set: (s: Record<string, string | Buffer>) => { sel = s; cb?.() }, current: () => sel }
}
/** A keyring in memory, and a pin store over it in a temporary folder. */
function memKeys(): KeyStore & { key: Buffer | null } {
  const k = { key: null as Buffer | null, async get() { return k.key }, async create() { k.key = Buffer.alloc(32, 7); return k.key } }
  return k
}
const tick = () => new Promise((r) => setTimeout(r, 0))

describe('clipboard history', () => {
  it('is off by default and records nothing until turned on', async () => {
    const f = fakeIo()
    const h = clipboardHistory(f.io, null)
    h.start()
    expect(h.state().enabled).toBe(false)
    expect(f.watching()).toBe(false)
    f.set({ 'text/plain': 'hello' })
    await h.capture()
    expect(h.state().entries).toEqual([])
  })

  it('records text copies newest first, without duplicates, up to the limit', async () => {
    const f = fakeIo()
    const h = clipboardHistory(f.io, null, () => 5)
    h.setEnabled(true)
    f.set({ 'text/plain': 'a' }); await tick()
    f.set({ 'text/plain': 'b' }); await tick()
    f.set({ 'text/plain': 'a' }); await tick()
    expect(h.state().entries.map((e) => e.text)).toEqual(['a', 'b'])
    for (let i = 0; i < 40; i++) { f.set({ 'text/plain': `x${i}` }); await tick() }
    expect(h.state().entries).toHaveLength(MAX_ENTRIES)
  })

  it('never records copies marked as passwords', async () => {
    const f = fakeIo()
    const h = clipboardHistory(f.io, null)
    h.setEnabled(true)
    f.set({ 'text/plain': 'hunter2', 'x-kde-passwordManagerHint': 'secret' }); await tick()
    f.set({ 'text/plain': 'pw', 'application/x-nspasteboard-concealed-type': '' }); await tick()
    expect(h.state().entries).toEqual([])
    expect(await isSecret(['x-kde-passwordManagerHint'], async () => 'not-secret')).toBe(false)
  })

  it('clears, removes, copies back, and forgets everything when turned off', async () => {
    const f = fakeIo()
    const h = clipboardHistory(f.io, null)
    h.setEnabled(true)
    f.set({ 'text/plain': 'one' }); await tick()
    f.set({ 'text/plain': 'two' }); await tick()
    const [two, one] = h.state().entries
    h.remove(two.id)
    expect(h.state().entries.map((e) => e.text)).toEqual(['one'])
    expect(await h.copy(one.id)).toBe(true)
    expect(await f.io.read('text/plain')).toBe('one')
    h.clear()
    expect(h.state().entries).toEqual([])
    f.set({ 'text/plain': 'three' }); await tick()
    h.setEnabled(false)
    expect(h.state().entries).toEqual([])
    expect(f.watching()).toBe(false)
  })

  it('saves only the on/off setting, never the entries', async () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), 'clip-'))
    const file = path.join(dir, 'clipboard.json')
    const f = fakeIo()
    const h = clipboardHistory(f.io, file)
    h.setEnabled(true)
    f.set({ 'text/plain': 'private text' }); await tick()
    expect(readFileSync(file, 'utf8')).not.toContain('private')
    const again = clipboardHistory(fakeIo().io, file)
    again.start()
    expect(again.state()).toMatchObject({ enabled: true, entries: [], blocked: false })
  })

  it('records images and copied files, each once', async () => {
    const f = fakeIo()
    const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 1, 2, 3])
    const h = clipboardHistory(f.io, null, { preview: (d, m) => `data:${m};base64,${d.toString('base64')}` })
    h.setEnabled(true)
    f.set({ 'image/png': png, 'text/html': '<img>' }); await tick()
    f.set({ 'text/uri-list': 'file:///home/a/Report%201.pdf\r\nfile:///home/a/b.txt\r\n', 'text/plain': '/home/a/Report 1.pdf' }); await tick()
    f.set({ 'image/png': Buffer.from(png) }); await tick()
    const [img, files] = h.state().entries
    expect(img).toMatchObject({ kind: 'image', mime: 'image/png', size: 7, image: `data:image/png;base64,${png.toString('base64')}` })
    expect(files).toMatchObject({ kind: 'files', files: ['/home/a/Report 1.pdf', '/home/a/b.txt'], text: 'Report 1.pdf\nb.txt' })
    expect(h.state().entries).toHaveLength(2)
    expect(await h.copy(files.id)).toBe(true)
    expect(String(f.current()?.['text/uri-list'])).toBe('file:///home/a/Report%201.pdf\r\nfile:///home/a/b.txt\r\n')
    expect(await h.copy(img.id)).toBe(true)
    expect(f.current()?.['image/png']).toEqual(png)
  })

  it('pins: pinned items survive Clear all and do not count against the limit', async () => {
    const f = fakeIo()
    const h = clipboardHistory(f.io, null)
    h.setEnabled(true)
    f.set({ 'text/plain': 'keep me' }); await tick()
    expect(h.pin(h.state().entries[0].id, true)).toBe(true)
    for (let i = 0; i < 30; i++) { f.set({ 'text/plain': `n${i}` }); await tick() }
    const s = h.state().entries
    expect(s.filter((e) => !e.pinned)).toHaveLength(MAX_ENTRIES)
    expect(s.find((e) => e.pinned)?.text).toBe('keep me')
    // copying the pinned text again keeps the pin and puts it on top
    f.set({ 'text/plain': 'keep me' }); await tick()
    expect(h.state().entries[0]).toMatchObject({ text: 'keep me', pinned: true })
    await h.clear()
    expect(h.state().entries.map((e) => e.text)).toEqual(['keep me'])
    await h.clear(true)
    expect(h.state().entries).toEqual([])
  })

  it('addEntry caps pinned and unpinned separately', () => {
    let l: (ClipEntry & { key: string })[] = []
    for (let i = 0; i < MAX_PINNED + 5; i++) l = addEntry(l, { id: i, kind: 'text', text: `p${i}`, at: i, pinned: true, key: `t:p${i}` })
    for (let i = 0; i < MAX_ENTRIES + 5; i++) l = addEntry(l, { id: 100 + i, kind: 'text', text: `u${i}`, at: i, pinned: false, key: `t:u${i}` })
    expect(l.filter((e) => e.pinned)).toHaveLength(MAX_PINNED)
    expect(l.filter((e) => !e.pinned)).toHaveLength(MAX_ENTRIES)
    expect(l[0].text).toBe(`u${MAX_ENTRIES + 4}`)
  })

  it('skips copies while an app on the deny list has the focus', async () => {
    const f = fakeIo()
    let focused: string | null = 'org.keepassxc.KeePassXC'
    const h = clipboardHistory(f.io, null, { focusedApp: () => focused })
    h.setEnabled(true)
    f.set({ 'text/plain': 'from keepass' }); await tick()
    focused = 'firefox-esr'
    f.set({ 'text/plain': 'from firefox' }); await tick()
    expect(h.state().entries.map((e) => e.text)).toEqual(['from firefox'])
  })

  it('policy: cannot be turned on while disabled, and turning it off by policy drops the list', async () => {
    const f = fakeIo()
    let allowed = false
    const h = clipboardHistory(f.io, null, { allowed: () => allowed })
    h.setEnabled(true)
    expect(h.state()).toMatchObject({ enabled: false, blocked: true })
    expect(f.watching()).toBe(false)
    allowed = true
    h.setEnabled(true)
    f.set({ 'text/plain': 'x' }); await tick()
    expect(h.state().entries).toHaveLength(1)
    allowed = false
    h.policyChanged()
    expect(h.state()).toMatchObject({ enabled: false, entries: [], blocked: true })
    expect(f.watching()).toBe(false)
  })

  it('keeps pinned items in an encrypted 0600 file, readable only with the keyring key', async () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), 'clip-pins-'))
    const file = path.join(dir, 'clipboard-pins.enc')
    const keys = memKeys()
    const pins = encryptedPinStore(file, keys)
    const f = fakeIo()
    const h = clipboardHistory(f.io, null, { pins })
    h.setEnabled(true)
    await tick(); await tick()
    f.set({ 'text/plain': 'pinned secret-ish note' }); await tick()
    f.set({ 'text/plain': 'not pinned' }); await tick()
    h.pin(h.state().entries.find((e) => e.text.startsWith('pinned'))!.id, true)
    await tick(); await tick()
    const raw = readFileSync(file, 'utf8')
    expect(raw).not.toContain('pinned secret-ish')
    expect(raw).not.toContain('not pinned')
    expect(statSync(file).mode & 0o777).toBe(0o600)
    // next sign-in
    const h2 = clipboardHistory(fakeIo().io, null, { pins: encryptedPinStore(file, keys) })
    h2.setEnabled(true)
    for (let i = 0; i < 5; i++) await tick()
    expect(h2.state().entries.map((e) => [e.text, e.pinned])).toEqual([['pinned secret-ish note', true]])
    expect(h2.state().persist).toBe(true)
    // a wrong key reads nothing
    expect(() => decryptPins(raw, Buffer.alloc(32, 1))).toThrow()
    rmSync(dir, { recursive: true, force: true })
  })

  it('without a keyring, pins stay in memory only', async () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), 'clip-nokey-'))
    const file = path.join(dir, 'pins.enc')
    const none: KeyStore = { async get() { return null }, async create() { return null } }
    const store: PinStore = encryptedPinStore(file, none)
    const f = fakeIo()
    const h = clipboardHistory(f.io, null, { pins: store })
    h.setEnabled(true)
    await tick(); await tick()
    f.set({ 'text/plain': 'a' }); await tick()
    h.pin(h.state().entries[0].id, true)
    await tick()
    expect(existsSync(file)).toBe(false)
    expect(h.state().persist).toBe(false)
    rmSync(dir, { recursive: true, force: true })
  })

  it('encrypts and decrypts pins round trip, and parses URI lists', () => {
    const k = Buffer.alloc(32, 3)
    const pins: StoredPin[] = [{ kind: 'text', text: 'hi', at: 1 }, { kind: 'image', text: '', at: 2, mime: 'image/png', data: 'AAE=' }]
    expect(decryptPins(encryptPins(pins, k), k)).toEqual(pins)
    expect(parseUriList('# comment\nfile:///a/b%20c\nhttps://x/y\nfile:///a/b%20c\n')).toEqual(['/a/b c'])
    expect(parseUriList(uriList(['/x/ü y.txt']))).toEqual(['/x/ü y.txt'])
  })
})

// Real wl-clipboard against a headless Labwc (wlr-data-control).
const haveTools = () => ['labwc', 'wl-paste', 'wl-copy'].every((t) => spawnSync('sh', ['-c', `command -v ${t}`]).status === 0)
describe.skipIf(!haveTools())('wl-clipboard on headless Labwc', () => {
  let rt: string
  let labwc: ChildProcess
  let env: NodeJS.ProcessEnv
  beforeEach(async () => {
    rt = mkdtempSync(path.join(os.tmpdir(), 'ws-clip-'))
    const base: NodeJS.ProcessEnv = { ...process.env, XDG_RUNTIME_DIR: rt, WLR_BACKENDS: 'headless', WLR_RENDERER: 'pixman', WLR_LIBINPUT_NO_DEVICES: '1', WAYLAND_DISPLAY: '' }
    labwc = spawn('labwc', ['-C', rt], { env: base, stdio: 'ignore' })
    for (let i = 0; i < 100 && !existsSync(path.join(rt, 'wayland-0')); i++) await new Promise((r) => setTimeout(r, 50))
    env = { ...base, WAYLAND_DISPLAY: 'wayland-0' }
  })
  afterEach(() => { labwc.kill(); rmSync(rt, { recursive: true, force: true }) })

  const copy = (text: string, extra: string[] = []) => spawnSync('wl-copy', extra, { env, input: text, stdio: ['pipe', 'ignore', 'ignore'] })
  const until = async (fn: () => boolean) => { for (let i = 0; i < 100 && !fn(); i++) await new Promise((r) => setTimeout(r, 50)) }
  const paste = () => spawnSync('wl-paste', ['--no-newline'], { env, encoding: 'utf8' }).stdout

  it('records copies from other clients, skips a password manager copy, and copies back', async () => {
    const h = clipboardHistory(wlClipboardIo(env), null)
    h.setEnabled(true)
    await new Promise((r) => setTimeout(r, 300))
    copy('first copy')
    await until(() => h.state().entries.length === 1)
    expect(h.state().entries.map((e) => e.text)).toEqual(['first copy'])
    // KeePassXC-style secret copy: offered only with the hint type.
    copy('secret', ['--type', 'x-kde-passwordManagerHint'])
    await new Promise((r) => setTimeout(r, 500))
    expect(h.state().entries.map((e) => e.text)).toEqual(['first copy'])
    const [e] = h.state().entries
    copy('other')
    await until(() => h.state().entries.length === 2)
    expect(await h.copy(e.id)).toBe(true)
    await until(() => paste() === 'first copy')
    expect(paste()).toBe('first copy')
    h.setEnabled(false)
  }, 20_000)
})

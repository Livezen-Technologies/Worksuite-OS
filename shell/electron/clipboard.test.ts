import { spawn, spawnSync, type ChildProcess } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { clipboardHistory, isSecret, MAX_ENTRIES, wlClipboardIo, type ClipIo } from './clipboard'

/** In-memory clipboard: set() is a copy from some app. */
function fakeIo() {
  let sel: Record<string, string> | null = null
  let cb: (() => void) | null = null
  const io: ClipIo = {
    async types() { return sel ? Object.keys(sel) : null },
    async read(t) { return sel?.[t] ?? null },
    async write(text) { sel = { 'text/plain': text }; return true },
    watch(on) { cb = on; return () => { cb = null } },
  }
  return { io, watching: () => cb !== null, set: (s: Record<string, string>) => { sel = s; cb?.() } }
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
    expect(again.state()).toEqual({ enabled: true, entries: [] })
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

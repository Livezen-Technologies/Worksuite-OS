import { mkdtempSync, readFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { captureAllowed, captureHost, grimArgs, imageData, normalizeCapture, plan, screenshotFileName, screenshotsDir, uniqueFile, type CaptureDeps } from './capture'

const PNG = (s: string) => Buffer.from(`PNG:${s}`)
const url = (b: Buffer) => `data:image/png;base64,${b.toString('base64')}`

function rig(over: Partial<CaptureDeps> = {}) {
  const events: [string, unknown][] = []
  const runs: string[][] = []
  const copied: Buffer[] = []
  const lifts: boolean[] = []
  const written: Record<string, Buffer> = {}
  const dir = mkdtempSync(path.join(os.tmpdir(), 'cap-'))
  let policy: { screen_capture?: string; kiosk?: boolean } | null = null
  const d: CaptureDeps = {
    run: async (_cmd, args) => { runs.push(args); const o = args.indexOf('-o'); return PNG(o >= 0 ? args[o + 1] : 'all') },
    copy: async (b) => { copied.push(b); return true },
    outputs: () => [{ name: 'eDP-1', x: 0, y: 0, width: 1280, height: 800 }, { name: 'HDMI-A-1', x: 1280, y: 0, width: 1920, height: 1080 }],
    policies: () => policy,
    broadcast: (c, p) => events.push([c, p]),
    lift: (on) => { lifts.push(on) },
    dir: () => path.join(dir, 'Screenshots'),
    settingsFile: path.join(dir, 'capture.json'),
    now: () => new Date(2026, 9, 16, 9, 15, 2),
    sleep: async () => undefined,
    write: (f, b) => { written[f] = b },
    ...over,
  }
  return { h: captureHost(d), events, runs, copied, lifts, written, dir, setPolicy: (p: typeof policy) => { policy = p } }
}

describe('screenshot names and places', () => {
  it('names files by local time, without clashing', () => {
    expect(screenshotFileName(new Date(2026, 9, 16, 9, 15, 2))).toBe('Screenshot 2026-10-16 091502.png')
    expect(screenshotFileName(new Date(2026, 0, 2, 3, 4, 5), 'jpg')).toBe('Screenshot 2026-01-02 030405.jpg')
    const taken = new Set(['/p/a.png', '/p/a (2).png'])
    expect(uniqueFile('/p', 'a.png', (f) => taken.has(f))).toBe('/p/a (3).png')
    expect(screenshotsDir({}, '/home/u')).toBe('/home/u/Pictures/Screenshots')
    expect(screenshotsDir({ XDG_PICTURES_DIR: '/home/u/Bilder' }, '/home/u')).toBe('/home/u/Bilder/Screenshots')
  })

  it('captures with grim to stdout, one output or all of them', () => {
    expect(grimArgs('eDP-1')).toEqual(['-o', 'eDP-1', '-t', 'png', '-l', '1', '-'])
    expect(grimArgs(null)).toEqual(['-t', 'png', '-l', '1', '-'])
  })

  it('policy: off when screen_capture is disabled, and on every kiosk', () => {
    expect(captureAllowed(null)).toBe(true)
    expect(captureAllowed({ screen_capture: 'allowed' })).toBe(true)
    expect(captureAllowed({ screen_capture: 'disabled' })).toBe(false)
    expect(captureAllowed({ kiosk: true })).toBe(false)
  })

  it('maps the shortcuts to the overlay or a whole-screen screenshot', () => {
    const s = normalizeCapture({})
    expect(plan('print', s)).toEqual({ full: true })
    expect(plan('save', s)).toEqual({ full: true })
    expect(plan('window', s)).toEqual({ overlay: 'window' })
    expect(plan('snip', { ...s, mode: 'free' })).toEqual({ overlay: 'free' })
    expect(plan('print', { ...s, printOpensSnip: true })).toEqual({ overlay: 'rect' })
    expect(normalizeCapture({ mode: 'bogus', delay: 7, printOpensSnip: 'yes' })).toEqual({ printOpensSnip: false, mode: 'rect', delay: 0 })
  })

  it('accepts only PNG or JPEG data URLs', () => {
    expect(imageData('data:image/jpeg;base64,AAEC')).toEqual({ data: Buffer.from([0, 1, 2]), ext: 'jpg' })
    expect(imageData('data:image/svg+xml;base64,AAEC')).toBeNull()
    expect(imageData('data:image/png;base64,')).toBeNull()
  })
})

describe('capture host', () => {
  it('Print saves the whole screen to Pictures/Screenshots and copies it', async () => {
    const r = rig()
    expect(await r.h.request('print')).toBe(true)
    expect(r.runs).toEqual([grimArgs(null)])
    const file = path.join(r.dir, 'Screenshots', 'Screenshot 2026-10-16 091502.png')
    expect(r.written[file]).toEqual(PNG('all'))
    expect(r.copied).toEqual([PNG('all')])
    expect(r.events).toEqual([['ws:captured', { id: 1, kind: 'saved', file, copied: true }]])
    expect(r.h.image(0)).toEqual({ id: 1, url: url(PNG('all')), file })
    expect(r.lifts).toEqual([])
  })

  it('Super+Shift+S freezes every output, lifts the shell, and copies the selection', async () => {
    const r = rig()
    expect(await r.h.request('snip')).toBe(true)
    expect(r.runs).toEqual([grimArgs('eDP-1'), grimArgs('HDMI-A-1')])
    const [ch, open] = r.events[0] as [string, { id: number; mode: string; outputs: { name: string }[] }]
    expect(ch).toBe('ws:snipOpen')
    expect(open.mode).toBe('rect')
    expect(open.outputs.map((o) => o.name)).toEqual(['eDP-1', 'HDMI-A-1'])
    expect(r.lifts).toEqual([true])
    expect(r.h.frame(open.id, 'HDMI-A-1')).toBe(url(PNG('HDMI-A-1')))
    expect(r.h.frame(open.id, '')).toBe(url(PNG('eDP-1')))
    expect(r.h.frame(open.id + 1, 'eDP-1')).toBeNull()
    // a second Super+Shift+S while it is open shows the same overlay again
    expect(await r.h.request('snip')).toBe(true)
    expect(r.runs).toHaveLength(2)
    const sel = Buffer.from('SELECTION')
    const res = await r.h.done(open.id, url(sel))
    expect(res).toEqual({ id: open.id + 1 })
    expect(r.copied).toEqual([sel])
    expect(r.events.slice(-2)).toEqual([['ws:snipClose', { id: open.id }], ['ws:captured', { id: open.id + 1, kind: 'copied', file: null, copied: true }]])
    expect(r.lifts).toEqual([true, false])
    expect(Object.keys(r.written)).toEqual([])        // a snip is not saved anywhere until the person saves it
    expect(r.h.frame(open.id, 'eDP-1')).toBeNull()       // frames are dropped with the overlay
  })

  it('Alt+Print opens the overlay in Window mode; Esc cancels without copying', async () => {
    const r = rig()
    await r.h.request('window')
    const open = r.events[0][1] as { id: number; mode: string }
    expect(open.mode).toBe('window')
    r.h.cancel(open.id)
    expect(r.copied).toEqual([])
    expect(r.lifts).toEqual([true, false])
    expect(r.h.open).toBe(0)
  })

  it('remembers the mode and delay from the Snipping Tool, and Print can open the overlay instead', async () => {
    const r = rig()
    const slept: number[] = []
    const r2 = rig({ sleep: async (ms) => { slept.push(ms) } })
    await r2.h.start('free', 5)
    expect(slept).toEqual([5000])
    expect((r2.events[0][1] as { mode: string }).mode).toBe('free')
    expect(r2.h.settings()).toMatchObject({ mode: 'free', delay: 5 })
    r.h.setSettings({ printOpensSnip: true })
    await r.h.request('print')
    expect(r.events[0][0]).toBe('ws:snipOpen')
    const saved = JSON.parse(readFileSync(path.join(r.dir, 'capture.json'), 'utf8'))
    expect(saved.printOpensSnip).toBe(true)
  })

  it('does nothing but say so when policy turns screen capture off', async () => {
    const r = rig()
    r.setPolicy({ screen_capture: 'disabled' })
    expect(await r.h.request('print')).toBe(false)
    expect(await r.h.request('snip')).toBe(false)
    expect(await r.h.start('rect', 0)).toBe(false)
    expect(r.runs).toEqual([])
    expect(r.copied).toEqual([])
    expect(r.events).toEqual([['ws:captured', { id: 0, kind: 'blocked', file: null }], ['ws:captured', { id: 0, kind: 'blocked', file: null }], ['ws:captured', { id: 0, kind: 'blocked', file: null }]])
  })

  it('reports a failed capture (no grim, no compositor support)', async () => {
    const r = rig({ run: async () => null })
    expect(await r.h.request('save')).toBe(false)
    expect(await r.h.request('snip')).toBe(false)
    expect(r.events.map((e) => (e[1] as { kind: string }).kind)).toEqual(['failed', 'failed'])
    expect(r.lifts).toEqual([])
  })

  it('keeps only the last few screenshots in memory', async () => {
    const r = rig()
    for (let i = 0; i < 9; i++) await r.h.request('save')
    expect(r.h.image(1)).toBeNull()
    expect(r.h.image(9)?.id).toBe(9)
  })
})

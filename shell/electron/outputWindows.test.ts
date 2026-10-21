import { describe, expect, it } from 'vitest'
import { outputWindows, planOutputWindows, screensMatch, type Rect } from './outputWindows'

const P: Rect = { name: 'eDP-1', primary: true, x: 0, y: 0, width: 1504, height: 1003 }
const H: Rect = { name: 'HDMI-A-1', primary: false, x: 1504, y: 0, width: 1920, height: 1080 }

describe('per-monitor shell windows', () => {
  it('plans create, move and close', () => {
    expect(planOutputWindows(new Map(), [P, H])).toEqual({ create: [H], move: [], close: [], primary: P })
    expect(planOutputWindows(new Map([['HDMI-A-1', { ...H, x: 2000 }]]), [P, H]).move).toEqual([H])
    expect(planOutputWindows(new Map([['HDMI-A-1', H]]), [P])).toEqual({ create: [], move: [], close: ['HDMI-A-1'], primary: P })
  })
  it('follows hotplug and primary changes', () => {
    const log: string[] = []
    const win = (n: string) => ({ setBounds: (b: { x: number }) => log.push(`${n} bounds ${b.x}`), setFullScreen: (f: boolean) => { if (f) log.push(`${n} fs`) }, close: () => log.push(`${n} close`) })
    const ow = outputWindows((r) => { log.push(`create ${r.name}`); return win(r.name) }, () => win('main'))
    ow.sync([P, H])
    expect(log).toEqual(['create HDMI-A-1', 'main bounds 0', 'main fs'])
    log.length = 0
    ow.sync([P])                     // HDMI unplugged
    expect(log).toEqual(['HDMI-A-1 close'])
    expect(ow.names()).toEqual([])
    log.length = 0
    // Primary moves to the external monitor; the laptop gets the secondary window.
    ow.sync([{ ...H, primary: true, x: 0 }, { ...P, primary: false, x: 1920 }])
    expect(log).toEqual(['create eDP-1', 'main bounds 0', 'main fs'])
  })

  it('re-places every window, the main one too, after a scale or mode change (#60)', () => {
    const log: string[] = []
    const win = (n: string) => ({ setBounds: (b: { width: number }) => log.push(`${n} bounds ${b.width}`), setFullScreen: (f: boolean) => log.push(`${n} fs ${f}`), close: () => log.push(`${n} close`) })
    const main = win('main')
    const ow = outputWindows((r) => win(r.name), () => main)
    ow.refit()                       // nothing planned yet: nothing to do
    expect(log).toEqual([])
    ow.sync([P, H])
    log.length = 0
    ow.refit()
    expect(log).toEqual(['HDMI-A-1 fs false', 'HDMI-A-1 bounds 1920', 'HDMI-A-1 fs true', 'main fs false', 'main bounds 1504', 'main fs true'])
    expect(ow.placed().map((p) => p.rect.name)).toEqual(['eDP-1', 'HDMI-A-1'])
    // 100 % → 125 %: the primary's logical size shrinks and the main window follows.
    log.length = 0
    ow.sync([{ ...P, width: 1203, height: 802 }, { ...H, x: 1203 }])
    expect(log).toContain('main bounds 1203')
    expect(log.at(-1)).toBe('main fs true')
  })
  it('knows when Electron has caught up with the new output geometry (#60)', () => {
    const d = (width: number, height: number) => ({ bounds: { x: 0, y: 0, width, height } })
    expect(screensMatch([{ x: 0, y: 0, width: 1024, height: 640 }], [d(1280, 800)])).toBe(false)
    expect(screensMatch([{ x: 0, y: 0, width: 1024, height: 640 }], [d(1024, 640)])).toBe(true)
    expect(screensMatch([{ x: 0, y: 0, width: 1024, height: 640 }], [d(1025, 640)])).toBe(true)
    expect(screensMatch([P, H], [d(1504, 1003)])).toBe(false)
  })
})

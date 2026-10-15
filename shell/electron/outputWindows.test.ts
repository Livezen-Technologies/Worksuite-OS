import { describe, expect, it } from 'vitest'
import { outputWindows, planOutputWindows, type Rect } from './outputWindows'

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
})

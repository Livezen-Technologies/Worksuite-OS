import { describe, expect, it, vi } from 'vitest'
import { bannerAllowed, toastHost, type ToastProc } from './toastHost'

function fake(code: number | null = null) {
  const lines: string[] = []
  let out: (l: string) => void = () => {}
  let exit: (c: number | null) => void = () => {}
  const p: ToastProc = { write: (l) => { lines.push(l) }, onLine: (cb) => { out = cb }, onExit: (cb) => { exit = cb }, kill: vi.fn() }
  return { p, lines, say: (l: string) => out(l), exit: () => exit(code) }
}

describe('toasts over the apps (worksuite-toasts)', () => {
  it('sends one JSON line per toast and reports clicks by key', () => {
    const f = fake(), clicks: string[] = []
    const h = toastHost((k) => clicks.push(k), () => f.p, 2000, (v) => v === 'firefox-esr' ? '/usr/share/icons/hicolor/48x48/apps/firefox-esr.png' : null)
    expect(h.available()).toBe(true)
    expect(h.show({ key: 'app-7', title: 'Firefox', body: 'Done', icon: 'firefox-esr' })).toBe(true)
    expect(JSON.parse(f.lines[0])).toEqual({ op: 'show', key: 'app-7', title: 'Firefox', body: 'Done', tone: 'ok', icon: '/usr/share/icons/hicolor/48x48/apps/firefox-esr.png', sticky: false })
    h.hide('app-7')
    expect(JSON.parse(f.lines[1])).toEqual({ op: 'hide', key: 'app-7' })
    f.say('click app-7'); f.say('closed app-7'); f.say('click ../x y')
    expect(clicks).toEqual(['app-7'])
    expect(h.show({ key: 'bad key', title: 'x' })).toBe(false)
    h.show({ key: 'app-8', title: 'Signal', icon: 'signal-desktop' })
    expect(JSON.parse(f.lines[2]).icon).toBe('')   // a name with no icon file is dropped, never looked up by the helper
  })

  it('is unavailable without layer-shell (exit 69), so the shell keeps its own toast', () => {
    const f = fake(69)
    const h = toastHost(() => {}, () => f.p)
    expect(h.available()).toBe(true)
    f.exit()
    expect(h.available()).toBe(false)
    expect(toastHost(() => {}, () => null).available()).toBe(false)
  })

  it('starts again after a crash, gives up after three', () => {
    vi.useFakeTimers()
    const procs = [fake(1), fake(1), fake(1)]
    let i = 0
    const h = toastHost(() => {}, () => procs[i++]?.p ?? null, 10)
    h.available(); procs[0].exit(); vi.advanceTimersByTime(10)
    expect(i).toBe(2)
    procs[1].exit(); vi.advanceTimersByTime(10); procs[2].exit(); vi.advanceTimersByTime(10)
    expect(h.available()).toBe(false)
    vi.useRealTimers()
  })
})

describe('banners and the app in front', () => {
  it('shows a banner over the focused app (as Windows and macOS do); holds it back only under a full-screen window', () => {
    expect(bannerAllowed([])).toBe(true)
    expect(bannerAllowed([{ flags: 1 }, { flags: 0 }])).toBe(true)          // the sender is the focused, maximised app
    expect(bannerAllowed([{ flags: 1 | 8 }])).toBe(false)                    // focused and full-screen: a video, a talk
    expect(bannerAllowed([{ flags: 8 }, { flags: 1 }])).toBe(true)           // full-screen behind another app
  })
})

// One shell window per monitor (WSOS-DSK-005/007). The main window is the primary monitor's desktop; every other
// enabled output gets a window with that output's wallpaper and a taskbar listing the windows on it. Windows are
// fullscreened on their output (Chromium sends xdg_toplevel.set_fullscreen with the output that holds the window's
// bounds); the bridge's layer-shell reservation keeps maximised apps above each taskbar. On hotplug the plan is
// recomputed: windows for removed outputs close, new outputs get one, moved outputs are re-placed.
export interface Rect { name: string; primary: boolean; x: number; y: number; width: number; height: number }
export interface OutputWindowPlan { create: Rect[]; move: Rect[]; close: string[]; primary: Rect | null }

export function planOutputWindows(open: Map<string, Omit<Rect, 'name' | 'primary'>>, rects: Rect[]): OutputWindowPlan {
  const wanted = rects.filter((r) => !r.primary)
  const names = new Set(wanted.map((r) => r.name))
  const same = (a: Omit<Rect, 'name' | 'primary'>, b: Rect) => a.x === b.x && a.y === b.y && a.width === b.width && a.height === b.height
  return {
    create: wanted.filter((r) => !open.has(r.name)),
    move: wanted.filter((r) => open.has(r.name) && !same(open.get(r.name)!, r)),
    close: [...open.keys()].filter((n) => !names.has(n)),
    primary: rects.find((r) => r.primary) ?? null,
  }
}

export interface ShellWindow { setBounds(b: { x: number; y: number; width: number; height: number }): void; setFullScreen(f: boolean): void; close(): void }

/** Applies plans to real windows; `make` creates the window for one output. */
export function outputWindows(make: (r: Rect) => ShellWindow, primaryWindow: () => ShellWindow | null) {
  const open = new Map<string, { win: ShellWindow; rect: Rect }>()
  const place = (w: ShellWindow, r: Rect) => { w.setFullScreen(false); w.setBounds(r); w.setFullScreen(true) }
  let primaryRect: Rect | null = null
  return {
    sync(rects: Rect[]): OutputWindowPlan {
      const plan = planOutputWindows(new Map([...open].map(([k, v]) => [k, v.rect])), rects)
      for (const n of plan.close) { open.get(n)?.win.close(); open.delete(n) }
      for (const r of plan.move) { const o = open.get(r.name)!; o.rect = r; place(o.win, r) }
      for (const r of plan.create) open.set(r.name, { win: make(r), rect: r })
      const p = primaryWindow()
      if (p && plan.primary && JSON.stringify(plan.primary) !== JSON.stringify(primaryRect)) { primaryRect = plan.primary; place(p, plan.primary) }
      return plan
    },
    names: () => [...open.keys()],
    forget(name: string) { open.delete(name) },
  }
}

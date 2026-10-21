// The taskbar's own windows (#53): one frameless window per output, pinned to the bottom edge at the panel height
// (52 px, 64 in touch mode) and kept ABOVE the app windows, while the full-screen shell window (desktop, launcher,
// flyouts) stays always-on-bottom and is lifted only while something of its own is open.
//
// * Labwc places them: the system rc.xml's rule for "WorkSuite taskbar *" titles makes them undecorated, always on
//   top, off the window list and Alt+Tab, at a fixed position; the per-output rules written here (the
//   worksuite-taskbar block of the user's rc.xml) move each one to its output's bottom edge when it maps. A Wayland
//   client cannot place its own window, and an always-on-top toplevel is the one thing Labwc 0.8.3 keeps above
//   every normal window that a client may ask for.
// * Labwc 0.8.3 stacks always-on-top windows above full-screen ones (view_tree_always_on_top is above every
//   desktop's tree), so a taskbar is hidden while the focused window on its output is full screen (a video, a game,
//   a presentation) and shown again after.
// * The bridge's layer-shell reservation (SetPanelHeight) keeps maximized and placed windows out of that strip.
// * What the taskbar shows is the owner's: the shell window of that output keeps all state (launcher, tray, quick
//   settings, badges…) and its own taskbar element, and mirrors it into the taskbar window (src/lib/taskbarMirror.ts);
//   clicks there are handed back to the same element in the owner, so every flyout opens in the shell window,
//   lifted over the apps as before.
import { writeFileSync, renameSync, readFileSync, mkdirSync } from 'node:fs'
import path from 'node:path'

export const TASKBAR_TITLE = 'WorkSuite taskbar'
export const taskbarTitle = (output: string) => `${TASKBAR_TITLE} ${output}`
const SAFE = /^[A-Za-z0-9._-]{1,64}$/
export const TASKBAR_BEGIN = '<!-- worksuite-taskbar:begin (written by the shell, electron/taskbar.ts) -->'
export const TASKBAR_END = '<!-- worksuite-taskbar:end -->'

export interface TaskbarRect { name: string; x: number; y: number; width: number; height: number }

/** Where each output's taskbar goes: its bottom edge, full width, `h` logical pixels tall. */
export function taskbarBounds(r: TaskbarRect, h: number) {
  return { x: Math.round(r.x), y: Math.round(r.y + r.height - h), width: Math.max(1, Math.round(r.width)), height: h }
}

/** The per-output rules: the window titled "WorkSuite taskbar <output>" moves to that output's bottom edge. */
export function taskbarRulesBlock(rects: TaskbarRect[], h: number): string {
  const rules = rects.filter((r) => SAFE.test(r.name)).map((r) => {
    const b = taskbarBounds(r, h)
    return `    <windowRule identifier="worksuite-shell" title="${taskbarTitle(r.name)}">\n      <action name="MoveTo" x="${b.x}" y="${b.y}"/>\n    </windowRule>`
  })
  return `${TASKBAR_BEGIN}\n  <windowRules>\n${rules.join('\n')}\n  </windowRules>\n${TASKBAR_END}`
}

export function extractTaskbarBlock(rc: string): string | null {
  const a = rc.indexOf(TASKBAR_BEGIN), b = rc.indexOf(TASKBAR_END)
  return a >= 0 && b > a ? rc.slice(a, b + TASKBAR_END.length) : null
}

/** The block in rc.xml (replacing an earlier one) just before </labwc_config>; null removes it. */
export function mergeTaskbarBlock(rc: string, block: string | null): string {
  const old = extractTaskbarBlock(rc)
  const base = old ? rc.replace(old + (rc.includes(`${old}\n`) ? '\n' : ''), '') : rc
  if (!block) return base
  const close = base.lastIndexOf('</labwc_config>')
  if (close < 0) return `${base.trimEnd()}\n${block}\n`
  return `${base.slice(0, close)}${block}\n${base.slice(close)}`
}

const OWN = ['worksuite-shell', 'worksuite', 'electron']
/** Outputs whose focused window is full screen (the taskbar there gives way to it). */
export function fullscreenOutputs(windows: readonly { appId: string; output: string; flags: number }[], activated = 1, fullscreen = 8): Set<string> {
  return new Set(windows.filter((w) => (w.flags & activated) && (w.flags & fullscreen) && !OWN.includes(w.appId.toLowerCase())).map((w) => w.output))
}
/** The app window with the keyboard focus, to give it back after a taskbar window mapped (Labwc focuses new windows). */
export function focusedApp(windows: readonly { handle: string; appId: string; flags: number }[], activated = 1): string | null {
  return windows.find((w) => (w.flags & activated) && !OWN.includes(w.appId.toLowerCase()))?.handle ?? null
}

export interface TaskbarWindow { show(): void; hide(): void; close(): void; isVisible(): boolean }
export interface TaskbarDeps {
  /** Writes the rules block into the user's rc.xml and reloads Labwc; false when it could not. */
  writeRules(block: string): Promise<boolean>
  make(r: TaskbarRect, bounds: ReturnType<typeof taskbarBounds>): TaskbarWindow | null
  /** Give the keyboard back to this app window (a new taskbar window took it when it mapped). */
  refocus(handle: string): void
  /** Wait between the reload and the new windows (Labwc reads the rules when it maps a window). */
  settle?: () => Promise<void>
}

export function taskbarHost(d: TaskbarDeps) {
  let rects: TaskbarRect[] = []
  let height = 52
  let wanted = false
  let windows: { handle: string; appId: string; output: string; flags: number }[] = []
  let applied = ''
  let written = ''
  const open = new Map<string, TaskbarWindow>()
  let chain: Promise<void> = Promise.resolve()

  const closeAll = () => { for (const w of open.values()) w.close(); open.clear(); applied = '' }
  function visibility() {
    const full = fullscreenOutputs(windows)
    let shown = false
    for (const [name, w] of open) {
      if (full.has(name)) { if (w.isVisible()) w.hide() } else if (!w.isVisible()) { w.show(); shown = true }
    }
    return shown
  }
  async function apply() {
    if (!wanted || !rects.length || height <= 0) { closeAll(); return }
    const key = JSON.stringify([rects, height])
    if (key !== applied) {
      const block = taskbarRulesBlock(rects, height)
      if (block !== written) {
        if (!(await d.writeRules(block))) return   // no rules: no taskbar windows (the shell window's own taskbar shows)
        written = block
        await (d.settle?.() ?? Promise.resolve())
      }
      closeAll()
      for (const r of rects) {
        if (!SAFE.test(r.name)) continue
        const w = d.make(r, taskbarBounds(r, height))
        if (w) open.set(r.name, w)
      }
      applied = key
      visibility()
      const f = focusedApp(windows)
      if (f) d.refocus(f)
      return
    }
    if (visibility()) { const f = focusedApp(windows); if (f) d.refocus(f) }
  }
  const run = () => { chain = chain.then(apply, apply); return chain }
  return {
    setOutputs(r: TaskbarRect[]) { rects = r.map(({ name, x, y, width, height: hh }) => ({ name, x, y, width, height: hh })); return run() },
    setHeight(h: number) { height = Math.max(0, Math.round(h)); return run() },
    setWanted(on: boolean) { wanted = on; return run() },
    setWindows(w: typeof windows) {
      const before = [...fullscreenOutputs(windows)].sort().join()
      windows = w
      return [...fullscreenOutputs(w)].sort().join() !== before ? run() : chain
    },
    names: () => [...open.keys()],
    stop() { closeAll() },
  }
}

/** The user's rc.xml with this block, written like the other shell blocks (touch, pointer, shortcuts). */
export function writeTaskbarRules(userRc: string, systemRc: string, block: string) {
  let rc = ''
  try { rc = readFileSync(userRc, 'utf8') } catch { rc = readFileSync(systemRc, 'utf8') }
  const next = mergeTaskbarBlock(rc, block)
  if (next === rc) return false
  mkdirSync(path.dirname(userRc), { recursive: true })
  writeFileSync(`${userRc}.tmp`, next)
  renameSync(`${userRc}.tmp`, userRc)   // replaces a symlink to the system file with the user's own copy
  return true
}

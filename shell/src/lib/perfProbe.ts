// Launcher first-frame probe (WSOS-PRF-005): request (key or click) → first frame painted with the launcher shown.
// The renderer reports on the console; the main process forwards WORKSUITE_PERF lines to stdout only when
// WORKSUITE_PERF=1 (tests/perf/guest/measure-shell), so nothing is collected or shown in normal use.
let requestedAt: number | null = null

/** Call where the launcher is asked to open; `at` is the input event's timeStamp when there is one. */
export function markLauncherRequest(at?: number) {
  requestedAt = typeof at === 'number' && at > 0 ? at : performance.now()
}

/** Call once the launcher is mounted; resolves with the first-frame time in ms (null when no request was marked). */
export function reportLauncherFirstFrame(raf: (cb: () => void) => void = requestAnimationFrame, now: () => number = () => performance.now(),
  log: (line: string) => void = (l) => console.info(l)): Promise<number | null> {
  const t0 = requestedAt
  requestedAt = null
  if (t0 == null) return Promise.resolve(null)
  // The first rAF runs before the paint that shows the launcher, the second after it.
  return new Promise((resolve) => raf(() => raf(() => {
    const ms = Math.max(0, Math.round(now() - t0))
    log(`WORKSUITE_PERF launcher_first_frame_ms ${ms}`)
    resolve(ms)
  })))
}

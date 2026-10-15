import { describe, expect, it } from 'vitest'
import { markLauncherRequest, reportLauncherFirstFrame } from './perfProbe'

describe('WSOS-PRF-005 launcher first-frame probe', () => {
  it('measures from the request to the frame after the launcher mounted', async () => {
    const lines: string[] = []
    let t = 1000
    let frames = 0
    const raf = (cb: () => void) => { t += 8; frames++; cb() }
    markLauncherRequest(990)
    expect(await reportLauncherFirstFrame(raf, () => t, (l) => lines.push(l))).toBe(26)
    expect(frames).toBe(2)
    expect(lines).toEqual(['WORKSUITE_PERF launcher_first_frame_ms 26'])
  })
  it('reports nothing without a request, and each request once', async () => {
    const lines: string[] = []
    const raf = (cb: () => void) => cb()
    expect(await reportLauncherFirstFrame(raf, () => 0, (l) => lines.push(l))).toBeNull()
    markLauncherRequest()
    await reportLauncherFirstFrame(raf, () => performance.now(), (l) => lines.push(l))
    expect(await reportLauncherFirstFrame(raf, () => 0, (l) => lines.push(l))).toBeNull()
    expect(lines).toHaveLength(1)
  })
})

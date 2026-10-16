import { readdirSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'

// ipcMain.handle throws on a second handler for a channel, and main.ts registers the hosts one after another: one
// duplicate stopped every host registered after it (peripherals' 'ws:inhibitors' after the session-end overlay's took
// down touch, the on-screen keyboard, notifications and polkit at start-up).
describe('IPC channels', () => {
  it('each ws: channel has one handler in the main process', () => {
    const dir = __dirname
    const seen = new Map<string, string>()
    const dupes: string[] = []
    for (const f of readdirSync(dir).filter((n) => n.endsWith('.ts') && !n.endsWith('.test.ts') && !/preload/i.test(n) && !/^kiosk/.test(n))) {
      for (const m of readFileSync(path.join(dir, f), 'utf8').matchAll(/\bhandle\(\s*'(ws:[A-Za-z]+)'/g)) {
        if (seen.has(m[1])) dupes.push(`${m[1]}: ${seen.get(m[1])} and ${f}`)
        else seen.set(m[1], f)
      }
    }
    expect(seen.size).toBeGreaterThan(50)
    expect(dupes).toEqual([])
  })
})

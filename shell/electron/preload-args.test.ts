// main.ts handle() turns every IPC argument into a string, so the preload must send structured values as JSON. An
// object passed as-is arrived as "[object Object]": Settings › Personalization and Accessibility refused every change
// on the installed system while their unit tests (which call the handlers directly) passed.
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'

const src = readFileSync(path.join(__dirname, 'preload.ts'), 'utf8')

describe('preload IPC arguments', () => {
  it('never passes an unknown/object parameter to ipcRenderer.invoke as-is', () => {
    const bad: string[] = []
    for (const m of src.matchAll(/\(([^)]*)\)\s*=>\s*ipcRenderer\.invoke\(([^)]*)\)/g)) {
      const params = m[1].split(',').map((p) => p.trim()).filter((p) => /:\s*(unknown|object|Record<|\{)/.test(p)).map((p) => p.split(':')[0].trim())
      const args = m[2].split(',').slice(1).map((a) => a.trim())
      for (const p of params) if (args.includes(p)) bad.push(m[0])
    }
    expect(bad).toEqual([])
  })
})

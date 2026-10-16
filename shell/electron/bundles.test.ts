import { mkdirSync, mkdtempSync, utimesSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { findBundles } from './bundles'

describe('findBundles', () => {
  it('lists top-level .wsupdate files on each drive, newest first', () => {
    const t = mkdtempSync(path.join(os.tmpdir(), 'wsb-'))
    const a = path.join(t, 'KINGSTON'), b = path.join(t, 'SANDISK')
    mkdirSync(path.join(a, 'sub'), { recursive: true }); mkdirSync(b)
    writeFileSync(path.join(a, 'worksuite-1.1.2-offline.wsupdate'), 'x')
    writeFileSync(path.join(a, 'notes.txt'), 'x')
    writeFileSync(path.join(a, 'sub', 'deep.wsupdate'), 'x')
    writeFileSync(path.join(a, '.hidden.wsupdate'), 'x')
    mkdirSync(path.join(b, 'dir.wsupdate'))
    writeFileSync(path.join(b, 'worksuite-1.1.1-offline.wsupdate'), 'x')
    utimesSync(path.join(b, 'worksuite-1.1.1-offline.wsupdate'), 1, 1)
    const r = findBundles([{ label: 'KINGSTON', path: a }, { label: 'SANDISK', path: b }, { label: 'GONE', path: path.join(t, 'missing') }])
    expect(r.map((x) => [x.drive, x.name])).toEqual([['KINGSTON', 'worksuite-1.1.2-offline.wsupdate'], ['SANDISK', 'worksuite-1.1.1-offline.wsupdate']])
  })
})

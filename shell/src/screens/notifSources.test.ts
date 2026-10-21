// Settings › Notifications › Sources (#52): the table's columns size to their content (no fixed 60/90 px tracks
// the switch and longer labels overflowed into each other) and become cards on a narrow panel (125/150 % scaling).
import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const src = readFileSync(new URL('./Settings.tsx', import.meta.url), 'utf8')

describe('notification sources layout (#52)', () => {
  it('shares one grid between header and rows, sized to content', () => {
    const table = /const notifTable = '([^']+)'/.exec(src)?.[1] ?? ''
    const row = /const notifRow = '([^']+)'/.exec(src)?.[1] ?? ''
    expect(table).toContain('grid-cols-[minmax(0,1fr)_repeat(3,minmax(4.5rem,max-content))_max-content]')
    expect(row).toContain('grid-cols-subgrid')
    expect(`${table} ${row}`).not.toMatch(/_\d+px/)
  })
  it('stacks into labelled cards below 520 px of panel width', () => {
    expect(src).toContain('<div className="@container">')
    expect(src).toMatch(/@max-\[520px\]:sr-only/)
    expect(src).toMatch(/@max-\[520px\]:inline" aria-hidden="true">\{label\}: /)
  })
})

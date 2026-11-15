// @vitest-environment jsdom
// WorkSuite windows' title bar: a draggable strip with the title; the window buttons are Electron's native overlay
// (main.ts titleBarOverlay), never page buttons that could look like controls without being them.
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { WindowBar, WINDOW_BAR_HEIGHT } from './WindowBar'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

describe('WindowBar', () => {
  it('shows the title in a drag strip with no page-drawn buttons', () => {
    const el = document.createElement('div'); document.body.append(el)
    const root = createRoot(el)
    act(() => root.render(<WindowBar title="Settings" />))
    expect(el.textContent).toBe('Settings')
    expect(el.querySelectorAll('button')).toHaveLength(0)
    act(() => root.unmount())
  })
  it('Settings and Setup windows get the native overlay at the bar height', () => {
    const main = readFileSync(path.join(__dirname, '../../electron/main.ts'), 'utf8')
    expect(main).toContain("titleBarStyle: 'hidden', titleBarOverlay: WINDOW_BAR_OVERLAY")
    expect(main).toMatch(new RegExp(`WINDOW_BAR_OVERLAY = \\{[^}]*height: ${WINDOW_BAR_HEIGHT} \\}`))
  })
})

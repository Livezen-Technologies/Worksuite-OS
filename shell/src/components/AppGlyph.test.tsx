// @vitest-environment jsdom
import { act, type ReactNode } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, describe, expect, it } from 'vitest'
import { AppGlyph } from './AppGlyph'
import { resetIconCache } from '../lib/appIcons'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
function render(node: ReactNode) {
  const container = document.createElement('div'); document.body.append(container)
  act(() => { createRoot(container).render(node) })
  return { container }
}
const base = { mark: 'Fi', bg: '#123456', fg: '#FFFFFF' }
afterEach(() => { resetIconCache(); delete (window as { worksuite?: unknown }).worksuite })

describe('AppGlyph', () => {
  it('draws the bundled icon for WorkSuite modules and system apps', () => {
    const { container } = render(<AppGlyph app={{ ...base, id: 'worksuite-mail' }} size={44} radius={12} font={16} />)
    const img = container.querySelector('img')!
    expect(img.getAttribute('src')).toMatch(/^data:image\/svg\+xml,/)
    expect(img.getAttribute('alt')).toBe('')
    expect(img.getAttribute('aria-hidden')).toBe('true')
  })
  it("draws the installed app's theme icon once resolved", async () => {
    ;(window as unknown as { worksuite: unknown }).worksuite = { appIcons: async () => ({ firefox: 'data:image/png;base64,AA' }) }
    const { container } = render(<AppGlyph app={{ ...base, id: 'firefox', icon: 'firefox' }} size={30} radius={8} font={12} />)
    expect(container.querySelector('.ws-mark')).toBeNull()
    await act(async () => { await new Promise((r) => setTimeout(r, 0)) })
    expect(container.querySelector('img')?.getAttribute('src')).toBe('data:image/png;base64,AA')
  })
  it('falls back to the letter mark when there is no icon', async () => {
    ;(window as unknown as { worksuite: unknown }).worksuite = { appIcons: async () => ({ gone: null }) }
    const { container } = render(<AppGlyph app={{ ...base, id: 'gone', icon: 'gone' }} size={28} radius={7} font={11} css />)
    await act(async () => { await new Promise((r) => setTimeout(r, 0)) })
    const mark = container.querySelector('.ws-mark')!
    expect(mark.getAttribute('data-mark')).toBe('Fi')
    expect(mark.textContent).toBe('')
    expect(container.querySelector('img')).toBeNull()
  })
})

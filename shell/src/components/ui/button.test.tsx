// @vitest-environment jsdom
// The shared button system: one size scale, the same focus ring on every variant, safe defaults.
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { describe, expect, it } from 'vitest'
import { Button, buttonClass, focusRing, type ButtonSize, type ButtonVariant } from './button'
import { ghostBtn, glassBtn, primaryBtn } from '../Ws'
import { btnGhost, btnPrimary } from '../Dk'
import { primary as recoveryPrimary } from '../../screens/recovery/Frame'

const VARIANTS: ButtonVariant[] = ['primary', 'secondary', 'danger', 'glass', 'subtle', 'link']
const SIZES: ButtonSize[] = ['xs', 'sm', 'md', 'lg', 'xl', 'icon', 'icon-sm']

describe('buttonClass', () => {
  it('gives every variant and size the shared focus ring and disabled state', () => {
    for (const variant of VARIANTS) for (const size of SIZES) {
      const c = buttonClass({ variant, size })
      expect(c).toContain(focusRing)
      expect(c).toContain('disabled:cursor-default')
    }
  })
  it('keeps one radius per size, whatever the variant', () => {
    const radius = (c: string) => c.split(' ').filter((x) => /^rounded/.test(x))
    for (const size of SIZES) {
      const r = new Set(VARIANTS.filter((v) => v !== 'link').map((variant) => radius(buttonClass({ variant, size })).join()))
      expect(r.size).toBe(1)
    }
  })
  it('keeps the palette classes light theme is generated from', () => {
    expect(buttonClass({ variant: 'primary' })).toContain('bg-[#1F6BFF]')
    expect(buttonClass({ variant: 'secondary' })).toContain('text-[#E8EEFA]')
  })
  it('the older per-screen kits are the shared system, not copies of it', () => {
    expect(primaryBtn).toBe(buttonClass({ variant: 'primary', size: 'lg' }))
    expect(recoveryPrimary).toBe(primaryBtn)
    expect(ghostBtn).toBe(buttonClass({ variant: 'secondary', size: 'lg' }))
    expect(glassBtn).toBe(buttonClass({ variant: 'glass', size: 'icon' }))
    expect(btnPrimary).toBe(buttonClass({ variant: 'primary', size: 'md' }))
    expect(btnGhost).toBe(buttonClass({ variant: 'secondary', size: 'md' }))
  })
})

describe('<Button>', () => {
  it('is type="button" by default so it never submits a form by accident', async () => {
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
    const host = document.createElement('div'); document.body.append(host)
    const root = createRoot(host)
    let submitted = 0
    await act(async () => { root.render(<form onSubmit={(e) => { e.preventDefault(); submitted++ }}><Button variant="primary">Go</Button><Button type="submit">Send</Button></form>) })
    const [go, send] = host.querySelectorAll('button')
    expect(go.type).toBe('button')
    await act(async () => { go.click() })
    expect(submitted).toBe(0)
    await act(async () => { send.click() })
    expect(submitted).toBe(1)
    act(() => root.unmount()); host.remove()
  })
})

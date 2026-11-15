import { describe, expect, it } from 'vitest'
import { readFileSync, readdirSync } from 'node:fs'
import { renderToStaticMarkup } from 'react-dom/server'
import { LOADER_VARIANTS, MARKUP, WorkSuiteLoader, loaderSrc } from './WorkSuiteLoader'

const svgOf = (src: string) => decodeURIComponent(src.replace('data:image/svg+xml;charset=utf-8,', ''))

describe('WorkSuiteLoader', () => {
  it('ships the ten brand variants, each one also in branding/loaders as a file', () => {
    expect(LOADER_VARIANTS).toHaveLength(10)
    const files = readdirSync(new URL('../../../branding/loaders/', import.meta.url)).sort()
    expect(files).toEqual(LOADER_VARIANTS.map((v) => `worksuite-loader-${v}.svg`).sort())
  })
  it('draws as an isolated image, so its <style> cannot restyle the page', () => {
    const html = renderToStaticMarkup(<WorkSuiteLoader />)
    expect(html).toContain('<img')
    expect(html).not.toContain('<style')
    expect(html).toContain('role="status"')
    expect(svgOf(loaderSrc('assemble'))).toMatch(/^<svg xmlns="http:\/\/www.w3.org\/2000\/svg" viewBox="0 0 128 128">/)
  })
  it('stops moving for people who ask for reduced motion, in every variant', () => {
    for (const v of LOADER_VARIANTS) expect(MARKUP[v]).toContain('prefers-reduced-motion')
  })
  it('decorative loaders are hidden from screen readers', () => {
    const html = renderToStaticMarkup(<WorkSuiteLoader decorative size={14} />)
    expect(html).toContain('aria-hidden="true"')
    expect(html).not.toContain('role="status"')
  })
  it('replaces the old spinning rings on the splash-matching screens', () => {
    for (const f of ['SessionEnd.tsx', '../screens/Updates.tsx']) {
      const s = readFileSync(new URL(f, import.meta.url), 'utf8')
      expect(s).toContain('<WorkSuiteLoader size={120}')
      expect(s).not.toMatch(/M60 6a54 54 0 0 1 54 54/)
    }
  })
})

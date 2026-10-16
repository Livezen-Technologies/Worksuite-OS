// Real-browser accessibility check (WSOS-ACC-001…006) of the built shell preview in Chromium (Playwright):
//   node scripts/a11y-browser.mjs [outDir]      (after `npx vite build`; Playwright from the CI image or `npm i -g playwright`)
// For each main screen, at 100 % and 200 % text, in the normal and high-contrast themes, with reduced motion:
//  - axe-core with colour contrast (needs layout, so it is not part of the jsdom audit),
//  - no text cut off vertically by a fixed-size container (WCAG 1.4.4), no horizontal page scroll at 200 % (1.4.10),
//  - Tab walk: each stop gets a visible focus indicator (outline or ring),
//  - reduced motion: no running animations or transitions,
// and saves a screenshot of each state. Exits non-zero on any finding.
import { createRequire } from 'node:module'
import { execFileSync, spawn } from 'node:child_process'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'

const require = createRequire(import.meta.url)
const globalRoot = execFileSync('npm', ['root', '-g'], { encoding: 'utf8' }).trim()
const { chromium } = require(require.resolve('playwright', { paths: [process.cwd(), globalRoot] }))
const axeSource = readFileSync(require.resolve('axe-core/axe.min.js'), 'utf8')
const out = process.argv[2] ?? 'a11y-report'
mkdirSync(out, { recursive: true })

const PORT = 4179
const server = spawn('npx', ['vite', 'preview', '--port', String(PORT), '--strictPort'], { stdio: 'ignore' })
await new Promise((r) => setTimeout(r, 2500))
const BASE = `http://localhost:${PORT}/`

// Screen → how to reach it from the preview (greeter → desktop → window).
const SCREENS = {
  greeter: async () => {},
  desktop: async (p) => { await p.fill('#ws-pw', 'preview'); await p.keyboard.press('Enter'); await p.waitForSelector('nav[aria-label]') },
  launcher: async (p) => { await SCREENS.desktop(p); await p.click('button[aria-label="Open launcher"]'); await p.waitForSelector('#ws-launcher') },
  settings: async (p) => { await SCREENS.desktop(p); await p.evaluate(() => window.dispatchEvent(new KeyboardEvent('keydown', { key: 'i', metaKey: true }))); await p.click('button[aria-label="Open launcher"]'); await p.getByRole('button', { name: /^Settings$/ }).first().click(); await p.waitForSelector('[role="dialog"][aria-label="Settings"]') },
  files: async (p) => { await SCREENS.desktop(p); await p.click('button[aria-label="Open launcher"]'); await p.getByRole('button', { name: /^More/ }).first().click(); await p.waitForTimeout(300) },
  lock: async (p) => { await SCREENS.desktop(p); await p.keyboard.press('Meta+l'); await p.waitForTimeout(400) },
}
const MODES = [
  { name: '100', a11y: { highContrast: false, reducedMotion: false, textScale: 1 } },
  { name: '200', a11y: { highContrast: false, reducedMotion: false, textScale: 2 } },
  { name: 'hc-200-rm', a11y: { highContrast: true, reducedMotion: true, textScale: 2 } },
]

const findings = []
const browser = await chromium.launch()
for (const [screen, go] of Object.entries(SCREENS)) {
  for (const m of MODES) {
    const ctx = await browser.newContext({ viewport: { width: 1366, height: 768 }, bypassCSP: true, reducedMotion: m.a11y.reducedMotion ? 'reduce' : 'no-preference' })
    await ctx.addInitScript((a) => { localStorage.setItem('ws.a11y', JSON.stringify(a)); localStorage.setItem('ws.firstRunDone', '1'); localStorage.setItem('ws.locale', 'en') }, m.a11y)
    const p = await ctx.newPage()
    await p.goto(BASE)
    await p.waitForSelector('#root > *')
    try { await go(p) } catch (e) { findings.push(`${screen}/${m.name}: could not open (${e.message.split('\n')[0]})`); await ctx.close(); continue }
    await p.waitForTimeout(400)
    const tag = `${screen}-${m.name}`
    await p.screenshot({ path: path.join(out, `${tag}.png`) })
    // axe with colour contrast, in the real layout.
    await p.addScriptTag({ content: axeSource })
    const axe = await p.evaluate(async () => (await window.axe.run(document, { rules: { region: { enabled: false } } })).violations.map((v) => `${v.id} (${v.nodes.length}): ${v.nodes.slice(0, 3).map((n) => `${n.target.join(' ')} ${n.html.slice(0, 100)} ${n.any[0]?.message ?? ''}`).join(' | ')}`))
    for (const v of axe) findings.push(`${tag}: axe ${v}`)
    // Clipped text and horizontal page scroll.
    const layout = await p.evaluate(() => {
      const bad = []
      for (const el of document.querySelectorAll('body *')) {
        const cs = getComputedStyle(el)
        if (!(el.textContent ?? '').trim() || el.children.length > 0 && ![...el.childNodes].some((n) => n.nodeType === 3 && n.textContent.trim())) continue
        if (cs.visibility === 'hidden' || cs.display === 'none' || el.closest('[aria-hidden="true"], .sr-only')) continue
        const clipsY = /(hidden|clip)/.test(cs.overflowY) && !/(auto|scroll)/.test(cs.overflowY)
        if (clipsY && el.scrollHeight > el.clientHeight + 2 && cs.webkitLineClamp === 'none') bad.push(`clipped: ${el.tagName.toLowerCase()} "${el.textContent.trim().slice(0, 40)}"`)
      }
      if (document.documentElement.scrollWidth > window.innerWidth + 1) bad.push(`horizontal scroll ${document.documentElement.scrollWidth}px`)
      return bad
    })
    for (const v of layout) findings.push(`${tag}: ${v}`)
    // Tab walk: visible focus on each stop.
    const stops = []
    for (let i = 0; i < 25; i++) {
      await p.keyboard.press('Tab')
      const f = await p.evaluate(() => {
        const e = document.activeElement
        if (!e || e === document.body) return null
        const cs = getComputedStyle(e)
        const ring = (cs.outlineStyle !== 'none' && parseFloat(cs.outlineWidth) > 0) || (cs.boxShadow !== 'none')
        const parent = e.parentElement && getComputedStyle(e.parentElement)
        const parentRing = parent && parent.outlineStyle !== 'none' && parseFloat(parent.outlineWidth) > 0
        return { name: (e.getAttribute('aria-label') || e.textContent || e.tagName).trim().slice(0, 30), visible: ring || parentRing }
      })
      if (!f) continue
      stops.push(f.name)
      if (!f.visible) findings.push(`${tag}: no visible focus on "${f.name}"`)
    }
    if (!stops.length) findings.push(`${tag}: Tab reaches nothing`)
    if (m.name === '100') await p.screenshot({ path: path.join(out, `${tag}-focus.png`) })
    if (m.a11y.reducedMotion) {
      const moving = await p.evaluate(() => document.getAnimations().filter((a) => a.playState === 'running').length)
      if (moving) findings.push(`${tag}: ${moving} animations running with reduced motion`)
    }
    await ctx.close()
  }
}
await browser.close()
server.kill()
writeFileSync(path.join(out, 'findings.txt'), findings.join('\n') + '\n')
console.log(findings.length ? findings.join('\n') : 'no findings')
process.exit(findings.length ? 1 : 0)

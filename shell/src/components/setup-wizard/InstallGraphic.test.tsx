// @vitest-environment jsdom
// The install graphic shows real job states: the ring's value is the share of apps that settled, each icon carries
// its state, and reduced motion removes every animation while keeping the same facts.
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import InstallGraphic, { settledPercent } from './InstallGraphic'
import { setA11y, getA11y } from '../../lib/a11y'
import type { AppProgress } from '../../lib/setupApi'

const app = (id: string, state: AppProgress['state']): AppProgress => ({ id, name: id, required: false, state, attempts: 0, error: null })
const APPS = [app('a', 'installed'), app('b', 'installing'), app('c', 'pending'), app('d', 'queued'), app('e', 'skipped')]

let host: HTMLDivElement
let root: Root
beforeEach(() => { host = document.createElement('div'); document.body.appendChild(host); root = createRoot(host) })
afterEach(() => { act(() => root.unmount()); host.remove(); setA11y({ ...getA11y(), reducedMotion: false }) })

describe('InstallGraphic', () => {
  it('measures settled apps, ignoring ones policy skipped', () => {
    expect(settledPercent(APPS)).toBe(50)              // installed + queued of 4 real apps
    expect(settledPercent([app('x', 'skipped')])).toBeNull()
    expect(settledPercent([])).toBeNull()
  })
  it('shows the value on the ring and each app state, animating only the running app', () => {
    act(() => root.render(<InstallGraphic apps={APPS} icon={(a) => <i>{a.id}</i>} label="Your apps" />))
    const ring = host.querySelector('[role="progressbar"]')!
    expect(ring.getAttribute('aria-valuenow')).toBe('50')
    const states = [...host.querySelectorAll('li')].map((li) => [li.textContent?.[0], li.getAttribute('data-state'), li.className.includes('ws-install-active')])
    expect(states).toEqual([['a', 'installed', false], ['b', 'installing', true], ['c', 'pending', false], ['d', 'queued', false]])
  })
  it('has no value while nothing is measurable, and nothing moves under reduced motion', () => {
    setA11y({ ...getA11y(), reducedMotion: true })
    act(() => root.render(<InstallGraphic apps={[]} icon={() => null} label="Your apps" />))
    expect(host.querySelector('[role="progressbar"]')).toBeNull()
    expect(host.querySelector('.animate-spin')).toBeNull()
    act(() => root.render(<InstallGraphic apps={APPS} icon={(a) => <i>{a.id}</i>} label="Your apps" />))
    expect(host.querySelector('.ws-install-active, .ws-install-done')).toBeNull()
    expect(host.querySelector('[role="progressbar"]')!.getAttribute('aria-valuenow')).toBe('50')
  })
})

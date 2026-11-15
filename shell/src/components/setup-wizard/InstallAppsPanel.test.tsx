// @vitest-environment jsdom
// The app installation panel shows only what the setup engine reports (GetApps): the running app with its phase and
// bytes, an overall figure that cannot read 100% while an app is still running, and failures counted.
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { describe, expect, it } from 'vitest'
import { InstallAppsPanel, fmtBytes } from './SetupWizard'
import type { AppProgress } from '../../lib/setupApi'
import { setLocale } from '../../i18n'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
const app = (p: Partial<AppProgress> & { id: string }): AppProgress => ({ name: p.id, required: false, state: 'pending', attempts: 0, error: null, ...p })

function render(apps: AppProgress[]) {
  setLocale('en')
  const el = document.createElement('div'); document.body.append(el)
  const root = createRoot(el)
  act(() => root.render(<InstallAppsPanel apps={apps} send={async () => true} busy={false} headingRef={{ current: null }} />))
  return { text: el.textContent ?? '', unmount: () => act(() => root.unmount()) }
}

describe('InstallAppsPanel', () => {
  it('names the running app, its phase and its download in bytes', () => {
    const r = render([
      app({ id: 'worksuite-office', state: 'already', progress: 100 }),
      app({ id: 'vlc', state: 'installing', progress: 30, phase: 'downloading', bytesTotal: 40_000_000, bytesDone: 24_000_000 }),
    ])
    expect(r.text).toContain('Now installing')
    expect(r.text).toContain('VLC')
    expect(r.text).toContain('Downloading')
    expect(r.text).toContain('24 MB of 40 MB')
    expect(r.text).not.toContain('left')  // no estimate without measured samples
    r.unmount()
  })
  it('never reads 100% while an app is still running, and counts failures', () => {
    const r = render([
      app({ id: 'worksuite-office', state: 'installed', progress: 100 }),
      app({ id: 'worksuite-desk', state: 'failed', error: 'its dependencies cannot be resolved' }),
      app({ id: 'vlc', state: 'installing', progress: 99, phase: 'configuring' }),
    ])
    expect(r.text).toContain('99%')
    expect(r.text).not.toContain('100%')
    expect(r.text).toContain('1 couldn’t install')
    expect(r.text).toContain('Configuring')
    r.unmount()
  })
  it('formats sizes in decimal units', () => {
    expect(fmtBytes(1_500)).toBe('2 kB'); expect(fmtBytes(12_400_000)).toBe('12 MB'); expect(fmtBytes(2_100_000_000)).toBe('2.1 GB')
  })
})

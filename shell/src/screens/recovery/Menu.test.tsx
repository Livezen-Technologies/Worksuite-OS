// @vitest-environment jsdom
// Recovery's heading: "Something went wrong at startup" only after a failed start, not when chosen in the boot menu.
import { afterEach, describe, expect, it } from 'vitest'
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import Menu from './Menu'
import type { RecoveryInfo } from '../../lib/os'

let host: HTMLDivElement | null = null, root: ReturnType<typeof createRoot> | null = null
afterEach(() => { act(() => root?.unmount()); host?.remove() })

const base: RecoveryInfo = { os_version: '1.0', disk: 'vda', firmware: 'EFI', failures: null, luks: [],
  features: { unlock: false, repair: true, snapshots: false, reinstall: false, copy_usb: false, terminal: false, report_usb: false } }

async function heading(info: RecoveryInfo) {
  host = document.createElement('div'); document.body.appendChild(host); root = createRoot(host)
  await act(async () => root!.render(<Menu info={info} onOpen={() => {}} />))
  return host.querySelector('h1')?.textContent
}

describe('recovery menu heading', () => {
  it('is neutral when Recovery was chosen by hand', async () => {
    expect(await heading({ ...base, manual: true })).toBe('WorkSuite Recovery')
  })
  it('says something went wrong after a failed start', async () => {
    expect(await heading(base)).toBe('Something went wrong at startup')
    act(() => root?.unmount()); host?.remove()
    expect(await heading({ ...base, manual: true, failures: 2 })).toBe('Something went wrong at startup')
  })
})

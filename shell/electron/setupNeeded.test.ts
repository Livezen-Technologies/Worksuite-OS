// Setup's first-sign-in check: retries while the setup service starts; only a finished or absent setup means no window.
import { describe, expect, it } from 'vitest'
import { setupNeeded } from './setup'

const fast = { waitMs: 0, sleep: async () => {} }
const reply = (state: string) => ({ ok: true as const, value: { state } })

describe('setupNeeded', () => {
  it('opens setup when the service reports an unfinished state', async () => {
    expect(await setupNeeded({ state: async () => reply('WELCOME') }, fast)).toBe(true)
  })
  it('no window when setup is finished', async () => {
    expect(await setupNeeded({ state: async () => reply('SETUP_COMPLETED') }, fast)).toBe(false)
  })
  it('retries while the service is still starting, then opens setup', async () => {
    let n = 0
    const client = { state: async () => (++n < 4 ? { ok: false as const, error: 'service_unavailable' } : reply('WELCOME')) }
    expect(await setupNeeded(client, fast)).toBe(true)
    expect(n).toBe(4)
  })
  it('gives up after the retries when there is no setup service', async () => {
    let n = 0
    expect(await setupNeeded({ state: async () => { n++; throw new Error('x') } }, { ...fast, tries: 3 })).toBe(false)
    expect(n).toBe(3)
  })
})

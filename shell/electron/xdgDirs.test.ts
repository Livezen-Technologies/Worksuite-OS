import { describe, expect, it } from 'vitest'
import { xdgDirs } from './xdgDirs'

describe('§11.6-b XDG base directories', () => {
  it('defaults under the home directory', () => {
    expect(xdgDirs('/home/ana', {})).toEqual({ config: '/home/ana/.config', data: '/home/ana/.local/share', cache: '/home/ana/.cache', state: '/home/ana/.local/state' })
  })
  it('honours absolute XDG_* values and ignores relative ones', () => {
    expect(xdgDirs('/home/ana', { XDG_CONFIG_HOME: '/srv/cfg', XDG_DATA_HOME: 'rel/data', XDG_CACHE_HOME: '/tmp/c', XDG_STATE_HOME: '' }))
      .toEqual({ config: '/srv/cfg', data: '/home/ana/.local/share', cache: '/tmp/c', state: '/home/ana/.local/state' })
  })
})

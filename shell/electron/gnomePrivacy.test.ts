// The GNOME privacy backend reads and writes GNOME's own keys, inverts the "disable-*" ones, and refuses anything else.
import { describe, expect, it } from 'vitest'
import { cleanGnomePrivacy, makeGnomePrivacy } from './gnomePrivacy'

function fakeGsettings(init: Record<string, string>) {
  const store = { ...init }
  const calls: string[][] = []
  const exec = async (cmd: string, args: string[]) => {
    calls.push([cmd, ...args])
    const id = `${args[1]} ${args[2]}`
    if (args[0] === 'set') { store[id] = args[3]; return { code: 0, stdout: '', stderr: '' } }
    return id in store ? { code: 0, stdout: `${store[id]}\n`, stderr: '' } : { code: 1, stdout: '', stderr: 'No such key' }
  }
  return { exec, store, calls }
}
const INIT = {
  'org.gnome.desktop.session idle-delay': 'uint32 600', 'org.gnome.desktop.screensaver lock-enabled': 'true',
  'org.gnome.desktop.screensaver lock-delay': 'uint32 0', 'org.gnome.desktop.privacy disable-camera': 'false',
  'org.gnome.desktop.privacy disable-microphone': 'true', 'org.gnome.system.location enabled': 'false',
}

describe('GNOME privacy and screen lock', () => {
  it('reads the real keys (uint32, inverted disable-*)', async () => {
    const g = fakeGsettings(INIT)
    expect(await makeGnomePrivacy(g.exec).read()).toEqual({ available: true, value: { idleDelay: 600, lock: true, lockDelay: 0, camera: true, microphone: false, location: false } })
  })
  it('writes GNOME keys and returns what gsettings reports afterwards', async () => {
    const g = fakeGsettings(INIT)
    const r = await makeGnomePrivacy(g.exec).apply({ idleDelay: 300, camera: false })
    expect(g.store['org.gnome.desktop.session idle-delay']).toBe('uint32 300')
    expect(g.store['org.gnome.desktop.privacy disable-camera']).toBe('true')
    expect(r).toMatchObject({ available: true, value: { idleDelay: 300, camera: false } })
  })
  it('accepts only known keys and allowed values', () => {
    expect(cleanGnomePrivacy({ idleDelay: 300 })).toEqual({ idleDelay: 300 })
    expect(cleanGnomePrivacy({ idleDelay: 7 })).toBeNull()
    expect(cleanGnomePrivacy({ lock: 'yes' })).toBeNull()
    expect(cleanGnomePrivacy({ rm: true })).toBeNull()
    expect(cleanGnomePrivacy('[object Object]')).toBeNull()
  })
  it('reports unavailable when gsettings fails', async () => {
    expect(await makeGnomePrivacy(fakeGsettings({}).exec).read()).toEqual({ available: false, reason: 'failed' })
  })
})

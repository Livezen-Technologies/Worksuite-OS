import { readFileSync } from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { ADMIN_SIGNATURES, adminError, adminMessage } from './adminBus'

describe('lk.worksuite.Admin1 client (WSOS-ARC-002)', () => {
  it('names a refused, dismissed or invalid request, and a missing service', () => {
    expect(adminError('lk.worksuite.Error.NotAuthorized')).toBe('not_authorized')
    expect(adminError('lk.worksuite.Error.Cancelled')).toBe('auth_cancelled')
    expect(adminError('lk.worksuite.Error.InvalidArgs')).toBe('invalid_argument')
    expect(adminError('org.freedesktop.DBus.Error.ServiceUnknown')).toBe('unavailable')
    expect(adminError('')).toBe('unavailable')
    expect(adminError('lk.worksuite.Error.Failed')).toBe('failed')
  })

  it('sends each method to the fixed object with its fixed signature', () => {
    const m = adminMessage('Reinstall', [{ mode: 'keep', disk: 'vda' }])
    expect([m.destination, m.path, m.interface, m.member, m.signature]).toEqual(['lk.worksuite.Admin1', '/lk/worksuite/Admin1', 'lk.worksuite.Admin1', 'Reinstall', 'a{ss}'])
  })

  it('signatures match the published interface', () => {
    const xml = readFileSync(path.resolve(__dirname, '../../services/session/dbus/lk.worksuite.Admin1.xml'), 'utf8')
    const methods = Object.fromEntries([...xml.matchAll(/<method name="(\w+)">(.*?)<\/method>/g)]
      .map((m) => [m[1], [...m[2].matchAll(/type="([^"]+)" direction="in"/g)].map((a) => a[1]).join('')]))
    expect(methods).toEqual(ADMIN_SIGNATURES)
  })
})

import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { deviceInfo, enrollDevice, hostSpecs, type EnrollCall } from './device'

// A stand-in for the lk.worksuite.DeviceAgent1.Enroll call: records its arguments and answers as told.
describe('enrollDevice (lk.worksuite.DeviceAgent1.Enroll, WSOS-ARC-002)', () => {
  let dir: string
  beforeEach(() => {
    dir = mkdtempSync(path.join(tmpdir(), 'ws-enroll-'))
    writeFileSync(path.join(dir, 'status.json'), JSON.stringify({ managed: true, org_name: 'Livezen Technologies' }))
  })
  afterEach(() => { rmSync(dir, { recursive: true, force: true }) })
  const fake = (r: Awaited<ReturnType<EnrollCall>>) => { const seen: string[][] = []; const call: EnrollCall = async (u, t) => { seen.push([u, t]); return r }; return { seen, call } }

  it('calls the named D-Bus method with the code as an argument (never argv)', async () => {
    const f = fake({ ok: true, id: 'dev-9' })
    const r = await enrollDevice('https://work.livezentech.com', ' LZT-7Q4K-92XM ', path.join(dir, 'status.json'), f.call)
    expect(r).toEqual({ ok: true, value: { device_id: 'dev-9', org_name: 'Livezen Technologies' } })
    expect(f.seen).toEqual([['https://work.livezentech.com/', 'LZT-7Q4K-92XM']])
  })

  it('maps polkit refusal, a missing agent, already-enrolled and rejected codes', async () => {
    expect(await enrollDevice('https://x.example', 'ABCD-1234', undefined, fake({ ok: false, name: 'lk.worksuite.Error.NotAuthorized', message: '' }).call)).toEqual({ ok: false, error: 'auth_cancelled' })
    expect(await enrollDevice('https://x.example', 'ABCD-1234', undefined, fake({ ok: false, name: 'org.freedesktop.DBus.Error.ServiceUnknown', message: '' }).call)).toEqual({ ok: false, error: 'agent_unavailable' })
    expect((await enrollDevice('https://x.example', 'ABCD-1234', path.join(dir, 'status.json'), fake({ ok: false, name: 'lk.worksuite.Error.Failed', message: 'ALREADY_ENROLLED' }).call)).ok).toBe(true)
    expect(await enrollDevice('https://x.example', 'ABCD-1234', undefined, fake({ ok: false, name: 'lk.worksuite.Error.Failed', message: 'ENROLL_FAILED' }).call)).toEqual({ ok: false, error: 'enrollment_rejected' })
  })

  it('refuses http servers and odd codes before calling anything', async () => {
    const f = fake({ ok: true, id: 'x' })
    expect(await enrollDevice('http://x.example', 'ABCD-1234', undefined, f.call)).toEqual({ ok: false, error: 'insecure_url' })
    expect(await enrollDevice('https://x.example', 'abc; rm -rf /', undefined, f.call)).toEqual({ ok: false, error: 'invalid_code' })
    expect(f.seen).toEqual([])
  })
})

describe('deviceInfo', () => {
  it('falls back to local facts when the agent status file is missing', () => {
    const i = deviceInfo('/nonexistent/status.json')
    expect(i.agent).toBe(false)
    expect(i.managed).toBe(false)
    expect(i.device?.hostname).toBeTruthy()
  })

  it('WSOS-IDN-004: reads the provisioning requirement (https server only)', () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'ws-prov-'))
    const p = path.join(dir, 'provisioning.json')
    expect(deviceInfo('/nonexistent/status.json', p).provisioning).toEqual({ require_enrollment: false, server: null })
    writeFileSync(p, JSON.stringify({ require_enrollment: true, server: 'https://work.example.com' }))
    expect(deviceInfo('/nonexistent/status.json', p).provisioning).toEqual({ require_enrollment: true, server: 'https://work.example.com' })
    writeFileSync(p, JSON.stringify({ require_enrollment: 'yes', server: 'http://insecure.example' }))
    expect(deviceInfo('/nonexistent/status.json', p).provisioning).toEqual({ require_enrollment: false, server: null })
    rmSync(dir, { recursive: true, force: true })
  })
})

describe('Settings › About processor and memory', () => {
  it('reports the CPU model, core count and memory', () => {
    expect(hostSpecs(() => [{ model: ' Intel(R)  Core(TM) i5 ' }, { model: 'x' }], () => 8e9)).toEqual({ cpu_model: 'Intel(R) Core(TM) i5', cpu_cores: 2, memory_bytes: 8e9 })
    expect(hostSpecs(() => { throw new Error('no /proc') }, () => 0)).toEqual({ cpu_model: null, cpu_cores: null, memory_bytes: null })
  })
  it('comes with deviceInfo', () => {
    expect(deviceInfo('/nonexistent', '/nonexistent').specs.cpu_cores).toBeGreaterThan(0)
  })
})

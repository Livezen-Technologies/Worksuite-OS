import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { deviceInfo, enrollDevice } from './device'

// A stand-in pkexec on PATH: records argv and stdin, then behaves as told by $FAKE_PKEXEC.
describe('enrollDevice', () => {
  let dir: string
  const oldPath = process.env.PATH
  beforeEach(() => {
    dir = mkdtempSync(path.join(tmpdir(), 'ws-enroll-'))
    writeFileSync(path.join(dir, 'pkexec'), `#!/bin/sh
printf '%s\\n' "$@" > "${dir}/argv"
cat > "${dir}/stdin"
case "$FAKE_PKEXEC" in
  ok) echo '"dev-9"'; exit 0 ;;
  cancel) exit 126 ;;
  already) echo 'error: ALREADY_ENROLLED' >&2; exit 1 ;;
  *) echo 'error: 400 ENROLLMENT_TOKEN_INVALID' >&2; exit 1 ;;
esac
`)
    chmodSync(path.join(dir, 'pkexec'), 0o755)
    writeFileSync(path.join(dir, 'status.json'), JSON.stringify({ managed: true, org_name: 'Livezen Technologies' }))
    process.env.PATH = `${dir}:${oldPath}`
  })
  afterEach(() => { process.env.PATH = oldPath; rmSync(dir, { recursive: true, force: true }) })

  it('runs the agent CLI through pkexec with fixed arguments and the code on stdin only', async () => {
    process.env.FAKE_PKEXEC = 'ok'
    const r = await enrollDevice('https://work.livezentech.com', ' LZT-7Q4K-92XM ', path.join(dir, 'status.json'))
    expect(r).toEqual({ ok: true, value: { device_id: 'dev-9', org_name: 'Livezen Technologies' } })
    expect(readFileSync(path.join(dir, 'argv'), 'utf8').trim().split('\n')).toEqual(['/usr/bin/worksuite-device-agent', 'enroll', '--server', 'https://work.livezentech.com/'])
    expect(readFileSync(path.join(dir, 'stdin'), 'utf8')).toBe('LZT-7Q4K-92XM\n')
  })

  it('maps cancelled authentication, already-enrolled and rejected codes', async () => {
    process.env.FAKE_PKEXEC = 'cancel'
    expect(await enrollDevice('https://x.example', 'ABCD-1234')).toEqual({ ok: false, error: 'auth_cancelled' })
    process.env.FAKE_PKEXEC = 'already'
    expect((await enrollDevice('https://x.example', 'ABCD-1234', path.join(dir, 'status.json'))).ok).toBe(true)
    process.env.FAKE_PKEXEC = 'reject'
    expect(await enrollDevice('https://x.example', 'ABCD-1234')).toEqual({ ok: false, error: 'enrollment_rejected' })
  })

  it('refuses http servers and odd codes before running anything', async () => {
    expect(await enrollDevice('http://x.example', 'ABCD-1234')).toEqual({ ok: false, error: 'insecure_url' })
    expect(await enrollDevice('https://x.example', 'abc; rm -rf /')).toEqual({ ok: false, error: 'invalid_code' })
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

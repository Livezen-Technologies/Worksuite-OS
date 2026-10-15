import { describe, expect, it } from 'vitest'
import { packageClient, parseMonitorLine, type Exec } from './packages'

function fakeExec(reply: { code?: number; stdout?: string; stderr?: string }) {
  const calls: string[][] = []
  const exec: Exec = async (cmd, args) => { calls.push([cmd, ...args]); return { code: 0, stdout: '', stderr: '', ...reply } }
  return { exec, calls }
}

describe('package client', () => {
  it('calls the service with fixed busctl arguments and interactive polkit', async () => {
    const f = fakeExec({ stdout: '{"type":"o","data":["/lk/worksuite/PackageService1/job/4"]}' })
    expect(await packageClient(f.exec).start('Install', 'flatpak:org.gimp.GIMP')).toEqual({ ok: true, value: '/lk/worksuite/PackageService1/job/4' })
    expect(f.calls[0]).toEqual(['busctl', '--system', '--json=short', '--allow-interactive-authorization=yes', '--timeout=300', 'call',
      'lk.worksuite.PackageService1', '/lk/worksuite/PackageService1', 'lk.worksuite.PackageService1', 'Install', 'ss', 'flatpak', 'flatpak:org.gimp.GIMP'])
  })

  it('parses the preview JSON', async () => {
    const preview = { plan: { install: [{ name: 'gimp', version: '2' }], upgrade: [], remove: [] }, disk_bytes: 5, permissions: [], broad: [] }
    const f = fakeExec({ stdout: JSON.stringify({ type: 's', data: [JSON.stringify(preview)] }) })
    expect(await packageClient(f.exec).preview('apt:gimp', 'install')).toEqual({ ok: true, value: preview })
  })

  it('rejects odd catalog ids before calling anything', async () => {
    const f = fakeExec({})
    for (const id of ['gimp', 'deb:gimp', 'apt:-oFoo=1', 'apt:gimp; reboot']) expect((await packageClient(f.exec).start('Install', id)).ok).toBe(false)
    expect(f.calls).toEqual([])
  })

  it('maps service errors', async () => {
    const denied = fakeExec({ code: 1, stderr: 'Call failed: Not authorized\n' })
    expect(await packageClient(denied.exec).start('Remove', 'apt:gimp')).toEqual({ ok: false, error: 'not_authorized' })
    const policy = fakeExec({ code: 1, stderr: 'Call failed: not approved by your organization\n' })
    expect(await packageClient(policy.exec).start('Install', 'apt:nmap')).toEqual({ ok: false, error: 'not approved by your organization' })
    const down = fakeExec({ code: 1, stderr: 'Failed to call method: The name lk.worksuite.PackageService1 was not provided by any .service files\n' })
    expect(await packageClient(down.exec).applyUpdate()).toEqual({ ok: false, error: 'service_unavailable' })
  })
})

describe('parseMonitorLine', () => {
  it('reads JobProgress and JobFinished signals from gdbus monitor', () => {
    expect(parseMonitorLine("/lk/worksuite/PackageService1: lk.worksuite.PackageService1.JobProgress (objectpath '/lk/worksuite/PackageService1/job/3', uint32 30, 'installing')"))
      .toEqual({ job: '/lk/worksuite/PackageService1/job/3', kind: 'progress', percent: 30, phase: 'installing' })
    expect(parseMonitorLine("/lk/worksuite/PackageService1: lk.worksuite.PackageService1.JobFinished (objectpath '/lk/worksuite/PackageService1/job/3', 'failed', {'kind': <'install'>, 'error': <'would remove greetd'>})"))
      .toEqual({ job: '/lk/worksuite/PackageService1/job/3', kind: 'finished', result: 'failed', error: 'would remove greetd' })
    expect(parseMonitorLine("/lk/worksuite/PackageService1: lk.worksuite.PackageService1.JobFinished (objectpath '/lk/worksuite/PackageService1/job/4', 'success', {'kind': <'remove'>})"))
      .toEqual({ job: '/lk/worksuite/PackageService1/job/4', kind: 'finished', result: 'success' })
    expect(parseMonitorLine('something else')).toBeNull()
  })
})

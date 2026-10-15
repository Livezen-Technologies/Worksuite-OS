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

describe('checkUpdates', () => {
  it('unwraps busctl a{sv} JSON', async () => {
    const f = fakeExec({ stdout: JSON.stringify({ type: 'a{sv}', data: [{
      apt: { type: 'u', data: 2 }, flatpak: { type: 'u', data: 1 }, packages: { type: 'as', data: ['firefox-esr', 'libc6'] },
      flatpaks: { type: 'as', data: ['org.gimp.GIMP'] }, reboot_required: { type: 'b', data: true }, state: { type: 's', data: 'idle' },
    }] }) })
    expect(await packageClient(f.exec).checkUpdates()).toEqual({ ok: true, value: { packages: ['firefox-esr', 'libc6'], flatpaks: ['org.gimp.GIMP'], reboot_required: true, state: 'idle' } })
    expect(f.calls[0].slice(-1)).toEqual(['CheckUpdates'])
  })
})

describe('UpdateStatusChanged', () => {
  it('parses the coordinator status from real gdbus monitor output', () => {
    const e = parseMonitorLine("/lk/worksuite/PackageService1: lk.worksuite.PackageService1.UpdateStatusChanged ('{\"state\":\"failed\",\"version\":null,\"installed\":\"1.0.1\",\"release_id\":null,\"mandatory\":false,\"deadline\":null,\"deferrals_left\":null,\"reason\":\"update information failed its signature check\",\"restart_at\":null,\"last_check\":0}',)")
    expect(e?.kind).toBe('update_status')
    expect(e?.status).toMatchObject({ state: 'failed', installed: '1.0.1', reason: 'update information failed its signature check' })
  })
  it('unescapes the quotes GVariant escapes', () => {
    const line = String.raw`/lk/worksuite/PackageService1: lk.worksuite.PackageService1.UpdateStatusChanged ('{"state":"failed","reason":"can\'t reach the update server"}',)`
    expect(parseMonitorLine(line)?.status).toMatchObject({ state: 'failed', reason: "can't reach the update server" })
  })
})

describe('update coordinator calls', () => {
  it('Install now and Later go through busctl with interactive polkit', async () => {
    const f = fakeExec({ stdout: '{"type":"b","data":[false]}' })
    expect(await packageClient(f.exec).deferUpdate()).toEqual({ ok: true, value: false })
    expect(f.calls[0]).toContain('--allow-interactive-authorization=yes')
    expect(f.calls[0].slice(-1)).toEqual(['DeferUpdate'])
    const g = fakeExec({ stdout: JSON.stringify({ type: 's', data: [JSON.stringify({ state: 'up_to_date', installed: '1.0.2' })] }) })
    expect(await packageClient(g.exec).updateStatus(true)).toEqual({ ok: true, value: { state: 'up_to_date', installed: '1.0.2' } })
    expect(g.calls[0].slice(-1)).toEqual(['CheckForUpdates'])
  })
})

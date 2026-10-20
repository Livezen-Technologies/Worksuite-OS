import { describe, expect, it } from 'vitest'
import { existsSync, mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { appimageClient, flatpakUserClient, packageClient, parseMonitorLine, type Exec } from './packages'

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

describe('catalog, local .deb, Flatpak, bundles', () => {
  it('GetCatalog / PreviewLocalDeb / InspectBundle return the service JSON', async () => {
    const cat = { state: 'not_enrolled', arch: 'amd64', items: [], error: 'x' }
    const f = fakeExec({ stdout: JSON.stringify({ type: 's', data: [JSON.stringify(cat)] }) })
    expect(await packageClient(f.exec).catalog()).toEqual({ ok: true, value: cat })
    expect(f.calls[0].slice(-1)).toEqual(['GetCatalog'])
    await packageClient(f.exec).localDebPreview('/home/u/Downloads/hello.deb')
    expect(f.calls[1].slice(-3)).toEqual(['PreviewLocalDeb', 's', '/home/u/Downloads/hello.deb'])
    await packageClient(f.exec).bundleInspect('/media/u/USB/os.wsupdate')
    expect(f.calls[2].slice(-3)).toEqual(['InspectBundle', 's', '/media/u/USB/os.wsupdate'])
  })

  it('refuses bad arguments before calling the service', async () => {
    const f = fakeExec({})
    const c = packageClient(f.exec)
    for (const r of await Promise.all([c.localDebPreview('hello.deb'), c.localDebPreview('/x/hello.rpm'), c.localDebInstall('abc'), c.bundleInstall('/x/y.tar'),
      c.appPermissions('apt:gimp'), c.resetAppPermissions('flatpak:--all'), c.appPermissions('flatpak:../../etc')])) expect(r.ok).toBe(false)
    expect(f.calls).toEqual([])
  })

  it('install/reset/prune return job paths through interactive polkit', async () => {
    const f = fakeExec({ stdout: '{"type":"o","data":["/lk/worksuite/PackageService1/job/9"]}' })
    const c = packageClient(f.exec)
    expect(await c.localDebInstall('a'.repeat(64))).toEqual({ ok: true, value: '/lk/worksuite/PackageService1/job/9' })
    expect(await c.resetAppPermissions('flatpak:org.gimp.GIMP')).toEqual({ ok: true, value: '/lk/worksuite/PackageService1/job/9' })
    expect(await c.pruneRuntimes()).toEqual({ ok: true, value: '/lk/worksuite/PackageService1/job/9' })
    expect(await c.bundleInstall('/media/u/USB/os.wsupdate')).toEqual({ ok: true, value: '/lk/worksuite/PackageService1/job/9' })
    expect(f.calls.map((c) => c[9])).toEqual(['InstallLocalDeb', 'ResetAppPermissions', 'PruneRuntimes', 'InstallBundle'])
    expect(f.calls.every((c) => c.includes('--allow-interactive-authorization=yes'))).toBe(true)
  })

  it('user-side Flatpak reset and app data removal stay in the user home and never follow links', async () => {
    const home = mkdtempSync(join(tmpdir(), 'ws-home-'))
    const f = fakeExec({})
    const u = flatpakUserClient(f.exec, home)
    expect(await u.resetUserPermissions('flatpak:org.gimp.GIMP')).toEqual({ ok: true, value: true })
    expect(f.calls).toEqual([['flatpak', 'permission-reset', 'org.gimp.GIMP'], ['flatpak', 'override', '--user', '--reset', 'org.gimp.GIMP']])
    mkdirSync(join(home, '.var/app/org.gimp.GIMP/config'), { recursive: true })
    writeFileSync(join(home, '.var/app/org.gimp.GIMP/config/gimprc'), 'x')
    expect(u.removeAppData('flatpak:org.gimp.GIMP')).toEqual({ ok: true, value: true })
    expect(existsSync(join(home, '.var/app/org.gimp.GIMP'))).toBe(false)
    expect(u.removeAppData('flatpak:org.gimp.GIMP')).toEqual({ ok: true, value: false })
    const victim = mkdtempSync(join(tmpdir(), 'ws-victim-'))
    symlinkSync(victim, join(home, '.var/app/org.evil.App'))
    expect(u.removeAppData('flatpak:org.evil.App').ok).toBe(false)
    expect(existsSync(victim)).toBe(true)
    expect(u.removeAppData('flatpak:..').ok).toBe(false)
  })
})

describe('AppImage client', () => {
  it('runs worksuite-appimage with fixed arguments and unwraps its JSON', async () => {
    const f = fakeExec({ stdout: '{"ok":true,"value":[]}\n' })
    const a = appimageClient(f.exec, '/usr/bin/worksuite-appimage')
    expect(await a.list()).toEqual({ ok: true, value: [] })
    await a.import('/home/u/Downloads/Pinta.AppImage', 'file:///home/u/Downloads/Pinta.AppImage')
    await a.approve('0123456789abcdef')
    expect(f.calls).toEqual([
      ['/usr/bin/worksuite-appimage', 'list'],
      ['/usr/bin/worksuite-appimage', 'import', '/home/u/Downloads/Pinta.AppImage', '--origin', 'file:///home/u/Downloads/Pinta.AppImage'],
      ['/usr/bin/worksuite-appimage', 'approve', '0123456789abcdef'],
    ])
    const bad = fakeExec({ code: 1, stdout: '{"ok":false,"code":"ArchMismatch","error":"This AppImage is built for ARM64; this device is x86-64"}\n' })
    expect(await appimageClient(bad.exec).import('/x/a.AppImage')).toEqual({ ok: false, error: 'This AppImage is built for ARM64; this device is x86-64' })
    for (const r of await Promise.all([a.approve('../x'), a.remove('x'), a.import('/x/a.exe'), a.update('0123456789abcdef', 'rel.AppImage')])) expect(r.ok).toBe(false)
  })
})

describe('WSOS-APT-006 service state', () => {
  it('reads the State property without polkit and passes only known values', async () => {
    const f = fakeExec({ stdout: '{"type":"s","data":"interrupted"}' })
    expect(await packageClient(f.exec).serviceState()).toEqual({ ok: true, value: 'interrupted' })
    expect(f.calls[0]).toEqual(['busctl', '--system', '--json=short', 'get-property', 'lk.worksuite.PackageService1', '/lk/worksuite/PackageService1', 'lk.worksuite.PackageService1', 'State'])
    expect(await packageClient(fakeExec({ stdout: '{"type":"s","data":"weird"}' }).exec).serviceState()).toEqual({ ok: false, error: 'failed' })
    expect(await packageClient(fakeExec({ code: 1, stderr: 'Failed: ServiceUnknown' }).exec).serviceState()).toEqual({ ok: false, error: 'service_unavailable' })
  })
})

describe('drivers', () => {
  it('DriversChanged signal → report; GetDrivers / CheckDrivers / InstallDrivers with fixed arguments', async () => {
    expect(parseMonitorLine("/lk/worksuite/PackageService1: lk.worksuite.PackageService1.DriversChanged ('{\"state\":\"idle\",\"offers\":[]}',)"))
      .toEqual({ job: '', kind: 'drivers', status: { state: 'idle', offers: [] } })
    const f = fakeExec({ stdout: '{"type":"s","data":["{\\"state\\":\\"idle\\"}"]}' })
    expect(await packageClient(f.exec).driverReport(true)).toEqual({ ok: true, value: { state: 'idle' } })
    expect(f.calls[0].slice(-4)).toEqual(['lk.worksuite.PackageService1', 'CheckDrivers', 's', 'manual'])
    await packageClient(f.exec).driverReport(false)
    expect(f.calls[1].at(-1)).toBe('GetDrivers')
    await packageClient(f.exec).installDrivers(['fw:firmware-iwlwifi', '--evil', 'gpu:nvidia-driver'])
    expect(f.calls[2].slice(-5)).toEqual(['InstallDrivers', 'as', '2', 'fw:firmware-iwlwifi', 'gpu:nvidia-driver'])
    expect(await packageClient(f.exec).installDrivers(['; rm'])).toEqual({ ok: false, error: 'invalid_argument' })
    await packageClient(f.exec).mokPassword()
    expect(f.calls[3]).toContain('--allow-interactive-authorization=yes')
    expect(f.calls[3].at(-1)).toBe('GetMokPassword')
  })
})

describe('Update Manager and Software Management calls', () => {
  it('history and app updates are read-only JSON calls; UpdateApps passes only Flatpak ids', async () => {
    const hist = { pending: [], entries: [{ id: 'e1', kind: 'os', title: 'WorkSuite OS', version: '1.4.0', result: 'success', started_at: 1, finished_at: 2 }] }
    const f = fakeExec({ stdout: JSON.stringify({ type: 's', data: [JSON.stringify(hist)] }) })
    const c = packageClient(f.exec)
    expect(await c.updateHistory()).toEqual({ ok: true, value: hist })
    await c.appUpdates()
    expect(f.calls.map((x) => x[9])).toEqual(['GetUpdateHistory', 'GetAppUpdates'])
    const j = fakeExec({ stdout: '{"type":"o","data":["/lk/worksuite/PackageService1/job/3"]}' })
    expect(await packageClient(j.exec).updateApps(['flatpak:org.gimp.GIMP'])).toEqual({ ok: true, value: '/lk/worksuite/PackageService1/job/3' })
    expect(j.calls[0].slice(9)).toEqual(['UpdateApps', 'as', '1', 'org.gimp.GIMP'.replace(/^/, 'flatpak:')])
    await packageClient(j.exec).updateApps([])
    expect(j.calls[1].slice(9)).toEqual(['UpdateApps', 'as', '0'])
    expect((await packageClient(j.exec).updateApps(['apt:gimp'])).ok).toBe(false)
    expect(j.calls.length).toBe(2)
  })

  it('RequestApp sends the catalog id and a cleaned reason, never odd ids', async () => {
    const f = fakeExec({ stdout: JSON.stringify({ type: 's', data: [JSON.stringify({ id: 'r1', state: 'pending' })] }) })
    const c = packageClient(f.exec)
    expect(await c.requestApp('apt:inkscape', 'For diagrams\nplease')).toEqual({ ok: true, value: { id: 'r1', state: 'pending' } })
    expect(f.calls[0].slice(9)).toEqual(['RequestApp', 'ss', 'apt:inkscape', 'For diagrams please'])
    expect((await c.requestApp('apt:x; reboot', '')).ok).toBe(false)
    expect(f.calls.length).toBe(1)
  })
})

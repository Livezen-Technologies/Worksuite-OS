import { describe, expect, it } from 'vitest'
import { appPermissionsBridge, deniedByPolicy, diffGrants, ENFORCEMENT, mediaInUse, parseAppPolicy, parsePermissions } from './appPermissions'
import type { Exec } from './system'

const STORE = [
  'Table\tObject\tApp\tPermissions\tData',
  'devices\tcamera\tcom.example.Meet\tyes\t0x00',
  'devices\tmicrophone\tcom.example.Meet\tno\t0x00',
  'location\tlocation\torg.gnome.Maps\tEXACT,1700000000\t0x00',
  'notifications\tnotification\torg.mozilla.firefox\tyes\t0x00',
  'documents\tabc\torg.gnome.Builder\tread,write\t0x00',
  'devices\tcamera\t../evil\tyes\t0x00',
].join('\n')

function world(o: { policy?: unknown; store?: string; pw?: string } = {}) {
  const calls: string[][] = []
  const files: Record<string, string> = {}
  let store = o.store ?? STORE
  const exec: Exec = async (cmd, args) => {
    calls.push([cmd, ...args])
    if (cmd === 'flatpak' && args[0] === 'permissions') return { code: 0, stdout: store, stderr: '' }
    if (cmd === 'flatpak' && args[0] === 'list') return { code: 0, stdout: 'com.example.Meet\norg.gnome.Maps\n', stderr: '' }
    if (cmd === 'flatpak' && args[0] === 'permission-set') { store += `\n${args[1]}\t${args[2]}\t${args[3]}\t${args[4]}\t0x00`; return { code: 0, stdout: '', stderr: '' } }
    if (cmd === 'pw-dump') return { code: 0, stdout: o.pw ?? '[]', stderr: '' }
    return { code: 0, stdout: '', stderr: '' }
  }
  let t = 1000
  const b = appPermissionsBridge({
    exec, readPolicy: () => (o.policy === undefined ? null : JSON.stringify(o.policy)), stateDir: '/s', now: () => t++,
    read: async (p) => files[p] ?? null, append: async (p, s) => { files[p] = (files[p] ?? '') + s }, write: async (p, s) => { files[p] = s },
  })
  return { b, calls, files, setStore: (s: string) => { store = s } }
}

describe('app permissions (issue #21)', () => {
  it('parses the permission store; only resources we manage, only real app ids', () => {
    expect(parsePermissions(STORE)).toEqual([
      { resource: 'camera', app: 'com.example.Meet', allowed: true },
      { resource: 'microphone', app: 'com.example.Meet', allowed: false },
      { resource: 'location', app: 'org.gnome.Maps', allowed: true },
      { resource: 'notifications', app: 'org.mozilla.firefox', allowed: true },
    ])
    expect(parsePermissions('location  location  org.gnome.Maps  NONE  0x00')[0].allowed).toBe(false)
  })
  it('organization policy: deny only, wildcard, malformed ignored', () => {
    const p = parseAppPolicy(JSON.stringify({ app_permissions: { deny: { camera: ['*'], location: ['org.gnome.Maps', '; rm -rf'], exec: ['x.y.z'] } } }))
    expect(p.deny).toEqual({ camera: ['*'], location: ['org.gnome.Maps'] })
    expect(deniedByPolicy(p, 'camera', 'any.app.Id')).toBe(true)
    expect(deniedByPolicy(p, 'microphone', 'any.app.Id')).toBe(false)
    expect(parseAppPolicy('garbage').deny).toEqual({})
  })
  it('applies deny rules to the store, refuses to allow what policy denies, locks shown', async () => {
    const w = world({ policy: { app_permissions: { deny: { camera: ['com.example.Meet'] } } } })
    const r = await w.b.state()
    expect(w.calls).toContainEqual(['flatpak', 'permission-set', 'devices', 'camera', 'com.example.Meet', 'no'])
    expect(r.ok && r.value.grants.filter((g) => g.app === 'com.example.Meet' && g.resource === 'camera').every((g) => g.locked)).toBe(true)
    expect(await w.b.set('camera', 'com.example.Meet', true)).toEqual({ ok: false, error: 'blocked_by_policy' })
    expect(w.files['/s/events.jsonl']).toContain('policy_denied')
  })
  it('user changes go through fixed argv and are logged; bad input refused', async () => {
    const w = world()
    expect(await w.b.set('location', 'org.gnome.Maps', false)).toEqual({ ok: true, value: true })
    expect(w.calls).toContainEqual(['flatpak', 'permission-set', 'location', 'location', 'org.gnome.Maps', 'NONE'])
    expect(await w.b.revoke('camera', 'com.example.Meet')).toEqual({ ok: true, value: true })
    expect(w.calls).toContainEqual(['flatpak', 'permission-remove', 'devices', 'camera', 'com.example.Meet'])
    expect(await w.b.reset('com.example.Meet')).toEqual({ ok: true, value: true })
    expect(w.calls).toContainEqual(['flatpak', 'permission-reset', 'com.example.Meet'])
    for (const bad of [w.b.set('root', 'com.example.Meet', true), w.b.set('camera', '--help', true), w.b.reset('../x')]) expect(await bad).toEqual({ ok: false, error: 'invalid_argument' })
    const recent = await w.b.recent()
    expect(recent.map((e) => e.action)).toEqual(['reset', 'removed', 'denied'])
  })
  it('decisions made in portal prompts since the last look are recorded as requests', async () => {
    const w = world({ store: 'devices\tcamera\tcom.example.Meet\tyes\t' })
    await w.b.state()
    w.setStore('devices\tcamera\tcom.example.Meet\tyes\t\ndevices\tmicrophone\tcom.example.Meet\tno\t')
    await w.b.state()
    const r = await w.b.recent()
    expect(r[0]).toMatchObject({ app: 'com.example.Meet', resource: 'microphone', action: 'denied', by: 'app_request' })
    expect(diffGrants([], [], 1)).toEqual([])
  })
  it('camera and microphone in use from PipeWire; screencast streams are not the camera', () => {
    const pw = JSON.stringify([
      { type: 'PipeWire:Interface:Node', info: { state: 'running', props: { 'media.class': 'Stream/Input/Audio', 'pipewire.access.portal.app_id': 'com.example.Meet' } } },
      { type: 'PipeWire:Interface:Node', info: { state: 'running', props: { 'media.class': 'Stream/Input/Video', 'application.name': 'Cheese' } } },
      { type: 'PipeWire:Interface:Node', info: { state: 'running', props: { 'media.class': 'Stream/Input/Video', 'node.name': 'xdpw_stream_1' } } },
      { type: 'PipeWire:Interface:Node', info: { state: 'suspended', props: { 'media.class': 'Stream/Input/Audio', 'application.name': 'Idle' } } },
    ])
    expect(mediaInUse(pw)).toEqual({ camera: ['Cheese'], microphone: ['com.example.Meet'] })
    expect(mediaInUse('nope')).toEqual({ camera: [], microphone: [] })
  })
  it('never claims protection it cannot enforce', () => {
    expect(ENFORCEMENT.clipboard.stored).toBe(false)
    expect(ENFORCEMENT.camera.scope).toBe('sandboxed')
    expect(ENFORCEMENT.screen_recording.scope).toBe('all')
  })
})

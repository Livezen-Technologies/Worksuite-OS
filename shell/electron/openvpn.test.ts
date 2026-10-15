// OpenVPN import (WSOS-INT-001): validation, refused hooks, certificate handling and the nmcli bridge.
import { describe, expect, it } from 'vitest'
import { ovpnConnectionName, ovpnWords, openvpnNeedsCredentials, parseOvpn, parseVpnData, renderOvpnForImport, safeRelativeRef } from './openvpn'
import { OPENVPN_SERVICE, systemBridge, type Exec, type VpnDeps } from './system'

const OVPN = `client
dev tun
proto udp
remote vpn.example.net 1194
remote-cert-tls server
auth-user-pass
cipher AES-256-GCM
ca ca.crt
tls-auth [inline] 1
<tls-auth>
-----BEGIN OpenVPN Static key V1-----
abcd
-----END OpenVPN Static key V1-----
</tls-auth>
`

describe('parseOvpn', () => {
  it('summarizes a client config and collects inline and referenced files', () => {
    const r = parseOvpn(OVPN)
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.value).toMatchObject({ remotes: ['vpn.example.net:1194'], proto: 'udp', dev: 'tun', needs_credentials: true })
    expect(r.value.files.map((f) => [f.directive, f.path, f.inline !== null, f.extra])).toEqual([['ca', 'ca.crt', false, []], ['tls-auth', null, true, ['1']]])
    expect(r.lines).not.toContain('ca ca.crt')
    const out = renderOvpnForImport(r.lines, r.value.files, ['/p/0-ca.pem', '/p/1-tls-auth.key'])
    expect(out).toContain('tls-auth "/p/1-tls-auth.key" 1')
    expect(out).toContain('ca "/p/0-ca.pem"')
    expect(out).not.toContain('BEGIN OpenVPN Static key')
  })
  it.each([
    ['up /etc/openvpn/update-resolv-conf'], ['down /x.sh'], ['route-up "/bin/sh -c id"'], ['--up evil'], ['plugin /usr/lib/x.so'],
    ['tls-verify /x'], ['auth-user-pass-verify /x via-env'], ['ipchange /x'], ['learn-address /x'], ['client-connect /x'],
    ['script-security 2'], ['script-security 3'], ['script-security two'], ['config other.ovpn'], ['log /etc/passwd'],
  ])('refuses script hook %s', (line) => {
    expect(parseOvpn(`${OVPN}${line}\n`)).toEqual({ ok: false, error: 'scripts_not_supported' })
  })
  it('allows script-security 0/1 and drops it', () => {
    const r = parseOvpn(`${OVPN}script-security 1\n`)
    expect(r.ok && r.lines.some((l) => l.startsWith('script-security'))).toBe(false)
  })
  it('refuses stored credentials, missing remotes and junk', () => {
    expect(parseOvpn(OVPN.replace('auth-user-pass', 'auth-user-pass creds.txt'))).toEqual({ ok: false, error: 'credentials_in_file' })
    expect(parseOvpn(`${OVPN}<auth-user-pass>\nu\np\n</auth-user-pass>\n`)).toEqual({ ok: false, error: 'credentials_in_file' })
    expect(parseOvpn(OVPN.replace(/remote vpn.*\n/, ''))).toEqual({ ok: false, error: 'invalid_remote' })
    expect(parseOvpn(OVPN.replace('vpn.example.net', 'a;b'))).toEqual({ ok: false, error: 'invalid_remote' })
    expect(parseOvpn('<ca>\nunterminated')).toEqual({ ok: false, error: 'invalid_file' })
    expect(parseOvpn('hello world')).toEqual({ ok: false, error: 'invalid_remote' })
    expect(parseOvpn('remote a 1\n')).toEqual({ ok: false, error: 'invalid_file' })   // neither client nor static key
  })
  it('helpers', () => {
    expect(ovpnWords(`ca "my certs/ca.crt" x`)).toEqual(['ca', 'my certs/ca.crt', 'x'])
    expect(safeRelativeRef('ca.crt')).toBe(true)
    expect(safeRelativeRef('keys/ca.crt')).toBe(true)
    expect(safeRelativeRef('../ca.crt')).toBe(false)
    expect(safeRelativeRef('/etc/ssl/ca.crt')).toBe(false)
    expect(ovpnConnectionName('Office VPN!.ovpn')).toBe('Office VPN')
    expect(ovpnConnectionName('$$.ovpn')).toBe('OpenVPN')
    const d = parseVpnData('ca = /a/ca.pem, connection-type = password, remote = a:1194\\, b:443, username = bob')
    expect(d).toMatchObject({ 'connection-type': 'password', remote: 'a:1194, b:443', username: 'bob' })
    expect(openvpnNeedsCredentials(d)).toBe(true)
    expect(openvpnNeedsCredentials({ 'connection-type': 'tls' })).toBe(false)
  })
})

const UUID = '33333333-3333-4333-8333-333333333333'
function bridge(policy: string | null = null, opts: { needsCreds?: boolean } = {}) {
  const calls: string[][] = [], stdin: { args: string[]; input: string }[] = []
  const certs: { name: string; files: string[] }[] = [], removed: string[] = []
  let staged = ''
  const exec: Exec = async (cmd, args) => {
    calls.push([cmd, ...args])
    if (args.includes('import')) return { code: 0, stdout: `Connection 'office' (${UUID}) successfully added.\n`, stderr: '' }
    if (args[0] === '-t') return { code: 0, stdout: `Office:${UUID}:vpn:no:--\n`, stderr: '' }
    if (args[1] === 'vpn.service-type') return { code: 0, stdout: `${OPENVPN_SERVICE}\n`, stderr: '' }
    if (args[1] === 'vpn.data') return { code: 0, stdout: `connection-type = ${opts.needsCreds ? 'password-tls' : 'tls'}, remote = a:1194\n`, stderr: '' }
    return { code: 0, stdout: '', stderr: '' }
  }
  const deps: VpnDeps = {
    readPolicy: () => policy,
    async stage(name, text) { staged = text; return { path: `/tmp/x/${name}`, cleanup: async () => {} } },
    async storeCerts(name, files) { certs.push({ name, files: files.map((f) => f.name) }); return files.map((f) => `/home/u/.local/share/worksuite/vpn/${name}/${f.name}`) },
    async removeCerts(name) { removed.push(name) },
  }
  const b = systemBridge(exec, async (_cmd, args, input) => { stdin.push({ args, input }); return { code: 0, stderr: '' } }, deps)
  return { b, calls, stdin, certs, removed, staged: () => staged }
}

describe('OpenVPN bridge', () => {
  it('imports via nmcli with private certificate copies', async () => {
    const t = bridge()
    const r = await t.b.vpnImportOpenvpn('Office VPN.ovpn', OVPN, { readRef: (p) => (p === 'ca.crt' ? Buffer.from('CA') : null) })
    expect(r).toEqual({ ok: true, value: { uuid: UUID, name: 'Office VPN', needs_credentials: true } })
    expect(t.certs).toEqual([{ name: 'Office VPN', files: ['0-ca.pem', '1-tls-auth.key'] }])
    expect(t.calls).toContainEqual(['nmcli', 'connection', 'import', 'type', 'openvpn', 'file', '/tmp/x/Office VPN.ovpn'])
    expect(t.calls).toContainEqual(['nmcli', 'connection', 'modify', 'uuid', UUID, 'connection.id', 'Office VPN', 'connection.autoconnect', 'no', '+vpn.data', 'password-flags=2'])
    expect(t.staged()).toContain('/home/u/.local/share/worksuite/vpn/Office VPN/0-ca.pem')
  })
  it('refuses missing certificates, unsafe paths, hooks and policy block before nmcli import', async () => {
    const t = bridge()
    expect(await t.b.vpnImportOpenvpn('a.ovpn', OVPN, { readRef: () => null })).toEqual({ ok: false, error: 'missing_certificate' })
    expect(await t.b.vpnImportOpenvpn('a.ovpn', OVPN.replace('ca ca.crt', 'ca /etc/ssl/x.pem'), { readRef: () => Buffer.from('x') })).toEqual({ ok: false, error: 'unsafe_path' })
    expect(await t.b.vpnImportOpenvpn('a.ovpn', `${OVPN}up /x\n`, { readRef: () => Buffer.from('x') })).toEqual({ ok: false, error: 'scripts_not_supported' })
    expect(t.calls.some((c) => c.includes('import'))).toBe(false)
    const blocked = bridge('{"user_vpn":"block"}')
    expect(await blocked.b.vpnImportOpenvpn('a.ovpn', OVPN, { readRef: () => Buffer.from('x') })).toEqual({ ok: false, error: 'blocked_by_policy' })
    expect(await blocked.b.vpnConnect(UUID, true)).toEqual({ available: false, reason: 'blocked_by_policy' })
  })
  it('lists OpenVPN kind, asks for credentials, passes them on stdin only, removes certs with the profile', async () => {
    const t = bridge(null, { needsCreds: true })
    const v = await t.b.vpn()
    expect(v.available && v.value.connections[0]).toMatchObject({ kind: 'openvpn', needs_credentials: true })
    expect(await t.b.vpnConnect(UUID, true)).toEqual({ available: false, reason: 'credentials_required' })
    expect(await t.b.vpnConnect(UUID, true, { username: 'bob', password: 's3cret pw' })).toEqual({ available: true, value: true })
    expect(t.stdin).toEqual([
      { args: ['connection', 'edit', 'uuid', UUID], input: 'set vpn.user-name bob\nsave persistent\nquit\n' },
      { args: ['--ask', '--wait', '30', 'connection', 'up', 'uuid', UUID], input: 's3cret pw\n' },
    ])
    expect(t.calls.flat().join(' ')).not.toMatch(/s3cret|bob/)
    expect(await t.b.vpnConnect(UUID, true, { username: 'bob\nsave', password: 'x' })).toEqual({ available: false, reason: 'invalid_argument' })
    expect(await t.b.vpnRemove(UUID)).toEqual({ available: true, value: true })
    expect(t.removed).toEqual(['Office'])
  })
})

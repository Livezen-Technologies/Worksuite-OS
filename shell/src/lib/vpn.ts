// VPN texts and the taskbar indicator (WSOS-INT-001). Data comes from os.sysVpn(); layout is in Settings and Desktop.
import type { VpnConnection, VpnState } from './os'
import { t } from '../i18n'

export function vpnErrorText(error: string): string {
  switch (error) {
    case 'blocked_by_policy': return t('vpn.blocked')
    case 'scripts_not_supported': return t('vpn.err.scripts2')
    case 'credentials_in_file': return t('vpn.err.credsInFile')
    case 'unsupported_directive': return t('vpn.err.directive')
    case 'invalid_remote': return t('vpn.err.remote')
    case 'unsafe_path': return t('vpn.err.unsafePath')
    case 'missing_certificate': return t('vpn.err.cert')
    case 'openvpn_unavailable': return t('vpn.err.noOpenvpn')
    case 'credentials_required': return t('vpn.err.credsRequired')
    case 'bad_credentials': return t('vpn.err.badCreds')
    case 'connect_failed': return t('vpn.err.connect')
    case 'missing_private_key': return t('vpn.err.key')
    case 'invalid_peer': return t('vpn.err.peer')
    case 'invalid_address': return t('vpn.err.address')
    case 'already_exists': return t('vpn.err.exists')
    case 'managed_by_organization': return t('vpn.err.managed')
    case 'required_by_organization': return t('vpn.err.required')
    case 'cancelled': return ''
    case 'invalid_file': return t('vpn.err.file2')
    default: return t('vpn.err.default')
  }
}

/** Taskbar: the active VPN (managed first), or null when none is connected. */
export function activeVpn(s: VpnState | null | undefined): VpnConnection | null {
  return s?.connections.find((c) => c.active) ?? null
}

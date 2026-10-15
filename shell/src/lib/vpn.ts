// VPN texts and the taskbar indicator (WSOS-INT-001). Data comes from os.sysVpn(); layout is in Settings and Desktop.
import type { VpnConnection, VpnState } from './os'
import { t } from '../i18n'

export function vpnErrorText(error: string): string {
  switch (error) {
    case 'blocked_by_policy': return t('vpn.blocked')
    case 'scripts_not_supported': return t('vpn.err.scripts')
    case 'missing_private_key': return t('vpn.err.key')
    case 'invalid_peer': return t('vpn.err.peer')
    case 'invalid_address': return t('vpn.err.address')
    case 'already_exists': return t('vpn.err.exists')
    case 'managed_by_organization': return t('vpn.err.managed')
    case 'required_by_organization': return t('vpn.err.required')
    case 'cancelled': return ''
    case 'invalid_file': return t('vpn.err.file')
    default: return t('vpn.err.default')
  }
}

/** Taskbar: the active VPN (managed first), or null when none is connected. */
export function activeVpn(s: VpnState | null | undefined): VpnConnection | null {
  return s?.connections.find((c) => c.active) ?? null
}

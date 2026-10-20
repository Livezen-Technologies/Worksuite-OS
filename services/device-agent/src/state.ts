// Root-owned persistent state in /var/lib/worksuite-device-agent (StateDirectory, 0700). Atomic JSON writes.
import { existsSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import type { ReplayStore } from './commands.ts';
import type { VpnConfig } from './vpn.ts';

export interface Policy {
  version: string;
  signature: string;
  update_ring?: 'development' | 'pilot' | 'stable';
  update_mode?: 'automatic' | 'notify' | 'manual';
  maintenance_window?: string;
  lock_timeout_max_s?: number;
  offline_access_days?: number;
  usb_storage?: 'allow' | 'read_only' | 'block';
  bluetooth?: boolean;
  /** WSOS-AUTH-004: pam_faillock deny (failed sign-ins before lockout) and unlock_time (0 = until an admin resets). */
  login_failures_max?: number;
  login_lockout_s?: number;
  /** Device PIN sign-in: false = off (verify and set refused by worksuite-signin); minimum PIN length 4–12. */
  allow_pin?: boolean;
  pin_min_length?: number;
  app_allowlist?: string[];
  approved_remotes?: string[];
  /** WSOS-WIPE-006 (P2): local WorkSuite data wipe after this many days without a policy check-in. */
  offline_wipe_days?: number;
  /** WSOS-INT-001: managed VPN must be connected (autoconnect, always-on) even if the VPN config does not say so. */
  vpn_required?: boolean;
  /** WSOS-INT-001: block = user-imported VPN profiles are removed and Settings offers no import. */
  user_vpn?: 'allow' | 'block';
  /** On-device AI assistant (services/ai): false = off for everyone; ai_models = the catalog ids allowed. */
  ai_assistant?: boolean;
  ai_models?: string[];
  /** Desktop widgets on the OS wallpaper: false = off for everyone (the shell also turns them off on a kiosk). */
  desktop_widgets?: boolean;
  /** WhatsApp (WhatsApp Web window, pinned by default): false = off on the device (Start, taskbar and the window). */
  whatsapp?: boolean;
  /** Screenshots and the snipping tool: disabled = off on the device (kiosks: always off). */
  screen_capture?: 'allowed' | 'disabled';
  /** Clipboard history (Super+V): disabled = off on the device and its list dropped (kiosks: always off). */
  clipboard_history?: 'allowed' | 'disabled';
  /** Drivers: online search after connecting (default on), firmware auto-install (default on), NVIDIA driver
   *  auto-install (default off). Read by the package service from the published policy.json; kiosks: search on,
   *  firmware only. */
  drivers_online_search?: boolean;
  drivers_auto_install?: boolean;
  drivers_auto_install_gpu?: boolean;
  /** Software Management: what users may install themselves, and whether they may uninstall or update apps. */
  software_install?: 'any' | 'approved' | 'request' | 'block';
  software_uninstall?: boolean;
  software_update?: boolean;
  /** Update Manager: download limit for OS and app updates in KiB/s (0 = none). */
  update_bandwidth_kbps?: number;
  [k: string]: unknown;
}

export interface AgentState {
  enrolled: boolean;
  device_id?: string;
  credential?: string;
  server_url?: string;
  org_name?: string;
  enrolled_at?: number;
  policy?: Policy;
  last_check_in?: number;
  /** Command ids already accepted, kept until expiry (WSOS-MDM-004 replay protection survives restarts). */
  seen_commands: Record<string, number>;
  /** Commands whose final ack has not been delivered yet. */
  pending_acks: { id: string; state: string; reason?: string }[];
  wiped?: boolean;
  /** Offline access period exceeded: local sign-in refused until the next successful check-in. */
  offline_access_expired?: boolean;
  /** Last verified managed-VPN config (signed by the server; no private key in it). */
  vpn?: VpnConfig;
  /** When the current WireGuard keypair was generated (rotation). The private key itself is in host storage. */
  vpn_key_created_at?: number;
  /** WSOS-SEC-008: how far the package-service audit log has been forwarded to the server. */
  package_audit?: { offset: number; head?: string };
  /** WorkSuite Security (src/securityCenter.ts): isolation, scan and threat history, firewall alerts. */
  security?: import('./security.ts').SecurityState;
}

export const emptyState = (): AgentState => ({ enrolled: false, seen_commands: {}, pending_acks: [] });

export class StateFile {
  state: AgentState;
  private path: string;
  constructor(path: string) {
    this.path = path;
    this.state = existsSync(path) ? { ...emptyState(), ...JSON.parse(readFileSync(path, 'utf8')) } : emptyState();
  }
  save() {
    writeFileSync(this.path + '.tmp', JSON.stringify(this.state, null, 2), { mode: 0o600 });
    renameSync(this.path + '.tmp', this.path);
  }
  update(fn: (s: AgentState) => void) { fn(this.state); this.save(); }

  replayStore(): ReplayStore {
    return {
      has: (id) => id in this.state.seen_commands,
      add: (id, exp) => this.update((s) => { s.seen_commands[id] = exp; }),
      prune: (now) => {
        const before = Object.keys(this.state.seen_commands).length;
        for (const [id, exp] of Object.entries(this.state.seen_commands)) if (exp < now) delete this.state.seen_commands[id];
        if (Object.keys(this.state.seen_commands).length !== before) this.save();
      },
    };
  }
}

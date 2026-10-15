// Root-owned persistent state in /var/lib/worksuite-device-agent (StateDirectory, 0700). Atomic JSON writes.
import { existsSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import type { ReplayStore } from './commands.ts';

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
  app_allowlist?: string[];
  approved_remotes?: string[];
  /** WSOS-WIPE-006 (P2): local WorkSuite data wipe after this many days without a policy check-in. */
  offline_wipe_days?: number;
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

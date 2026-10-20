// Policy schema: the one validator for every way a policy reaches the database — the admin console
// (PUT /admin/api/policy) and the CLI (worksuite-server policy-set). Unknown fields and bad values are refused.
import type { DatabaseSync } from 'node:sqlite';
import { setPolicy } from './admin.ts';
import { invalid } from './http.ts';
import { validRsPolicy } from './remoteSupport.ts';
import { normalizeKiosk, type KioskPolicy } from './kiosk.ts';

const APP_PERMISSION_RESOURCES = new Set(['camera', 'microphone', 'location', 'notifications', 'screenshot', 'background']);

const POLICY_FIELDS: Record<string, (v: unknown) => boolean> = {
  update_ring: (v) => v === 'development' || v === 'pilot' || v === 'stable',
  update_mode: (v) => v === 'automatic' || v === 'notify' || v === 'manual',
  maintenance_window: (v) => typeof v === 'string' && /^([01]\d|2[0-3]):[0-5]\d-([01]\d|2[0-3]):[0-5]\d$/.test(v),
  lock_timeout_max_s: (v) => Number.isInteger(v) && (v as number) >= 60 && (v as number) <= 86_400,
  offline_access_days: (v) => Number.isInteger(v) && (v as number) >= 0 && (v as number) <= 365,
  usb_storage: (v) => v === 'allow' || v === 'read_only' || v === 'block',
  bluetooth: (v) => typeof v === 'boolean',
  login_failures_max: (v) => Number.isInteger(v) && (v as number) >= 3 && (v as number) <= 20,
  login_lockout_s: (v) => Number.isInteger(v) && (v as number) >= 0 && (v as number) <= 86_400,
  // Device PIN sign-in (Settings > Users): false turns it off on the device; minimum digits 4–12.
  allow_pin: (v) => typeof v === 'boolean',
  pin_min_length: (v) => Number.isInteger(v) && (v as number) >= 4 && (v as number) <= 12,
  app_allowlist: (v) => Array.isArray(v) && v.length <= 1000 && v.every((x) => typeof x === 'string' && /^[A-Za-z0-9._:-]{1,200}$/.test(x)),
  approved_remotes: (v) => Array.isArray(v) && v.length <= 50 && v.every((x) => typeof x === 'string' && x.length <= 200),
  offline_wipe_days: (v) => Number.isInteger(v) && (v as number) >= 1 && (v as number) <= 365,
  // CoreApprovalEngine waiver (WSOS-WIPE-001): personal-owned devices may be wiped with one approval.
  wipe_personal_single_approval: (v) => typeof v === 'boolean',
  // WSOS-AUTH-002: the one account a kiosk device may sign in automatically (worksuite-autologin --kiosk).
  kiosk_autologin_user: (v) => typeof v === 'string' && /^[a-z_][a-z0-9_.@-]{0,63}$/.test(v) && v !== 'root' && v !== 'wsadmin',
  // AppImages (WSOS-AIM-002) and local .deb files (WSOS-APT-005).
  appimages: (v) => v === 'allow' || v === 'block',
  appimage_trusted_keys: (v) => Array.isArray(v) && v.length <= 50 && v.every((x) => typeof x === 'string' && /^[0-9A-Fa-f ]{40,80}$/.test(x)),
  allow_local_debs: (v) => typeof v === 'boolean',
  update_mirror: (v) => typeof v === 'string' && /^https:\/\/[^\s/]+(\/\S*)?$/.test(v),
  // Managed WireGuard VPN (WSOS-INT-001): connection must be up (always-on); user-imported VPNs allowed or removed.
  vpn_required: (v) => typeof v === 'boolean',
  user_vpn: (v) => v === 'allow' || v === 'block',
  // On-device AI assistant (services/ai): off for every user, and the catalog models users may download and run.
  ai_assistant: (v) => typeof v === 'boolean',
  // Desktop widgets (WorkSuite Desktop's Home on the OS wallpaper): false turns them off for every user. Kiosk: always off.
  desktop_widgets: (v) => typeof v === 'boolean',
  // WhatsApp (WhatsApp Web in its own window, pinned by default): false removes it from Start and the taskbar and the
  // window shows that the organization turned it off. Kiosk: never shown (the kiosk runs its own app list).
  whatsapp: (v) => typeof v === 'boolean',
  // Screenshots and the snipping tool (Print Screen, Super+Shift+S): disabled turns them off for every user. Kiosk: always off.
  screen_capture: (v) => v === 'allowed' || v === 'disabled',
  // Clipboard history (Super+V): disabled turns it off and drops what was kept. Kiosk: always off.
  clipboard_history: (v) => v === 'allowed' || v === 'disabled',
  // Drivers (Settings › Drivers): online search after the computer connects; firmware from the Debian archive installs
  // itself unless auto_install is false; the NVIDIA driver (DKMS) only with auto_install_gpu. Kiosk: search on, firmware only.
  drivers_online_search: (v) => typeof v === 'boolean',
  drivers_auto_install: (v) => typeof v === 'boolean',
  drivers_auto_install_gpu: (v) => typeof v === 'boolean',
  // Remote support (issue #19): {enabled, unattended, max_session_minutes 5–240}. unattended applies to corporate-owned
  // devices only and is shown to their users in Settings; without it every session needs the user's consent.
  remote_support: validRsPolicy,
  // App permissions (issue #21): {deny: {camera|microphone|location|notifications|screenshot|background: [app id | "*"]}}.
  // Policy can only take access away (the shell writes "no" into each user's permission store); it never grants, and
  // it never answers a consent prompt on the user's behalf.
  app_permissions: (v) => {
    if (!v || typeof v !== 'object' || Array.isArray(v)) return false;
    const { deny, ...rest } = v as Record<string, unknown>;
    if (Object.keys(rest).length || !deny || typeof deny !== 'object' || Array.isArray(deny)) return false;
    return Object.entries(deny).every(([r, apps]) => APP_PERMISSION_RESOURCES.has(r) && Array.isArray(apps) && apps.length <= 500
      && apps.every((a) => typeof a === 'string' && (a === '*' || /^[A-Za-z][A-Za-z0-9_-]*(\.[A-Za-z0-9_-]+){2,}$/.test(a))));
  },
  ai_models: (v) => Array.isArray(v) && v.length <= 100 && v.every((x) => typeof x === 'string' && /^[a-z0-9][a-z0-9._-]{1,63}$/.test(x)),
};

export function validatePolicy(body: unknown, current?: Record<string, unknown> | null): Record<string, unknown> {
  if (!body || typeof body !== 'object' || Array.isArray(body)) throw invalid('policy', 'must be an object');
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(body)) {
    if (v === null || v === '' || k === 'version' || k === 'signature') continue;   // cleared fields are omitted
    // Kiosk mode: nested, and its exit PIN becomes a verifier (src/kiosk.ts).
    if (k === 'kiosk') { out[k] = normalizeKiosk(v, current?.kiosk as KioskPolicy | undefined); continue; }
    const check = POLICY_FIELDS[k];
    if (!check) throw invalid(k, 'unknown policy field');
    if (!check(v)) throw invalid(k, 'invalid value');
    out[k] = v;
  }
  return out;
}

/** Validate `body` against the organization's current policy (kiosk exit PIN → verifier) and store it. */
export function setValidatedPolicy(db: DatabaseSync, orgId: number, body: unknown): number {
  const cur = db.prepare('SELECT body FROM policies WHERE org_id = ?').get(orgId) as { body: string } | undefined;
  return setPolicy(db, orgId, validatePolicy(body, cur ? JSON.parse(cur.body) : null));
}

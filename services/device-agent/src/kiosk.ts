// Kiosk mode (WSOS-AUTH-002, SRS §2.3): signed policy `kiosk` → the files the kiosk session reads. Pure, so the
// session config is testable without root. A device is a kiosk only when the policy is enabled AND lists its id.
//   /etc/worksuite/kiosk.json                 app, allowed URLs, idle reset, OSK (0644; read by the kiosk app, kiosk.cjs)
//   /etc/worksuite/kiosk/session.env          validated scalars for the shell scripts (worksuite-session, PAM check)
//   /etc/worksuite/kiosk/labwc/rc.xml         locked compositor config: no shortcuts except the exit gesture
//   /etc/worksuite/kiosk/labwc/environment    XKB without VT switching, Wayland for Electron
//   /etc/worksuite/kiosk-exit.verifier        exit PIN verifier (0600 root; worksuite-kiosk-exit --pin)
// The account, greetd autologin, Ctrl+Alt+Del and logind VTs are set by worksuite-kiosk-apply (root, outside the
// agent's sandbox). USB storage is forced to `block` on a kiosk (enforce.ts).
import type { Policy } from './state.ts';

export const KIOSK_PATHS = {
  config: '/etc/worksuite/kiosk.json',
  sessionEnv: '/etc/worksuite/kiosk/session.env',
  labwcRc: '/etc/worksuite/kiosk/labwc/rc.xml',
  labwcEnv: '/etc/worksuite/kiosk/labwc/environment',
  exitVerifier: '/etc/worksuite/kiosk-exit.verifier',
} as const;

export const KIOSK_MODULES = ['home', 'mail', 'chat', 'calendar', 'tasks', 'files', 'crm', 'hr'] as const;
export type KioskApp = { type: 'url'; url: string } | { type: 'module'; id: string } | { type: 'desktop'; id: string };
export interface KioskConfig {
  user: string;
  app: KioskApp;
  allowed_urls: string[];
  idle_reset_minutes: number;
  show_on_screen_keyboard: boolean;
  exit_pin: boolean;
  orientation: KioskOrientation;
  screen_off: { from: string; until: string } | null;
}
export type KioskOrientation = 'landscape' | 'portrait' | 'landscape-flipped' | 'portrait-flipped';
/** wlr-randr --transform for each orientation (a landscape panel turned clockwise for portrait). */
export const KIOSK_TRANSFORM: Record<KioskOrientation, number> = { landscape: 0, portrait: 90, 'landscape-flipped': 180, 'portrait-flipped': 270 };
const HHMM = /^([01]\d|2[0-3]):[0-5]\d$/;

const USER = /^[a-z_][a-z0-9_.@-]{0,63}$/;
const DESKTOP_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,150}\.desktop$/;
const URL_PATTERN = /^https:\/\/(\*\.)?[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+(:\d{1,5})?(\/[A-Za-z0-9._~!$&'()*+,;=:@%/-]*)?$/;
const VERIFIER = /^scrypt\$(16384|32768|65536)\$8\$1\$[A-Za-z0-9+/]{22,24}={0,2}\$[A-Za-z0-9+/]{43}=$/;

function app(v: unknown): KioskApp | null {
  const a = v as Record<string, unknown> | null;
  if (!a || typeof a !== 'object') return null;
  if (a.type === 'url' && typeof a.url === 'string') {
    try { const u = new URL(a.url); return u.protocol === 'https:' && !u.username && !u.password ? { type: 'url', url: u.toString() } : null; } catch { return null; }
  }
  if (a.type === 'module' && (KIOSK_MODULES as readonly unknown[]).includes(a.id)) return { type: 'module', id: a.id as string };
  if (a.type === 'desktop' && typeof a.id === 'string' && DESKTOP_ID.test(a.id)) return { type: 'desktop', id: a.id };
  return null;
}

/**
 * This device's kiosk configuration, or null. The policy is signed, but every value is checked again here because it
 * ends up in root-owned files read by shell scripts and PAM: anything unexpected turns kiosk mode off.
 */
export function activeKiosk(p: Policy | null | undefined, deviceId: string | undefined): (KioskConfig & { verifier: string | null }) | null {
  const k = p?.kiosk as Record<string, unknown> | undefined;
  if (!k || k.enabled !== true || !deviceId || !Array.isArray(k.devices) || !k.devices.includes(deviceId)) return null;
  const user = typeof k.user === 'string' && USER.test(k.user) && k.user !== 'root' && k.user !== 'wsadmin' ? k.user : null;
  const a = app(k.app);
  if (!user || !a) return null;
  const idle = Number.isInteger(k.idle_reset_minutes) && (k.idle_reset_minutes as number) >= 0 && (k.idle_reset_minutes as number) <= 1440 ? k.idle_reset_minutes as number : 0;
  const verifier = k.allow_exit_pin === true && typeof k.exit_pin_verifier === 'string' && VERIFIER.test(k.exit_pin_verifier) ? k.exit_pin_verifier : null;
  return {
    user, app: a,
    allowed_urls: Array.isArray(k.allowed_urls) ? (k.allowed_urls as unknown[]).filter((u): u is string => typeof u === 'string' && u.length <= 300 && URL_PATTERN.test(u)).slice(0, 100) : [],
    idle_reset_minutes: idle,
    show_on_screen_keyboard: k.show_on_screen_keyboard === true,
    exit_pin: verifier !== null,
    orientation: typeof k.orientation === 'string' && Object.hasOwn(KIOSK_TRANSFORM, k.orientation) ? k.orientation as KioskOrientation : 'landscape',
    screen_off: screenOff(k.screen_off),
    verifier,
  };
}

function screenOff(v: unknown): { from: string; until: string } | null {
  const so = v as Record<string, unknown> | null;
  if (!so || typeof so !== 'object' || typeof so.from !== 'string' || typeof so.until !== 'string') return null;
  return HHMM.test(so.from) && HHMM.test(so.until) && so.from !== so.until ? { from: so.from, until: so.until } : null;
}

const HEADER = '# Written by worksuite-device-agent from the signed device policy (kiosk mode). Local changes are replaced.\n';

/** Locked Labwc config: one keybinding (the admin exit gesture), click-to-focus only, every window maximised. */
export const KIOSK_RC_XML = `<?xml version="1.0" encoding="UTF-8"?>
<!-- Written by worksuite-device-agent (kiosk mode). Defining <keyboard> and <mouse> replaces Labwc's defaults, so no
     window switching, closing, root menu or workspace shortcut exists; the logo key does nothing. -->
<labwc_config>
  <core><decoration>client</decoration><gap>0</gap></core>
  <desktops number="1"/>
  <keyboard>
    <keybind key="C-A-S-k"><action name="Execute" command="/usr/lib/worksuite/worksuite-kiosk-ctl exit-prompt"/></keybind>
  </keyboard>
  <mouse>
    <context name="Client"><mousebind button="Left" action="Press"><action name="Focus"/></mousebind></context>
  </mouse>
  <windowRules>
    <windowRule identifier="*" serverDecoration="no" skipTaskbar="yes" skipWindowSwitcher="yes"><action name="Maximize"/></windowRule>
  </windowRules>
</labwc_config>
`;

/**
 * srvrkeys:none removes the XF86Switch_VT_* keysyms, so Ctrl+Alt+F1…F12 cannot leave the session (the compositor owns
 * the VT; logind gets NAutoVTs=0 from worksuite-kiosk-apply). Ctrl+Alt+Backspace (terminate) is not set either.
 */
export const KIOSK_LABWC_ENV = 'XDG_CURRENT_DESKTOP=WorkSuite-Kiosk:wlroots\nXDG_SESSION_DESKTOP=WorkSuite-Kiosk\n' +
  'ELECTRON_OZONE_PLATFORM_HINT=wayland\nMOZ_ENABLE_WAYLAND=1\nQT_QPA_PLATFORM=wayland\nXKB_DEFAULT_OPTIONS=srvrkeys:none\n';

/** Absolute path → content (null removes it). `secret` paths are written 0600. */
export function kioskFiles(k: ReturnType<typeof activeKiosk>): { files: Record<string, string | null>; secret: Record<string, string | null> } {
  if (!k) {
    return {
      files: { [KIOSK_PATHS.config]: null, [KIOSK_PATHS.sessionEnv]: null, [KIOSK_PATHS.labwcRc]: null, [KIOSK_PATHS.labwcEnv]: null },
      secret: { [KIOSK_PATHS.exitVerifier]: null },
    };
  }
  const { verifier, ...pub } = k;
  return {
    files: {
      [KIOSK_PATHS.config]: JSON.stringify(pub, null, 2) + '\n',
      [KIOSK_PATHS.sessionEnv]: HEADER + `KIOSK_USER=${k.user}\nKIOSK_IDLE_RESET_S=${k.idle_reset_minutes * 60}\nKIOSK_OSK=${k.show_on_screen_keyboard ? 1 : 0}\nKIOSK_EXIT_PIN=${k.exit_pin ? 1 : 0}\n` +
        `KIOSK_TRANSFORM=${KIOSK_TRANSFORM[k.orientation]}\n` + (k.screen_off ? `KIOSK_SCREEN_OFF_FROM=${k.screen_off.from.replace(':', '')}\nKIOSK_SCREEN_OFF_UNTIL=${k.screen_off.until.replace(':', '')}\n` : ''),
      [KIOSK_PATHS.labwcRc]: KIOSK_RC_XML,
      [KIOSK_PATHS.labwcEnv]: KIOSK_LABWC_ENV,
    },
    secret: { [KIOSK_PATHS.exitVerifier]: verifier ? verifier + '\n' : null },
  };
}

/** The policy as published world-readable (/run/worksuite-device-agent/policy.json): no exit PIN verifier. */
export function publicPolicy(p: Policy): Policy {
  const k = p.kiosk as Record<string, unknown> | undefined;
  if (!k || typeof k !== 'object' || !('exit_pin_verifier' in k)) return p;
  const { exit_pin_verifier: _v, ...rest } = k;
  return { ...p, kiosk: { ...rest, exit_pin_set: true } };
}

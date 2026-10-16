// Signed policy → machine settings (WSOS-MDM-002). Pure: computes the files and switches the host applies, so the
// mapping is testable without root. Consumers of the files:
//   /etc/worksuite/lock-policy.conf      worksuite-idle (swayidle) caps the user's idle-lock timeout (WSOS-LOCK-003)
//   /etc/worksuite/faillock.conf         pam_faillock conf= (worksuite-session PAM profiles, WSOS-AUTH-004)
//   /etc/worksuite/signin-policy.conf    worksuite-signin: device PIN allowed, minimum length (Settings > Users)
//   /etc/modprobe.d, /etc/udev/rules.d   USB mass storage blocked or read-only (WSOS-INT-004)
//   /etc/worksuite/offline-access-expired  pam_nologin file= refuses sign-in after the offline period (WSOS-AUTH-003, DIR-005)
// Bluetooth is a switch (rfkill + bluetooth.service), not a file (WSOS-INT-003).
import type { Policy } from './state.ts';
import { activeKiosk, kioskFiles, KIOSK_PATHS } from './kiosk.ts';

export const ENFORCED_PATHS = {
  lockPolicy: '/etc/worksuite/lock-policy.conf',
  faillock: '/etc/worksuite/faillock.conf',
  signinPolicy: '/etc/worksuite/signin-policy.conf',
  usbModprobe: '/etc/modprobe.d/worksuite-usb-storage.conf',
  usbUdev: '/etc/udev/rules.d/71-worksuite-usb-storage.rules',
  offlineExpired: '/etc/worksuite/offline-access-expired',
  ...KIOSK_PATHS,
} as const;

export interface Enforcement {
  /** Absolute path → content; null removes the file. */
  files: Record<string, string | null>;
  usb_storage: 'allow' | 'read_only' | 'block';
  bluetooth: 'allow' | 'block';
  /** Like files, written 0600 (kiosk exit PIN verifier). */
  secret_files?: Record<string, string | null>;
  /** Kiosk account for this device (worksuite-kiosk-apply enable), or null (kiosk off). */
  kiosk_user?: string | null;
}

const HEADER = '# Written by worksuite-device-agent from the signed device policy. Local changes are replaced.\n';

/** Same defaults as packaging (services/session/pam/faillock.conf). */
export function faillockConf(deny = 5, unlockTime = 600): string {
  return HEADER + `dir = /var/run/faillock\naudit\nsilent\ndeny = ${deny}\nfail_interval = 900\nunlock_time = ${unlockTime}\n`;
}

const UDEV_READ_ONLY = HEADER +
  '# usb_storage=read_only: USB disks and partitions are set read-only before anything can mount them.\n' +
  'ACTION=="add|change", SUBSYSTEM=="block", ENV{ID_BUS}=="usb", ENV{DEVTYPE}=="disk|partition", RUN+="/usr/sbin/blockdev --setro $devnode"\n';
const UDEV_BLOCK = HEADER +
  '# usb_storage=block: USB disks are hidden from UDisks2 even if a storage driver is already loaded.\n' +
  'SUBSYSTEM=="block", ENV{ID_BUS}=="usb", ENV{UDISKS_IGNORE}="1"\n';
const MODPROBE_BLOCK = HEADER +
  '# usb_storage=block: USB mass-storage drivers cannot load. Keyboards, mice and other USB classes are unaffected.\n' +
  'install usb_storage /bin/false\ninstall uas /bin/false\nblacklist usb_storage\nblacklist uas\n';

/** Device PIN rules for worksuite-signin (services/session/signin/worksuite_signin/core.py policy()). */
export function signinPolicyConf(allowPin = true, minLength = 6): string {
  return HEADER + `ALLOW_PIN=${allowPin ? 1 : 0}\nPIN_MIN_LENGTH=${minLength}\n`;
}

/** null policy = not managed: every WorkSuite restriction removed, packaged defaults back. */
export function policyEnforcement(p: Policy | null | undefined, deviceId?: string): Enforcement {
  const kiosk = activeKiosk(p, deviceId);
  const kf = kioskFiles(kiosk);
  // A kiosk never mounts USB storage, whatever the rest of the policy says.
  const usb = kiosk ? 'block' : p?.usb_storage ?? 'allow';
  const lock = p && Number.isInteger(p.lock_timeout_max_s) && (p.lock_timeout_max_s as number) > 0 ? p.lock_timeout_max_s as number : null;
  const deny = p && Number.isInteger(p.login_failures_max) ? p.login_failures_max as number : 5;
  const unlock = p && Number.isInteger(p.login_lockout_s) ? p.login_lockout_s as number : 600;
  const pinMin = p && Number.isInteger(p.pin_min_length) && (p.pin_min_length as number) >= 4 && (p.pin_min_length as number) <= 12 ? p.pin_min_length as number : 6;
  return {
    files: {
      [ENFORCED_PATHS.lockPolicy]: lock ? HEADER + `LOCK_TIMEOUT_MAX_S=${lock}\n` : null,
      [ENFORCED_PATHS.faillock]: faillockConf(deny, unlock),
      // Unmanaged: no file, worksuite-signin's defaults (PIN allowed, 6 digits) apply.
      [ENFORCED_PATHS.signinPolicy]: p ? signinPolicyConf(p.allow_pin !== false, pinMin) : null,
      [ENFORCED_PATHS.usbModprobe]: usb === 'block' ? MODPROBE_BLOCK : null,
      [ENFORCED_PATHS.usbUdev]: usb === 'block' ? UDEV_BLOCK : usb === 'read_only' ? UDEV_READ_ONLY : null,
      ...kf.files,
    },
    secret_files: kf.secret,
    kiosk_user: kiosk?.user ?? null,
    usb_storage: usb,
    bluetooth: p?.bluetooth === false ? 'block' : 'allow',
  };
}

const DAY = 86_400_000;

/** WSOS-AUTH-003 / WSOS-DIR-005: local sign-in stops once the device has not reached the server for the offline period. */
export function offlineAccessExpired(p: Policy | null | undefined, lastCheckIn: number | undefined, now: number): boolean {
  const days = p?.offline_access_days;
  if (!days || !Number.isInteger(days) || days <= 0 || !lastCheckIn) return false;
  return now - lastCheckIn >= days * DAY;
}

export function offlineNotice(orgName: string | null | undefined, days: number): string {
  return `This device has not reached ${orgName || 'your organization'} for ${days} days, the most your organization allows.\n` +
    'Connect it to the network. Sign-in is allowed again as soon as the device checks in.\n';
}

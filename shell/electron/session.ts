// Session plumbing for the Electron main process: app launching into their own systemd scopes, logout through
// worksuite-session, and the user's idle-lock timeout within the policy maximum. Fixed argument arrays only.
import { randomBytes } from 'node:crypto'
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import path from 'node:path'

export const APP_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,199}$/   // never starts with '-': not an option

/**
 * WSOS-SES-004 / WSOS-REL-004: every app runs in its own transient app-*.scope under app.slice, outside
 * worksuite-shell.service's cgroup, so a shell crash or restart never takes app windows with it.
 * `systemd-run --scope` puts gtk-launch (and the app it starts) into the new scope before exec.
 */
export function appLaunchCommand(id: string, rand: string = randomBytes(4).toString('hex')): [string, string[]] | null {
  if (!APP_ID.test(id)) return null
  return ['systemd-run', ['--user', '--scope', '--collect', '--quiet', '--slice=app.slice',
    `--unit=app-worksuite-${id.replace(/\.desktop$/, '')}-${rand}.scope`, `--description=${id}`, '--', 'gtk-launch', id]]
}

/**
 * WSOS-SES-003: Log out runs the full worksuite-session cleanup (stop sync, drop tokens, lock the keyring, stop the
 * session target, clear display variables, end Labwc). It runs as its own transient unit: the cleanup stops
 * worksuite-shell.service, and a child of the shell would be killed with it halfway through.
 */
export function logoutCommand(): [string, string[]] {
  return ['systemd-run', ['--user', '--collect', '--quiet', '--unit=worksuite-logout', '--', '/usr/bin/worksuite-session', '--logout']]
}

// ---- idle lock timeout (WSOS-LOCK-003) ----

/** Choices offered in Settings > Power, in seconds; 0 = never. */
export const LOCK_CHOICES = [60, 120, 300, 600, 900, 1800, 3600, 0] as const
export const DEFAULT_LOCK_S = 300

export interface LockPaths { user: string; policy: string }
export const lockPaths = (home: string, configHome = process.env.XDG_CONFIG_HOME || path.join(home, '.config')): LockPaths => ({
  user: path.join(configHome, 'worksuite', 'lock.conf'),
  policy: '/etc/worksuite/lock-policy.conf',
})

function readNum(file: string, key: string): number | null {
  let text = ''
  try { text = readFileSync(file, 'utf8') } catch { return null }
  let v: number | null = null
  for (const line of text.split('\n')) {
    const m = new RegExp(`^${key}=(\\d+)\\s*$`).exec(line)
    if (m) v = Number(m[1])
  }
  return v
}

/** Same rule as /usr/lib/worksuite/worksuite-idle: the user's choice, capped by the policy maximum; no "never" under a maximum. */
export function effectiveLockTimeout(user: number | null, max: number | null): number {
  const want = user ?? DEFAULT_LOCK_S
  if (max && max > 0 && (want === 0 || want > max)) return max
  return want
}

export interface LockSettings { timeout_s: number; max_s: number | null; choices: number[] }

export function readLockSettings(p: LockPaths): LockSettings {
  const max = readNum(p.policy, 'LOCK_TIMEOUT_MAX_S')
  const m = max && max > 0 ? max : null
  return {
    timeout_s: effectiveLockTimeout(readNum(p.user, 'LOCK_TIMEOUT_S'), m),
    max_s: m,
    // Under a maximum: every choice up to it, plus the maximum itself when it is not one of the presets.
    choices: m === null ? [...LOCK_CHOICES] : [...LOCK_CHOICES.filter((c) => c !== 0 && c <= m), ...(LOCK_CHOICES.includes(m as never) ? [] : [m])],
  }
}

/** Saves the user's choice; worksuite-idle-policy.path restarts swayidle with it. */
export function writeLockTimeout(p: LockPaths, seconds: number): { ok: true; value: LockSettings } | { ok: false; error: string } {
  const s = readLockSettings(p)
  if (!Number.isInteger(seconds) || !s.choices.includes(seconds)) return { ok: false, error: s.max_s !== null ? 'above_policy_maximum' : 'invalid_argument' }
  mkdirSync(path.dirname(p.user), { recursive: true })
  writeFileSync(p.user + '.tmp', `LOCK_TIMEOUT_S=${seconds}\n`, { mode: 0o644 })
  renameSync(p.user + '.tmp', p.user)
  return { ok: true, value: readLockSettings(p) }
}

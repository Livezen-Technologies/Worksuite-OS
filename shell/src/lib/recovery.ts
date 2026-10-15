// Recovery screens (docs/design/boot-install R1–R6): pure helpers for the recovery key, startup repair and
// snapshots, plus the screen state machine. Nothing here touches the key beyond formatting it in memory.
import { localeTag, t } from '../i18n'

// --- Recovery key (installer/modules/worksuiterecovery: 8 groups of 5 characters from this alphabet) -----------
export const KEY_ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ'
export const KEY_GROUPS = 8
export const KEY_GROUP_LEN = 5
export const KEY_LENGTH = KEY_GROUPS * KEY_GROUP_LEN

/** Uppercase, read look-alikes the way the alphabet intends (O→0, I/L→1) and drop anything else (dashes, spaces). */
export function normalizeKeyChars(s: string): string {
  let out = ''
  for (const ch of s.toUpperCase()) {
    const c = ch === 'O' ? '0' : ch === 'I' || ch === 'L' ? '1' : ch
    if (KEY_ALPHABET.includes(c)) out += c
  }
  return out
}

export function emptyKey(): string[] { return Array.from({ length: KEY_GROUPS }, () => '') }

/**
 * Typing or pasting `text` into group `index`: characters fill that group and flow into the next ones, so a whole
 * key pasted into the first box lands in all eight. Returns the new groups and the group that should have focus.
 */
export function fillKeyGroups(groups: readonly string[], index: number, text: string): { groups: string[]; focus: number } {
  const next = [...groups]
  let chars = normalizeKeyChars(text)
  let i = index
  if (chars.length <= KEY_GROUP_LEN) {
    next[i] = chars
    return { groups: next, focus: chars.length === KEY_GROUP_LEN && i < KEY_GROUPS - 1 ? i + 1 : i }
  }
  while (chars && i < KEY_GROUPS) {
    next[i] = chars.slice(0, KEY_GROUP_LEN)
    chars = chars.slice(KEY_GROUP_LEN)
    i++
  }
  const last = Math.min(i, KEY_GROUPS) - 1
  return { groups: next, focus: next[last].length === KEY_GROUP_LEN && last < KEY_GROUPS - 1 ? last + 1 : last }
}

export function keyComplete(groups: readonly string[]): boolean {
  return groups.length === KEY_GROUPS && groups.every((g) => g.length === KEY_GROUP_LEN && normalizeKeyChars(g) === g)
}

/** The key as the installer printed it ("7K2QF-…"), which is exactly what the LUKS key slot holds. */
export function formatKey(groups: readonly string[]): string { return groups.join('-') }

/** Format check only; whether the key opens the disk is up to cryptsetup. */
export function keyProblem(groups: readonly string[]): string | null {
  const n = groups.reduce((a, g) => a + g.length, 0)
  if (n === 0) return t('rec.key.empty')
  if (!keyComplete(groups)) return t('rec.key.short', { length: KEY_LENGTH, n })
  return null
}

// --- Startup repair -----------------------------------------------------------------------------------------
export type CheckId = 'boot' | 'disk' | 'crypt' | 'packages' | 'drivers' | 'update'
export type CheckOutcome = 'ok' | 'fixed' | 'problem' | 'unavailable'
export type CheckState = 'wait' | 'active' | CheckOutcome
export interface CheckResult { status: CheckOutcome; note: string; /** Problem the package service can repair. */ fixable?: boolean }

export const CHECKS: { id: CheckId; label: string }[] = [
  { id: 'boot', get label() { return t('rec.check.boot') } },
  { id: 'disk', get label() { return t('rec.check.disk') } },
  { id: 'crypt', get label() { return t('rec.check.crypt') } },
  { id: 'packages', get label() { return t('rec.check.packages') } },
  { id: 'drivers', get label() { return t('settings.nav.Drivers') } },
  { id: 'update', get label() { return t('rec.check.update') } },
]

export interface CheckRow { id: CheckId; label: string; state: CheckState; note: string }

export function initialChecks(): CheckRow[] { return CHECKS.map((c) => ({ id: c.id, label: c.label, state: 'wait', note: '' })) }

/** Share of checks that have finished, 0–100. */
export function repairPercent(rows: readonly CheckRow[]): number {
  if (!rows.length) return 0
  const done = rows.filter((r) => r.state !== 'wait' && r.state !== 'active').length
  return Math.round((done / rows.length) * 100)
}

export function repairSummary(rows: readonly CheckRow[]): { fixed: number; problems: number; skipped: number; title: string; text: string } {
  const fixed = rows.filter((r) => r.state === 'fixed').length
  const problems = rows.filter((r) => r.state === 'problem').length
  const skipped = rows.filter((r) => r.state === 'unavailable' || r.state === 'wait').length
  const plural = (n: number) => (n === 1 ? t('rec.sum.one') : t('rec.sum.many', { count: n }))
  if (problems > 0) return { fixed, problems, skipped, title: t('rec.sum.remainTitle'),
    text: fixed ? t('rec.sum.partly', { fixed: plural(fixed), problems: plural(problems) }) : t('rec.sum.couldnt', { problems: plural(problems) }) }
  if (fixed > 0) return { fixed, problems, skipped, title: t('rec.sum.fixedTitle'), text: t('rec.sum.fixed', { fixed: plural(fixed) }) }
  return { fixed, problems, skipped, title: t('rec.sum.noneTitle'), text: t('rec.sum.none') }
}

// --- Snapshots ----------------------------------------------------------------------------------------------
export interface SnapshotInfo { id: string; title: string; created: number; kind: string; os_version: string; last_working: boolean }

const pad = (n: number) => String(n).padStart(2, '0')
const sameDay = (a: Date, b: Date) => a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate()

/** "Today, 02:03 · automatic" / "Sun 11 Oct, 03:00 · automatic". */
export function snapshotDesc(s: SnapshotInfo, now = new Date()): string {
  const d = new Date(s.created)
  const time = `${pad(d.getHours())}:${pad(d.getMinutes())}`
  const yesterday = new Date(now); yesterday.setDate(now.getDate() - 1)
  const day = sameDay(d, now) ? t('rec.snap.today') : sameDay(d, yesterday) ? t('rec.snap.yesterday')
    : `${d.toLocaleDateString(localeTag(), { weekday: 'short' })} ${d.getDate()} ${d.toLocaleDateString(localeTag(), { month: 'short' })}`
  return `${day}, ${time} · ${s.kind}`
}

/** "02:03 today" / "11 Oct" for the "Apps installed after …" note. */
export function snapshotWhen(s: SnapshotInfo, now = new Date()): string {
  const d = new Date(s.created)
  if (sameDay(d, now)) return t('rec.snap.timeToday', { time: `${pad(d.getHours())}:${pad(d.getMinutes())}` })
  return `${d.getDate()} ${d.toLocaleDateString(localeTag(), { month: 'short' })}`
}

/** Preselect the last snapshot that booted, else the newest. */
export function defaultSnapshot(list: readonly SnapshotInfo[]): string | null {
  return (list.find((s) => s.last_working) ?? [...list].sort((a, b) => b.created - a.created)[0])?.id ?? null
}

// --- Screens ------------------------------------------------------------------------------------------------
export type RecoveryScreen = 'menu' | 'unlock' | 'repair' | 'snapshots' | 'reset' | 'done'
export type DoneRowState = 'ok' | 'problem' | 'skipped'
export interface DoneInfo { title: string; text: string; ok: boolean; rows: { k: string; v: string; state: DoneRowState }[]; report?: string }
export interface RecoveryState { screen: RecoveryScreen; done: DoneInfo | null }
export type RecoveryAction = { type: 'open'; screen: Exclude<RecoveryScreen, 'done'> } | { type: 'back' } | { type: 'finish'; done: DoneInfo }

export const initialRecovery: RecoveryState = { screen: 'menu', done: null }

export function recoveryReducer(s: RecoveryState, a: RecoveryAction): RecoveryState {
  switch (a.type) {
    case 'open': return s.screen === 'menu' ? { screen: a.screen, done: null } : s
    case 'back': return { screen: 'menu', done: null }
    case 'finish': return s.screen === 'menu' ? s : { screen: 'done', done: a.done }
  }
}

/** Bridge error codes → text. */
export function recoveryErrorText(code: string): string {
  switch (code) {
    case 'unavailable': return t('rec.err.unavailable')
    case 'wrong_key': return t('rec.err.wrongKey')
    case 'not_authorized': return t('rec.err.notAuthorized')
    case 'not_found': return t('rec.err.notFound')
    case 'already_unlocked': return t('rec.err.alreadyUnlocked')
    case 'service_unavailable': return t('rec.err.service')
    case 'confirm_mismatch': return t('rec.err.confirm')
    case 'no_image': return t('rec.err.noImage')
    case 'no_system': return t('rec.err.noSystem')
    case 'running_system': return t('rec.err.runningSystem')
    default: return t('rec.err.default')
  }
}

export function formatGiB(bytes: number | null): string {
  return bytes == null ? '' : `${(bytes / 2 ** 30).toFixed(1)} GiB`
}

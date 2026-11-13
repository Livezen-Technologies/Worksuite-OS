// Validation of everything the UI sends over D-Bus. The UI is untrusted input to a root service: only known events
// with the right shape, only known answer keys, bounded sizes, and never a secret in the state file.
import { MAIN_FLOW, type MainState, type SetupEvent } from './machine/core/states.ts'
import { SetupError } from './errors.ts'

export const MAX_JSON = 64 * 1024

/** Events the UI may send. Work results (WORK_DONE/FAILED, TIMEOUT, ROLLBACK_DONE/FAILED, NETWORK_*) come only from
 *  the service itself: a UI that could send WORK_DONE could skip verification. */
export const UI_EVENTS = new Set(['NEXT', 'BACK', 'GOTO', 'PAUSE', 'RESUME', 'USER_DONE', 'RETRY_NOW', 'ENTER_RECOVERY', 'RESTORE_CHECKPOINT', 'ROLLBACK', 'RESTART_SETUP', 'CANCEL'])

/** Answer keys the UI may set, with a shape check each. Passwords and passphrases are never answers: they go
 *  straight to the job that needs them (Calamares, PAM) and are not stored in the setup state. */
const str = (max = 256) => (v: unknown) => typeof v === 'string' && v.length <= max
const obj = (v: unknown) => !!v && typeof v === 'object' && !Array.isArray(v)
const ids = (v: unknown) => Array.isArray(v) && v.length <= 200 && v.every((x) => typeof x === 'string' && /^[a-z0-9][a-z0-9._:-]{0,127}$/i.test(x))
export const ANSWER_SHAPES: Record<string, (v: unknown) => boolean> = {
  locale: str(64), timezone: str(64), keyboard: str(64),
  accountType: (v) => v === 'personal' || v === 'enterprise',
  account: (v) => obj(v) && typeof (v as { user?: unknown }).user === 'string' && !('password' in (v as object)),
  disk: (v) => typeof v === 'string' && /^[a-z0-9]{2,32}$/.test(v), diskConfirmed: str(32),
  encryption: (v) => obj(v) && typeof (v as { enabled?: unknown }).enabled === 'boolean' && !('passphrase' in (v as object)),
  privacy: obj,
  worksuiteApps: ids, thirdPartyApps: ids,
  aiMcp: obj,
  reviewAccepted: (v) => typeof v === 'boolean',
}

const SECRET_KEY = /pass(word|phrase)?|secret|token|private|pin$/i

function parse(raw: unknown, what: string): unknown {
  if (typeof raw !== 'string' || raw.length > MAX_JSON) throw new SetupError('InvalidArgs', `${what}: JSON string up to 64 KiB`)
  try { return JSON.parse(raw) } catch { throw new SetupError('InvalidArgs', `${what}: not JSON`) }
}

function noSecrets(v: unknown, at = 'value'): void {
  if (Array.isArray(v)) { v.forEach((x, i) => noSecrets(x, `${at}[${i}]`)); return }
  if (obj(v)) for (const [k, x] of Object.entries(v as object)) {
    if (SECRET_KEY.test(k)) throw new SetupError('InvalidArgs', `${at}.${k}: secrets are never stored in the setup state`)
    noSecrets(x, `${at}.${k}`)
  }
}

export function parseEvent(raw: unknown): SetupEvent {
  const e = parse(raw, 'event') as Record<string, unknown>
  if (!obj(e) || typeof e.type !== 'string' || !UI_EVENTS.has(e.type)) throw new SetupError('InvalidArgs', 'event: unknown or not allowed from the UI')
  switch (e.type) {
    case 'GOTO':
      if (!(MAIN_FLOW as readonly string[]).includes(String(e.to))) throw new SetupError('InvalidArgs', 'event.to: a setup step')
      return { type: 'GOTO', to: e.to as MainState }
    case 'ENTER_RECOVERY':
      return { type: 'ENTER_RECOVERY', reason: typeof e.reason === 'string' ? e.reason.slice(0, 200) : 'opened by the person' }
    case 'RESTORE_CHECKPOINT':
      if (typeof e.checkpointId !== 'string' || e.checkpointId.length > 128) throw new SetupError('InvalidArgs', 'event.checkpointId')
      return { type: 'RESTORE_CHECKPOINT', checkpointId: e.checkpointId }
    default:
      return { type: e.type } as SetupEvent
  }
}

export function parseAnswer(key: unknown, raw: unknown): { key: string; value: unknown } {
  if (typeof key !== 'string' || !(key in ANSWER_SHAPES)) throw new SetupError('InvalidArgs', 'answer: unknown key')
  const value = parse(raw, `answer ${key}`)
  noSecrets(value, key)
  if (!ANSWER_SHAPES[key](value)) throw new SetupError('InvalidArgs', `answer ${key}: wrong shape`)
  return { key, value }
}

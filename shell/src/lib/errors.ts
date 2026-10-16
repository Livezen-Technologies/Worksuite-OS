// One place that turns whatever went wrong (a service's error code, an exception, a tool's stderr) into a sentence
// for people, plus the technical text for administrators. Screens show `text`; `details` goes only into
// <ErrorDetails> (a disclosure for administrators, "Copy details" for everyone else) and never into a toast or label.
import { t, type MessageKey } from '../i18n'

/** Where it happened: picks the fallback sentence when nothing more specific is known. */
export type ErrorArea = 'package' | 'update' | 'files' | 'mount' | 'network' | 'app' | 'device' | 'generic'

/** What kind of problem it was, from codes and from technical text alike. */
export type ErrorKind = 'cancelled' | 'not_authorized' | 'no_space' | 'offline' | 'timeout' | 'not_found' | 'busy' | 'integrity'
  | 'unsupported' | 'service' | 'invalid' | 'dependencies' | 'crashed' | 'unknown'

export interface FriendlyError { kind: ErrorKind; text: string; details: string | null }

/** Error codes the shell's services return (snake_case), by kind. */
const CODES: Record<string, ErrorKind> = {
  cancelled: 'cancelled', auth_cancelled: 'cancelled',
  not_authorized: 'not_authorized', auth_required: 'not_authorized', permission_denied: 'not_authorized', access_denied: 'not_authorized', forbidden: 'not_authorized',
  no_space: 'no_space', disk_full: 'no_space',
  offline: 'offline', network: 'offline', network_error: 'offline', unreachable: 'offline',
  timeout: 'timeout', timed_out: 'timeout',
  not_found: 'not_found', missing: 'not_found',
  busy: 'busy', locked: 'busy', in_use: 'busy',
  integrity: 'integrity', bad_signature: 'integrity', checksum_mismatch: 'integrity',
  unsupported: 'unsupported', unsupported_filesystem: 'unsupported',
  service_unavailable: 'service', agent_unavailable: 'service', broker_unavailable: 'service', unavailable: 'service',
  invalid_argument: 'invalid', invalid: 'invalid',
  dependencies: 'dependencies', crashed: 'crashed', failed: 'unknown',
}

/** Technical text (errno names, tool messages) by kind. First match wins, so the specific ones come first. */
const PATTERNS: [RegExp, ErrorKind][] = [
  [/\b(ENOSPC|EDQUOT)\b|no space left|disk (is )?full|quota exceeded|not enough (free )?space/i, 'no_space'],
  [/\b(EACCES|EPERM)\b|permission denied|not authori[sz]ed|operation not permitted|authentication (is )?required|polkit|access denied/i, 'not_authorized'],
  [/\b(ENOTFOUND|EAI_AGAIN|ENETUNREACH|EHOSTUNREACH|ECONNREFUSED|ECONNRESET)\b|could not resolve|temporary failure (in )?(name )?resolution|network is unreachable|no route to host|connection refused|failed to fetch|offline/i, 'offline'],
  [/\b(ETIMEDOUT|ESOCKETTIMEDOUT)\b|timed? ?out/i, 'timeout'],
  [/hash sum mismatch|checksum|signature|NO_PUBKEY|GPG error|not signed|untrusted/i, 'integrity'],
  [/could not get lock|lock-frontend|dpkg was interrupted|\b(EBUSY)\b|device or resource busy|target is busy|already in use|is locked/i, 'busy'],
  [/unmet dependenc|depends:|broken packages|held broken|conflicts with/i, 'dependencies'],
  [/wrong fs type|bad superblock|unknown filesystem|not supported|unsupported/i, 'unsupported'],
  [/segmentation fault|core dumped|SIGSEGV|SIGABRT|aborted|crashed/i, 'crashed'],
  [/\b(ENOENT)\b|no such file|not found|unable to locate|does not exist/i, 'not_found'],
  [/service (is )?unavailable|not running|no reply|name has no owner|ServiceUnknown|could not connect to/i, 'service'],
]

const KIND_TEXT: Partial<Record<ErrorKind, MessageKey>> = {
  not_authorized: 'err.kind.notAuthorized', no_space: 'err.kind.noSpace', offline: 'err.kind.offline', timeout: 'err.kind.timeout',
  not_found: 'err.kind.notFound', busy: 'err.kind.busy', integrity: 'err.kind.integrity', unsupported: 'err.kind.unsupported',
  service: 'err.kind.service', invalid: 'err.kind.invalid', dependencies: 'err.kind.dependencies', crashed: 'err.kind.crashed',
}

const AREA_TEXT: Record<ErrorArea, MessageKey> = {
  package: 'err.area.package', update: 'err.area.update', files: 'err.area.files', mount: 'err.area.mount', network: 'err.area.network',
  app: 'err.area.app', device: 'err.area.device', generic: 'err.area.generic',
}

/** The raw thing as text: an Error's message, a result's error, or the value itself. */
export function rawText(raw: unknown): string {
  if (raw == null) return ''
  if (typeof raw === 'string') return raw
  if (raw instanceof Error) return raw.message || raw.name
  if (typeof raw === 'object') {
    const o = raw as { error?: unknown; message?: unknown; reason?: unknown }
    for (const v of [o.message, o.error, o.reason]) if (typeof v === 'string' && v) return v
    try { return JSON.stringify(raw) } catch { return String(raw) }
  }
  return String(raw)
}

/** A plain service code ("not_authorized") rather than a message. */
export const isCode = (s: string) => /^[a-z][a-z0-9_]{1,63}$/.test(s)

export function classifyError(raw: unknown): ErrorKind {
  const s = rawText(raw).trim()
  if (!s) return 'unknown'
  if (isCode(s)) return CODES[s] ?? 'unknown'
  for (const [re, kind] of PATTERNS) if (re.test(s)) return kind
  return 'unknown'
}

/** The sentence for people and, when the input was technical text, that text for administrators. */
export function friendlyError(raw: unknown, area: ErrorArea = 'generic'): FriendlyError {
  const s = rawText(raw).trim()
  const kind = classifyError(s)
  if (kind === 'cancelled') return { kind, text: '', details: null }
  const key = KIND_TEXT[kind] ?? AREA_TEXT[area]
  const text = kind === 'unknown' || !KIND_TEXT[kind] ? t(AREA_TEXT[area]) : `${t(AREA_TEXT[area])} ${t(key)}`
  return { kind, text, details: s && !(isCode(s) && kind !== 'unknown') ? s : null }
}

/** Just the sentence. */
export const errorMessage = (raw: unknown, area: ErrorArea = 'generic'): string => friendlyError(raw, area).text
